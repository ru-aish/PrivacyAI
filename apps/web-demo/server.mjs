import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateAI, configFromEnv, loadEnvFile } from "@privacy-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOT_DIR = path.resolve(__dirname, "../..");
const HOST = process.env.WEB_DEMO_HOST || "127.0.0.1";
const REQUESTED_PORT = Number(process.env.WEB_DEMO_PORT || 3000);
const MAX_PORT_ATTEMPTS = 20;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function ensureEnvExists() {
  const env = loadEnvFile(".env", ROOT_DIR);
  if (Object.keys(env).length === 0) {
    console.error("");
    console.error("No .env file found.");
    console.error("Run setup first:");
    console.error("  npm run setup");
    console.error("");
    process.exit(1);
  }
}

ensureEnvExists();

const client = new PrivateAI({ cwd: ROOT_DIR, envFile: ".env" });
const config = configFromEnv({ cwd: ROOT_DIR, envFile: ".env" });

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function privacyItemsFromResult(result) {
  return result.detections.map((detection) => detection.replacement);
}

function providerLabel() {
  if (config.provider === "ollama") return "Ollama";
  if (config.baseURL.includes("generativelanguage.googleapis.com")) return "Gemini";
  if (config.baseURL.includes("api.openai.com")) return "OpenAI";
  if (config.baseURL.includes("1234")) return "LM Studio";
  return config.provider || "Custom";
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    return sendJson(res, 200, {
      status: "running",
      provider: config.provider,
      provider_label: providerLabel(),
      model: config.model,
      base_url: config.baseURL
    });
  }

  if (req.method === "POST" && url.pathname === "/api/sanitize") {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    if (!message) {
      return sendJson(res, 400, { status: "error", error: "Missing message." });
    }

    const result = await client.sanitize(message);
    return sendJson(res, 200, {
      status: "success",
      original_message: message,
      sanitized_message: result.sanitizedText,
      privacy_items_detected: privacyItemsFromResult(result)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/process") {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    const systemPrompt = String(body.system_prompt || "").trim();

    if (!message) {
      return sendJson(res, 400, { status: "error", error: "Missing message." });
    }

    const result = await client.ask(message, {
      system: systemPrompt || undefined,
      maxTokens: 512,
      temperature: 0.2
    });

    return sendJson(res, 200, {
      status: "success",
      sanitized_message: result.sanitizedText,
      ai_response: result.modelText,
      final_response: result.finalText,
      privacy_items_detected: privacyItemsFromResult(result),
      ai_service_used: providerLabel()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/test-connection") {
    const result = await client.ask("Reply with exactly: PrivacyAI connection OK.", {
      maxTokens: 32,
      temperature: 0,
      system: "Reply with exactly: PrivacyAI connection OK."
    });

    return sendJson(res, 200, {
      status: "success",
      service: providerLabel(),
      response: result.finalText
    });
  }

  return sendJson(res, 404, { status: "error", error: "Not found." });
}

function serveStatic(req, res, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { status: "error", error: "Forbidden." });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { status: "error", error: "Not found." });
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res, url);
      return;
    }

    sendJson(res, 405, { status: "error", error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, {
      status: "error",
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
});

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

async function listenWithFallback(startPort) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    try {
      return await listenOnPort(port);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error(
    `No free port found between ${startPort} and ${startPort + MAX_PORT_ATTEMPTS - 1}. ` +
      `Stop the other process or set WEB_DEMO_PORT.`
  );
}

async function main() {
  const port = await listenWithFallback(REQUESTED_PORT);
  const url = `http://${HOST}:${port}`;

  console.log(`PrivacyAI web demo running at ${url}`);
  if (port !== REQUESTED_PORT) {
    console.log(`Port ${REQUESTED_PORT} was busy, using ${port} instead.`);
  }
  console.log(`Provider: ${providerLabel()} (${config.model})`);
  console.log("Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : "Failed to start web demo.");
  console.error("");
  process.exit(1);
});