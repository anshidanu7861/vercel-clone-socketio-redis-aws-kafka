const express = require("express");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Kafka } = require("kafkajs");

const { Server } = require("socket.io");
const { z } = require("zod");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@clickhouse/client");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = 9000;

const prisma = new PrismaClient({});

const io = new Server({ cors: "*" });

const kafka = new Kafka({
  clientId: `api-server`,
  brokers: [""],
  ssl: {
    ca: fs.readFileSync(path.join(__dirname, "kafka.pem"), "utf-8"),
  },
  sasl: {
    username: "avnadmin",
    password: "",
    mechanism: "plain",
  },
});

const client = createClient({
  host: "",
  database: "default",
  username: "avnadmin",
  password: "",
});

const consumer = kafka.consumer({ groupId: "api-server-logs-consumer" });

io.on("connection", (socket) => {
  socket.on("subscribe", (channel) => {
    socket.join(channel);
    socket.emit("message", `Joined ${channel}`);
  });
});

io.listen(9002, () => console.log("Socket Server 9001"));

const ecsClient = new ECSClient({
  region: "eu-north-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

const config = {
  CLUSTER: "",
  TASK: "",
};

app.post("/project", async (req, res) => {
  const schema = z.object({
    name: z.string(),
    gitURL: z.string(),
  });
  const safeParseResult = schema.safeParse(req.body);

  if (safeParseResult.error)
    return res.status(400).json({ error: safeParseResult.error });

  const { name, gitURL } = safeParseResult.data;

  const project = await prisma.project.create({
    data: {
      name,
      gitURL,
      subDomain: generateSlug(),
    },
  });

  return res.json({ status: "success", data: { project } });
});

app.post("/deploy", async (req, res) => {
  const { projectId } = req.body;

  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) return res.status(404).json({ error: "project not found!" });

  // CHECK IF THERE IS NO RUNNING DEPLOYEMT
  const deployment = await prisma.deployement.create({
    data: {
      project: { connect: { id: projectId } },
      status: "QUEUED",
    },
  });

  // Spin the container
  const command = new RunTaskCommand({
    cluster: config.CLUSTER,

    taskDefinition: config.TASK,

    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: "ENABLED",
        subnets: ["", "", ""],
        securityGroups: [""],
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "builder-images",
          environment: [
            { name: "GIT_REPOSITORY_URL", value: project.gitURL },
            { name: "PROJECT_ID", value: projectId },
            { name: "DEPLOYEMENT_ID", value: deployment.id },
          ],
        },
      ],
    },
  });

  await ecsClient.send(command);

  return res.json({
    status: "queued",
    data: { deploymentId: deployment.id },
  });
});

app.get("/logs", async (req, res) => {
  const id = req.params.id;
  res.json("good");
  // const logs = await client.query({
  //   query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id: String}`,
  //   query_params: {
  //     deployment_id: id,
  //   },
  //   format: "JSONEachRow",
  // });
  // console.log(logs, "show this");

  // return res.json({ logs });
});

async function initKafkaConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topics: ["container-logs"] });

  await consumer.run({
    autoCommit: false,
    eachBatch: async function ({
      batch,
      heartbeat,
      commitOffsetsIfNecessary,
      resolveOffset,
    }) {
      const messages = batch.messages;
      console.log(`Recived.${messages.length} messages..`);
      for (const message of messages) {
        const stringMessage = message.value.toString();
        const { PROJECT_ID, DEPLOYEMENT_ID, log } = JSON.parse(stringMessage);

        try {
          const { query_id } = await client.insert({
            table: "log_events",
            value: [{ event_id: uuidv4(), deployment_id: DEPLOYEMENT_ID, log }],
            format: "JSONEachRow",
          });
          resolveOffset(message.offset);
          await commitOffsetsIfNecessary(message.offset);
          await heartbeat();
        } catch (error) {
          console.log(error, "show error");
        }
      }
    },
  });
}

initKafkaConsumer();

app.listen(PORT, () => console.log(`API-SERVER Running...${PORT}`));
