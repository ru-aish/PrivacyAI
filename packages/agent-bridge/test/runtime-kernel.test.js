import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AgySseRestorer } from "../src/agy-sse-transform.js";
import { CodexSseRestorer } from "../src/codex-sse-transform.js";
import {
  createDownstreamLifecycle,
  throwIfAborted
} from "../src/runtime/downstream-lifecycle.js";
import { readBoundedHttpBody } from "../src/runtime/http-body.js";
import {
  createPreferredLookup,
  requestHttpResponse,
  selectPreferredAddress
} from "../src/runtime/http-client.js";
import {
  HOP_BY_HOP_HEADERS,
  copyHttpHeaders,
  forwardHttpHeaders
} from "../src/runtime/http-headers.js";
import {
  closeHttpServer,
  listenOnHost,
  trackServerSockets
} from "../src/runtime/http-server.js";
import {
  nextWithTimeout,
  writeWithBackpressure
} from "../src/runtime/stream-io.js";
import {
  closeResourcesAfterFailure,
  createRetryableResourceCloser
} from "../src/resource-cleanup.js";

const LOOPBACK = "127.0.0.1";

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

test("runtime servers use independent ephemeral ports and close only owned sockets", async () => {
  const first = await startServer("first");
  const second = await startServer("second");
  try {
    assert.notEqual(first.port, second.port);
    assert.equal(await getText(first.port), "first");
    assert.equal(await getText(second.port), "second");

    await closeHttpServer(first.server, first.sockets);
    assert.equal(first.sockets.size, 0);
    await assert.rejects(getText(first.port));
    assert.equal(await getText(second.port), "second");
  } finally {
    await closeHttpServer(first.server, first.sockets);
    await closeHttpServer(second.server, second.sockets);
  }
});

test("runtime servers tolerate repeated ephemeral start and close cycles without retained sockets", async () => {
  for (let index = 0; index < 12; index += 1) {
    const runtime = await startServer(String(index));
    assert.equal(await getText(runtime.port), String(index));
    await closeHttpServer(runtime.server, runtime.sockets);
    assert.equal(runtime.server.listening, false);
    assert.equal(runtime.sockets.size, 0);
  }
});

test("bounded HTTP bodies preserve limit, truncation, abort, and idle errors", async () => {
  const oversized = new PassThrough();
  const oversizedRead = readBoundedHttpBody(oversized, 3, {
    limitAction: "destroy",
    errors: { tooLarge: () => codedError("TOO_LARGE") }
  });
  oversized.end("four");
  await assert.rejects(oversizedRead, error => error?.code === "TOO_LARGE");
  assert.equal(oversized.destroyed, true);

  const truncated = new PassThrough();
  const truncatedRead = readBoundedHttpBody(truncated, 32, {
    errors: { truncated: () => codedError("TRUNCATED") }
  });
  truncated.write("partial");
  truncated.destroy();
  await assert.rejects(truncatedRead, error => error?.code === "TRUNCATED");

  const aborted = new PassThrough();
  const abortedRead = readBoundedHttpBody(aborted, 32, {
    errors: {
      aborted: () => codedError("ABORTED"),
      truncated: () => codedError("TRUNCATED")
    }
  });
  aborted.emit("aborted");
  await assert.rejects(abortedRead, error => error?.code === "ABORTED");

  const idle = new PassThrough();
  const idleRead = readBoundedHttpBody(idle, 32, {
    idleTimeoutMs: 20,
    errors: { idle: () => codedError("IDLE") }
  });
  await assert.rejects(idleRead, error => error?.code === "IDLE");
  assert.equal(idle.destroyed, true);
});

test("downstream lifecycle aborts in-flight work but ignores a completed response close", () => {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.writableEnded = false;
  const disconnect = codedError("CLIENT_GONE");
  const lifecycle = createDownstreamLifecycle(request, response, () => disconnect);

  request.emit("aborted");
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(lifecycle.signal.reason, disconnect);
  assert.equal(lifecycle.downstreamClosed(), true);
  assert.throws(() => throwIfAborted(lifecycle.signal), error => error === disconnect);
  lifecycle.cleanup();

  const completedRequest = new EventEmitter();
  const completedResponse = new EventEmitter();
  completedResponse.writableEnded = true;
  const completed = createDownstreamLifecycle(completedRequest, completedResponse, disconnect);
  completedResponse.emit("close");
  assert.equal(completed.signal.aborted, false);
  completed.cleanup();
});

