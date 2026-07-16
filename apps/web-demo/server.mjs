import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPrivacySanitizer,
  derivePrivacyContextMaxChars,
  loadPrivacyConfig
} from "@privacy-ai/agent-bridge";
import { PrivateAI, sanitizeStructuredValue } from "@privacy-ai/sdk";
import { createImageSanitizer } from "@privacy-ai/sdk/image";

const THIS_FILE = fileURLToPath(import.meta.url);
const __dirname = path.dirname(THIS_FILE);
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = process.env.WEB_DEMO_HOST || "127.0.0.1";
const REQUESTED_PORT = Number(process.env.WEB_DEMO_PORT || 3000);
const MAX_PORT_ATTEMPTS = 20;
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

export async function createDefaultServices(options = {}) {
  const loaded = await loadPrivacyConfig({ path: options.configPath });
  if (!loaded.configured) {
    throw new Error(`PrivacyAI is not configured. Run: privacyai onboard\nExpected config: ${loaded.path}`);
  }
  if (loaded.config.provider !== "ollama") {
    throw new Error(
      "The PrivacyAI playground supports the Ollama privacy provider only. " +
      "Run privacyai onboard and select an Ollama model."
    );
  }

  const config = loaded.config;
  const strictSanitizer = createPrivacySanitizer(config, options.privacyOptions);
  const client = new PrivateAI({
    provider: config.provider,
    model: config.model,
    privacyModel: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    numCtx: config.numCtx,
    sanitizationMode: "strict",
    loadEnv: false
  });
  const imageSanitizer = createImageSanitizer(options.imageOptions);

  return {
    client,
    config,
    imageSanitizer,
    maxContextChars: derivePrivacyContextMaxChars(config),
    ownsImageSanitizer: true,
    strictSanitizer
  };
}

export async function createWebDemoServer(options = {}) {
  const services = options.services || await createDefaultServices(options);
  const publicDir = options.publicDir || PUBLIC_DIR;
  const maxBodyBytes = Number(options.maxBodyBytes || MAX_BODY_BYTES);
  let closed = false;

  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError("maxBodyBytes must be a positive safe integer.");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, services, maxBodyBytes);
        return;
      }
      if (req.method === "GET") {
        serveStatic(res, url, publicDir);
        return;
      }
      sendJson(res, 405, { status: "error", code: "METHOD_NOT_ALLOWED", error: "Method not allowed." });
    } catch (error) {
      const statusCode = statusForError(error);
      sendJson(res, statusCode, {
        status: "error",
        code: safeErrorCode(error),
        error: statusCode >= 500
          ? "PrivacyAI could not complete the local sanitization preview."
          : error instanceof Error ? error.message : "Invalid request."
      });
    }
  });

  return {
    server,
    services,
    async listen(port = 0, host = HOST) {
      await listen(server, port, host);
      return server.address();
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      if (services.ownsImageSanitizer && typeof services.imageSanitizer?.close === "function") {
        await services.imageSanitizer.close();
      }
    }
  };
}

