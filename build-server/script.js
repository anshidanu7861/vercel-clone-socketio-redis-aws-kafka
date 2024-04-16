const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const dotenv = require("dotenv");
const { Kafka } = require("kafkajs");

const s3Client = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYEMENT_ID = process.env.DEPLOYEMENT_ID;

const kafka = new Kafka({
  clientId: `docker-build-server-${DEPLOYEMENT_ID}`,
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

const producer = kafka.producer();

async function publishLog(log) {
  await producer.send({
    topic: `container-logs`,
    messages: [
      {
        key: "log",
        value: JSON.stringify({ PROJECT_ID, DEPLOYEMENT_ID, log }),
      },
    ],
  });
}

async function init() {
  await producer.connect();

  console.log("Executing script.js");

  await publishLog("Build started..");

  const outDirPath = path.join(__dirname, "output");

  const p = exec(`cd ${outDirPath} && npm install && npm run build`);

  p.stdout.on("data", async function (data) {
    console.log("output : ", data.toString());
    await publishLog(data.toString());
  });

  p.stdout.on("error", async function (data) {
    console.log("Error", data.toString());
    await publishLog(`Error: ${data.toString()}`);
  });

  p.on("close", async function () {
    console.log("Build Completed");
    await publishLog("Build Completed");
    const distFolderPath = path.join(__dirname, "output", "dist");

    const distFolderContent = fs.readdirSync(distFolderPath, {
      recursive: true,
    });

    await publishLog("Starting to upload");
    for (const file of distFolderContent) {
      const filePath = path.join(distFolderPath, file);

      if (fs.lstatSync(filePath).isDirectory()) continue;

      console.log("uploading", filePath);
      await publishLog(`uploading ${file}`);

      const command = new PutObjectCommand({
        Bucket: "vercel-clone-output-test",
        Key: `__outputs/${PROJECT_ID}/${file}`,
        Body: fs.createReadStream(filePath),
        ContentType: mime.lookup(filePath),
      });

      await s3Client.send(command);
      await publishLog(`uploaded ${file}`);
      console.log("uploaded..", filePath);
    }
    await publishLog(`Done..`);
    console.log("Done...");
    process.exit(0);
  });
}

init();