test("preferred lookup selects IPv4 first and falls back to IPv6-only results", async () => {
  assert.deepEqual(selectPreferredAddress([
    { address: "2001:db8::1", family: 6 },
    { address: "192.0.2.5", family: 4 }
  ]), { address: "192.0.2.5", family: 4 });
  assert.deepEqual(
    selectPreferredAddress([{ address: "2001:db8::1", family: 6 }]),
    { address: "2001:db8::1", family: 6 }
  );

  const calls = [];
  const lookup = createPreferredLookup((hostname, options, callback) => {
    calls.push({ hostname, options });
    callback(null, [{ address: "2001:db8::2", family: 6 }]);
  });
  const result = await new Promise((resolve, reject) => {
    lookup("example.test", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(result, { address: "2001:db8::2", family: 6 });
  assert.deepEqual(calls, [{ hostname: "example.test", options: { all: true } }]);
});

test("HTTP client surfaces DNS failure, response-header timeout, reset, and cancellation", async () => {
  const dnsError = codedError("ENOTFOUND", "lookup failed");
  await assert.rejects(
    requestHttpResponse(new URL("https://runtime.invalid/"), {
      method: "GET",
      lookup: (_hostname, _options, callback) => callback(dnsError),
      timeoutMs: 200
    }),
    error => error === dnsError
  );

  const hanging = http.createServer((_request, _response) => {});
  await listenOnHost(hanging, 0, LOOPBACK);
  const hangingPort = hanging.address().port;
  await assert.rejects(
    requestHttpResponse(new URL(`http://${LOOPBACK}:${hangingPort}/`), {
      method: "GET",
      timeoutMs: 25,
      timeoutError: () => codedError("HEADER_TIMEOUT")
    }),
    error => error?.code === "HEADER_TIMEOUT"
  );
  await closeHttpServer(hanging, new Set());

  const resetting = http.createServer(request => request.socket.destroy());
  await listenOnHost(resetting, 0, LOOPBACK);
  const resetPort = resetting.address().port;
  await assert.rejects(
    requestHttpResponse(new URL(`http://${LOOPBACK}:${resetPort}/`), { method: "GET" }),
    error => error?.code === "ECONNRESET"
  );
  await closeHttpServer(resetting, new Set());

  const cancelledServer = http.createServer((_request, _response) => {});
  await listenOnHost(cancelledServer, 0, LOOPBACK);
  const cancelledPort = cancelledServer.address().port;
  const controller = new AbortController();
  const cancellation = codedError("CANCELLED");
  const pending = requestHttpResponse(new URL(`http://${LOOPBACK}:${cancelledPort}/`), {
    method: "POST",
    body: Buffer.from("body"),
    signal: controller.signal
  });
  controller.abort(cancellation);
  await assert.rejects(pending, error => error === cancellation);
  await closeHttpServer(cancelledServer, new Set());
});

test("HTTP client abort propagates after response headers during streaming", async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
  });
  const sockets = trackServerSockets(upstream);
  await listenOnHost(upstream, 0, LOOPBACK);
  const port = upstream.address().port;
  const controller = new AbortController();
  try {
    const response = await requestHttpResponse(new URL(`http://${LOOPBACK}:${port}/`), {
      method: "GET",
      signal: controller.signal
    });
    await once(response, "data");
    const cancellation = codedError("STREAM_CANCELLED");
    const closed = new Promise(resolve => response.once("close", resolve));
    const emittedError = new Promise(resolve => response.once("error", resolve));
    controller.abort(cancellation);
    assert.equal(await emittedError, cancellation);
    await closed;
    assert.equal(response.destroyed, true);
  } finally {
    await closeHttpServer(upstream, sockets);
  }
});

test("header helpers remove hop-by-hop fields while leaving protocol policy explicit", () => {
  const copied = copyHttpHeaders({
    Connection: "keep-alive",
    Host: "source.test",
    "X-Forwarded-For": "private",
    "X-Request-Id": "request-1"
  }, new Set([...HOP_BY_HOP_HEADERS, "host"]), {
    excludedPrefixes: ["x-forwarded-"],
    lowerCaseNames: true
  });
  assert.deepEqual(copied, { "x-request-id": "request-1" });

  const values = new Map();
  const response = { setHeader: (name, value) => values.set(name.toLowerCase(), value) };
  forwardHttpHeaders(response, {
    connection: "close",
    "content-type": "application/json"
  });
  assert.deepEqual([...values], [["content-type", "application/json"]]);
});