async function handleApi(req, res, url, services, maxBodyBytes) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    return sendJson(res, 200, {
      status: "running",
      provider: services.config.provider,
      provider_label: "Ollama",
      model: services.config.model,
      base_url: services.config.baseURL,
      image_privacy: true
    });
  }

  if (req.method === "POST" && url.pathname === "/api/sanitize") {
    const body = await readBody(req, maxBodyBytes);
    const message = requireMessage(body.message);
    const result = await sanitizePrompt(message, services);
    return sendJson(res, 200, {
      status: "success",
      original_message: message,
      sanitized_message: result.value,
      privacy_items_detected: Object.keys(result.sessionMap),
      changed: result.changed
    });
  }

  if (req.method === "POST" && url.pathname === "/api/sanitize-image") {
    const body = await readBody(req, maxBodyBytes);
    const message = requireMessage(body.message);
    const imageDataUrl = requireImage(body.image_data_url);

    const imageResult = await services.imageSanitizer.sanitize(imageDataUrl, {
      sanitizer: services.strictSanitizer,
      sessionMap: {},
      maxContextChars: services.maxContextChars
    });
    const promptResult = await sanitizePrompt(message, services, imageResult.sessionMapAdditions);
    const sessionMap = {
      ...imageResult.sessionMapAdditions,
      ...promptResult.sessionMap
    };

    return sendJson(res, 200, {
      status: "success",
      original_message: message,
      sanitized_message: promptResult.value,
      sanitized_image_url: imageResult.dataUrl,
      privacy_items_detected: Object.keys(sessionMap),
      prompt_changed: promptResult.value !== message,
      image_changed: imageResult.changed,
      image_stats: {
        detected_line_count: Number(imageResult.detectedLineCount || 0),
        protected_region_count: Number(imageResult.regionCount || 0),
        mask_strategy: imageResult.maskStrategy || null,
        verification_attempts: Number(imageResult.verificationAttempts || 0)
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/process") {
    const body = await readBody(req, maxBodyBytes);
    const message = requireMessage(body.message);
    const systemPrompt = String(body.system_prompt || "").trim();
    const result = await services.client.ask(message, {
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
      ai_service_used: "Ollama"
    });
  }

  if (req.method === "POST" && url.pathname === "/api/test-connection") {
    await readBody(req, maxBodyBytes);
    const result = await services.client.ask("Reply with exactly: PrivacyAI connection OK.", {
      maxTokens: 32,
      temperature: 0,
      system: "Reply with exactly: PrivacyAI connection OK."
    });
    return sendJson(res, 200, {
      status: "success",
      service: "Ollama",
      response: result.finalText
    });
  }

  return sendJson(res, 404, { status: "error", code: "NOT_FOUND", error: "Not found." });
}

async function sanitizePrompt(message, services, sessionMap = {}) {
  const result = await sanitizeStructuredValue(message, {
    sanitizer: services.strictSanitizer,
    sessionMap,
    maxContextChars: services.maxContextChars,
    artifactType: "web_demo_prompt"
  });
  return {
    value: result.value,
    changed: result.changed,
    sessionMap: { ...sessionMap, ...result.sessionMapAdditions }
  };
}

function requireMessage(value) {
  const message = String(value || "").trim();
  if (!message) throw requestError("MISSING_MESSAGE", "Enter a prompt before sanitizing.");
  return message;
}

function requireImage(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw requestError("MISSING_IMAGE", "Choose a PNG, JPEG, or WebP image before sanitizing.");
  }
  return value;
}

function privacyItemsFromResult(result) {
  if (Array.isArray(result?.detections)) {
    return result.detections.map(detection => detection.replacement).filter(Boolean);
  }
  return Object.keys(result?.sessionMap || {});
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = requestError("REQUEST_TOO_LARGE", "The prompt and image exceed the playground request limit.");
        error.statusCode = 413;
        finish(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (chunks.length === 0) return finish(null, {});
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(requestError("INVALID_JSON", "The request body is not valid JSON."));
      }
    };
    const onError = error => finish(error);

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

function serveStatic(res, url, publicDir) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requestPath));
  const safePublicDir = publicDir.endsWith(path.sep) ? publicDir : `${publicDir}${path.sep}`;
  if (!filePath.startsWith(safePublicDir)) {
    sendJson(res, 403, { status: "error", code: "FORBIDDEN", error: "Forbidden." });
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { status: "error", code: "NOT_FOUND", error: "Not found." });
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "x-content-type-options": "nosniff"
  });
  fs.createReadStream(filePath).pipe(res);
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function statusForError(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (String(error?.code || "").startsWith("PRIVACYAI_IMAGE_")) return 400;
  return 500;
}

function safeErrorCode(error) {
  const code = String(error?.code || "INTERNAL_ERROR");
  return /^[A-Z0-9_]{2,80}$/.test(code) ? code : "INTERNAL_ERROR";
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function listenWithFallback(app, startPort) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    try {
      await app.listen(port, HOST);
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No free port found between ${startPort} and ${startPort + MAX_PORT_ATTEMPTS - 1}.`);
}

export async function startWebDemo(options = {}) {
  const app = await createWebDemoServer(options);
  const port = await listenWithFallback(app, Number(options.port || REQUESTED_PORT));
  const url = `http://${HOST}:${port}`;
  console.log(`PrivacyAI playground running at ${url}`);
  if (port !== REQUESTED_PORT) console.log(`Port ${REQUESTED_PORT} was busy, using ${port} instead.`);
  console.log(`Provider: Ollama (${app.services.config.model})`);
  console.log("Image previews use the same strict local sanitizer as the Codex gateway.");
  console.log("Press Ctrl+C to stop.");
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  startWebDemo().catch(error => {
    console.error("");
    console.error(error instanceof Error ? error.message : "Failed to start the PrivacyAI playground.");
    console.error("");
    process.exitCode = 1;
  });
}
