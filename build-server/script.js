const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const dotenv = require("dotenv");

const Redis = require("ioredis");

const publisher = new Redis("");

const s3Client = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

const PROJECT_ID = process.env.PROJECT_ID;

function publishLog(log) {
  publisher.publish(`logs: ${PROJECT_ID}`, JSON.stringify({ log }));
}

async function init() {
  console.log("Executing script.js");

  publishLog("Build started..");

  const outDirPath = path.join(__dirname, "output");

  const p = exec(`cd ${outDirPath} && npm install && npm run build`);

  p.stdout.on("data", function (data) {
    console.log("output : ", data.toString());
    publishLog(data.toString());
  });

  p.stdout.on("error", function (data) {
    console.log("Error", data.toString());
    publishLog(`Error: ${data.toString()}`);
  });

  p.on("close", async function () {
    console.log("Build Completed");
    publishLog("Build Completed");
    const distFolderPath = path.join(__dirname, "output", "dist");

    const distFolderContent = fs.readdirSync(distFolderPath, {
      recursive: true,
    });

    publishLog("Starting to upload");
    for (const file of distFolderContent) {
      const filePath = path.join(distFolderPath, file);

      if (fs.lstatSync(filePath).isDirectory()) continue;

      console.log("uploading", filePath);
      publishLog(`uploading ${file}`);

      const command = new PutObjectCommand({
        Bucket: "vercel-clone-output-test",
        Key: `__outputs/${PROJECT_ID}/${file}`,
        Body: fs.createReadStream(filePath),
        ContentType: mime.lookup(filePath),
      });

      await s3Client.send(command);
      publishLog(`uploaded ${file}`);
      console.log("uploaded..", filePath);
    }
    publishLog(`Done..`);
    console.log("Done...");
  });
}

init();