test("backpressure waits for drain and reports close without leaking listeners", async () => {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.writableEnded = false;
  stream.write = () => false;
  const pending = writeWithBackpressure(stream, "value", () => codedError("CLOSED"));
  assert.equal(stream.listenerCount("drain"), 1);
  stream.emit("drain");
  await pending;
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("error"), 0);
  assert.equal(stream.listenerCount("close"), 0);

  const closing = new EventEmitter();
  closing.destroyed = false;
  closing.writableEnded = false;
  closing.write = () => false;
  const rejected = writeWithBackpressure(closing, "value", () => codedError("CLOSED"));
  closing.emit("close");
  await assert.rejects(rejected, error => error?.code === "CLOSED");

  const pipeError = codedError("EPIPE");
  const broken = new EventEmitter();
  broken.destroyed = false;
  broken.writableEnded = false;
  broken.write = () => { throw pipeError; };
  await assert.rejects(
    writeWithBackpressure(broken, "value", () => codedError("CLOSED")),
    error => error === pipeError
  );
});

test("stream inactivity deadline destroys the owned upstream", async () => {
  const stream = new EventEmitter();
  let destroyedWith;
  stream.destroy = error => { destroyedWith = error; };
  const timeout = codedError("IDLE_TIMEOUT");
  await assert.rejects(
    nextWithTimeout({ next: () => new Promise(() => {}) }, stream, 20, () => timeout),
    error => error === timeout
  );
  assert.equal(destroyedWith, timeout);
});

test("SSE adapters accept every byte split and retain their protocol-specific incomplete errors", () => {
  const frame = Buffer.from(": keepalive\r\n\r\n");
  for (const Restorer of [CodexSseRestorer, AgySseRestorer]) {
    for (let split = 0; split <= frame.length; split += 1) {
      const restorer = new Restorer();
      const output = [
        ...restorer.write(frame.subarray(0, split)),
        ...restorer.write(frame.subarray(split)),
        ...restorer.end()
      ];
      assert.equal(output.join(""), ": keepalive\n\n");
    }
  }

  assert.throws(
    () => new CodexSseRestorer().end(Buffer.from("data: {}\n")),
    error => error?.code === "PRIVACYAI_CODEX_INCOMPLETE_SSE"
  );
  assert.throws(
    () => new AgySseRestorer().end(Buffer.from("data: {}\n")),
    error => error?.code === "PRIVACYAI_AGY_INCOMPLETE_SSE"
  );
  assert.throws(
    () => new AgySseRestorer({}, { maxBufferedChars: 4 }).write(Buffer.from("12345")),
    error => error?.code === "PRIVACYAI_AGY_SSE_BUFFER_LIMIT"
  );
});

test("resource cleanup preserves primary failures and retries only failed resources", async () => {
  const primary = codedError("START_FAILED");
  const cleanup = codedError("CLEANUP_FAILED");
  await assert.rejects(
    closeResourcesAfterFailure([{ close: async () => { throw cleanup; } }], primary, "partial failure"),
    error => error instanceof AggregateError && error.cause === primary &&
      error.errors[0] === primary && error.errors[1] === cleanup
  );

  let firstCalls = 0;
  let secondCalls = 0;
  const close = createRetryableResourceCloser([
    {
      async close() {
        firstCalls += 1;
        if (firstCalls === 1) throw codedError("RETRY_ME");
      }
    },
    { async close() { secondCalls += 1; } }
  ], "close failed");
  await assert.rejects(close(), error => error?.code === "RETRY_ME");
  assert.deepEqual({ firstCalls, secondCalls }, { firstCalls: 1, secondCalls: 1 });
  await close();
  assert.deepEqual({ firstCalls, secondCalls }, { firstCalls: 2, secondCalls: 1 });
});

async function startServer(body) {
  const sockets = new Set();
  const server = http.createServer((_request, response) => response.end(body));
  trackServerSockets(server, sockets);
  await listenOnHost(server, 0, LOOPBACK);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, sockets, port: address.port };
}

function getText(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: LOOPBACK, port, path: "/", agent: false }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", reject);
  });
}
