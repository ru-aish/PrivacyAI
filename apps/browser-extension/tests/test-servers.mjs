import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockAiSanitize } from "./mock-ai-sanitizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let chatServer;
let apiServer;
let lastApiRequest = null;
let apiRequests = [];
let chatPort;
let apiPort;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
    server.on("error", reject);
  });
}

export async function startTestServers() {
  chatServer = http.createServer((req, res) => {
    const filePath = path.join(__dirname, req.url === "/" ? "mock-chat.html" : req.url);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath);
      const type = ext === ".html" ? "text/html" : "text/plain";
      res.writeHead(200, { "content-type": type });
      res.end(data);
    });
  });

  apiServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = {};
    }

    lastApiRequest = { url: req.url, body };
    apiRequests.push(lastApiRequest);

    const userMessages = body.messages?.filter((message) => message.role === "user") || [];
    const userMessage = userMessages.at(-1)?.content || "";
    const sanitized = mockAiSanitize(userMessage);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(sanitized)
          }
        }
      ]
    }));
  });

  chatPort = await listen(chatServer);
  apiPort = await listen(apiServer);

  return {
    chatUrl: `http://127.0.0.1:${chatPort}/mock-chat.html`,
    apiUrl: `http://127.0.0.1:${apiPort}/v1`,
    apiPort
  };
}

export function getLastApiRequest() {
  return lastApiRequest;
}

export function getApiRequests() {
  return [...apiRequests];
}

export function resetApiRequests() {
  lastApiRequest = null;
  apiRequests = [];
}

export async function stopTestServers() {
  const close = (server) => new Promise((resolve) => server?.close(resolve));
  await Promise.all([close(chatServer), close(apiServer)]);
}