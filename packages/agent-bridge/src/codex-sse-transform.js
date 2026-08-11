import { StringDecoder } from "node:string_decoder";

import { StreamingPlaceholderRestorer, restoreValue } from "@privacy-ai/sdk";
import { restoreResponseItem } from "./codex-request-transform.js";
import { gatewayError as protocolError } from "./gateway-error.js";

const DELTA_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.custom_tool_call_input.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta"
]);

const TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete"
]);

const FORWARDED_EVENT_TYPES = new Set([
  "response.created",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.annotation.added",
  "response.custom_tool_call_input.delta",
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.image_generation_call.in_progress",
  "response.image_generation_call.generating",
  "response.image_generation_call.partial_image",
  "response.image_generation_call.completed",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.reasoning_summary_part.added"
]);

const INTERNAL_EVENT_TYPES = new Set([
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done"
]);

const SUPPRESSED_EVENT_TYPES = new Set([
  "response.in_progress",
  "response.queued",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.custom_tool_call_input.done",
  "response.reasoning_summary_part.done",
  "response.refusal.delta",
  "response.refusal.done",
  "error"
]);

export class CodexSseRestorer {
  constructor(sessionMap = {}, options = {}) {
    this.sessionMap = sessionMap;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.deltaStreams = new Map();
    this.functionArgumentsByAlias = new Map();
    this.completedToolCalls = [];
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    this.maxFunctionArgumentChars = Number(options.maxFunctionArgumentChars || 1_000_000);
  }

  write(chunk) {
    this.buffer += this.decoder.write(chunk);
    return this.#drainFrames(false);
  }

  end(chunk) {
    if (chunk) this.buffer += this.decoder.write(chunk);
    this.buffer += this.decoder.end();
    const output = this.#drainFrames(true);
    if (this.buffer.length > 0) {
      throw protocolError(
        "PRIVACYAI_CODEX_INCOMPLETE_SSE",
        "Codex provider stream ended with an incomplete SSE frame."
      );
    }
    this.#assertNoPendingFunctionArguments();
    return output;
  }

  drainCompletedToolCalls() {
    const completed = this.completedToolCalls;
    this.completedToolCalls = [];
    return completed;
  }

  #drainFrames(final) {
    const output = [];
    while (true) {
      const boundary = nextFrameBoundary(this.buffer);
      if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      output.push(...this.#transformFrame(frame));
    }
    if (final && this.buffer.trim() === "") this.buffer = "";
    return output;
  }

  #transformFrame(frame) {
    const parsed = parseSseFrame(frame);
    if (parsed.data == null) return [`${frame}\n\n`];
    if (parsed.data === "[DONE]") {
      this.#assertNoPendingFunctionArguments();
      return [
        ...this.#flushAllEvents().map(value => serializeSseFrame(parsed, JSON.stringify(value))),
        serializeSseFrame(parsed, "[DONE]")
      ];
    }

    let event;
    try {
      event = JSON.parse(parsed.data);
    } catch {
      throw protocolError(
        "PRIVACYAI_CODEX_INVALID_SSE",
        "PrivacyAI blocked a non-JSON Codex provider SSE event."
      );
    }

    if (
      !FORWARDED_EVENT_TYPES.has(event.type) &&
      !INTERNAL_EVENT_TYPES.has(event.type) &&
      !SUPPRESSED_EVENT_TYPES.has(event.type)
    ) {
      throw protocolError(
        "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT",
        `PrivacyAI blocked unsupported Codex SSE event type: ${safeEventType(event.type)}`
      );
    }
    this.onEvent?.({
      type: safeEventType(event.type),
      itemType: event.item?.type ? safeEventType(event.item.type) : null
    });

    const transformed = [];
    if (shouldFlushBefore(event)) transformed.push(...this.#flushAllEvents());

    if (SUPPRESSED_EVENT_TYPES.has(event.type)) {
      // Codex 0.144.1 ignores these events. Suppress them rather than forwarding
      // unexamined future payload shapes through the local restoration boundary.
    } else if (event.type === "response.output_item.added" && isFunctionCallItem(event.item)) {
      this.#registerFunctionCallItem(event);
      transformed.push(restoreStartedFunctionCallEvent(event, this.sessionMap));
    } else if (event.type === "response.function_call_arguments.delta") {
      this.#appendFunctionArgumentDelta(event);
    } else if (event.type === "response.function_call_arguments.done") {
      this.#recordFunctionArgumentDone(event);
    } else if (event.type === "response.output_item.done" && isFunctionCallItem(event.item)) {
      const completed = this.#completeFunctionCallEvent(event);
      const restored = restoreEvent(completed, this.sessionMap);
      transformed.push(restored);
      this.completedToolCalls.push(restored.item);
    } else if (event.type === "response.output_item.done" && isCustomToolCallItem(event.item)) {
      const restored = restoreEvent(event, this.sessionMap);
      transformed.push(restored);
      this.completedToolCalls.push(restored.item);
    } else if (DELTA_EVENT_TYPES.has(event.type) && typeof event.delta === "string") {
      const key = deltaStreamKey(event);
      const stream = this.#streamFor(key, event);
      const delta = stream.restorer.push(event.delta);
      stream.template = event;
      if (delta) transformed.push({ ...event, delta });
    } else {
      if (TERMINAL_EVENT_TYPES.has(event.type)) this.#assertNoPendingFunctionArguments();
      transformed.push(restoreEvent(event, this.sessionMap));
    }

    return transformed.map(value => serializeSseFrame(parsed, JSON.stringify(value)));
  }

  #registerFunctionCallItem(event) {
    const keys = functionArgumentAliases(event, event.item);
    if (keys.length === 0) return;
    this.#findOrCreateFunctionArgumentStream(keys);
  }

  #appendFunctionArgumentDelta(event) {
    if (typeof event.delta !== "string") {
      throw protocolError(
        "PRIVACYAI_CODEX_INVALID_TOOL_ARGUMENT_DELTA",
        "PrivacyAI blocked a non-string Codex function-argument delta."
      );
    }
    const keys = functionArgumentAliases(event);
    if (keys.length === 0) {
      throw protocolError(
        "PRIVACYAI_CODEX_UNIDENTIFIED_TOOL_ARGUMENTS",
        "PrivacyAI blocked Codex function arguments without an item or call identity."
      );
    }
    const stream = this.#findOrCreateFunctionArgumentStream(keys);
    stream.text += event.delta;
    if (stream.text.length > this.maxFunctionArgumentChars) {
      throw protocolError(
        "PRIVACYAI_CODEX_TOOL_ARGUMENTS_TOO_LARGE",
        "PrivacyAI blocked oversized Codex function-call arguments."
      );
    }
  }

  #recordFunctionArgumentDone(event) {
    const keys = functionArgumentAliases(event);
    if (keys.length === 0) {
      throw protocolError(
        "PRIVACYAI_CODEX_UNIDENTIFIED_TOOL_ARGUMENTS",
        "PrivacyAI blocked completed Codex function arguments without an identity."
      );
    }
    const stream = this.#findOrCreateFunctionArgumentStream(keys);
    const finalValue =
      typeof event.arguments === "string"
        ? event.arguments
        : typeof event.delta === "string"
          ? event.delta
          : typeof event.text === "string"
            ? event.text
            : null;
    if (finalValue != null) {
      if (finalValue.length > this.maxFunctionArgumentChars) {
        throw protocolError(
          "PRIVACYAI_CODEX_TOOL_ARGUMENTS_TOO_LARGE",
          "PrivacyAI blocked oversized completed Codex function-call arguments."
        );
      }
      stream.finalText = finalValue;
    }
  }

  #completeFunctionCallEvent(event) {
    const restored = JSON.parse(JSON.stringify(event));
    const keys = functionArgumentAliases(restored, restored.item);
    const stream = this.#findFunctionArgumentStream(keys);
    const candidates = [
      restored.item.arguments,
      stream?.finalText,
      stream?.text
    ].filter(value => typeof value === "string" && value.trim().length > 0);

    if (candidates.length === 0) {
      throw protocolError(
        "PRIVACYAI_CODEX_MISSING_TOOL_ARGUMENTS",
        "PrivacyAI blocked a completed Codex function call without arguments."
      );
    }

    const parsedCandidates = candidates.map(value => parseFunctionArguments(value));
    const canonical = parsedCandidates.map(value => JSON.stringify(value));
    if (new Set(canonical).size > 1) {
      throw protocolError(
        "PRIVACYAI_CODEX_CONFLICTING_TOOL_ARGUMENTS",
        "PrivacyAI blocked conflicting Codex function-call argument representations."
      );
    }

    restored.item.arguments = canonical[0];
    if (stream) this.#deleteFunctionArgumentStream(stream);
    return restored;
  }

  #findOrCreateFunctionArgumentStream(keys) {
    const existing = keys
      .map(key => this.functionArgumentsByAlias.get(key))
      .filter(Boolean);
    const unique = [...new Set(existing)];
    if (unique.length > 1) {
      throw protocolError(
        "PRIVACYAI_CODEX_TOOL_ARGUMENT_ID_COLLISION",
        "PrivacyAI blocked conflicting Codex function-call identities."
      );
    }
    const stream = unique[0] || { text: "", finalText: null, aliases: new Set() };
    for (const key of keys) {
      const mapped = this.functionArgumentsByAlias.get(key);
      if (mapped && mapped !== stream) {
        throw protocolError(
          "PRIVACYAI_CODEX_TOOL_ARGUMENT_ID_COLLISION",
          "PrivacyAI blocked conflicting Codex function-call identities."
        );
      }
      stream.aliases.add(key);
      this.functionArgumentsByAlias.set(key, stream);
    }
    return stream;
  }

  #findFunctionArgumentStream(keys) {
    const streams = keys.map(key => this.functionArgumentsByAlias.get(key)).filter(Boolean);
    const unique = [...new Set(streams)];
    if (unique.length > 1) {
      throw protocolError(
        "PRIVACYAI_CODEX_TOOL_ARGUMENT_ID_COLLISION",
        "PrivacyAI blocked conflicting Codex function-call identities."
      );
    }
    return unique[0] || null;
  }

  #deleteFunctionArgumentStream(stream) {
    for (const alias of stream.aliases) this.functionArgumentsByAlias.delete(alias);
    stream.aliases.clear();
  }

  #assertNoPendingFunctionArguments() {
    const pending = new Set(this.functionArgumentsByAlias.values());
    if (pending.size === 0) return;
    throw protocolError(
      "PRIVACYAI_CODEX_INCOMPLETE_TOOL_ARGUMENTS",
      `PrivacyAI blocked a Codex stream with ${pending.size} incomplete function-call argument set(s).`
    );
  }

  #streamFor(key, template) {
    let stream = this.deltaStreams.get(key);
    if (!stream) {
      stream = {
        restorer: new StreamingPlaceholderRestorer(this.sessionMap),
        template
      };
      this.deltaStreams.set(key, stream);
    }
    return stream;
  }

  #flushAllEvents() {
    const events = [];
    for (const [key, stream] of this.deltaStreams) {
      const delta = stream.restorer.flush();
      if (delta) events.push({ ...stream.template, delta });
      this.deltaStreams.delete(key);
    }
    return events;
  }
}

export function restoreEvent(event, sessionMap = {}) {
  const restored = JSON.parse(JSON.stringify(event));
  if (restored.item) restoreResponseItem(restored.item, sessionMap);
  if (typeof restored.text === "string") restored.text = restoreValue(restored.text, sessionMap);
  if (typeof restored.delta === "string") restored.delta = restoreValue(restored.delta, sessionMap);
  if (restored.part && typeof restored.part === "object") {
    restored.part = restoreValue(restored.part, sessionMap);
  }
  if (restored.annotation && typeof restored.annotation === "object") {
    restored.annotation = restoreValue(restored.annotation, sessionMap);
  }
  if (restored.response?.error?.message && typeof restored.response.error.message === "string") {
    restored.response.error.message = restoreValue(restored.response.error.message, sessionMap);
  }
  if (typeof restored.message === "string") restored.message = restoreValue(restored.message, sessionMap);
  return restored;
}

function restoreStartedFunctionCallEvent(event, sessionMap) {
  const restored = JSON.parse(JSON.stringify(event));
  if (typeof restored.item?.name === "string") {
    restored.item.name = restoreValue(restored.item.name, sessionMap);
  }
  if (typeof restored.item?.namespace === "string") {
    restored.item.namespace = restoreValue(restored.item.namespace, sessionMap);
  }
  return restored;
}

function parseFunctionArguments(value) {
  try {
    return JSON.parse(value);
  } catch {
    const firstCode = value.length > 0 ? value.codePointAt(0) : -1;
    const lastCode = value.length > 0 ? value.codePointAt(value.length - 1) : -1;
    throw protocolError(
      "PRIVACYAI_CODEX_INVALID_TOOL_ARGUMENTS",
      `PrivacyAI blocked invalid JSON in Codex function-call arguments (length=${value.length}, first=${firstCode}, last=${lastCode}).`
    );
  }
}

function isFunctionCallItem(item) {
  return item?.type === "function_call";
}

function isCustomToolCallItem(item) {
  return item?.type === "custom_tool_call";
}

function functionArgumentAliases(event, item) {
  const aliases = [];
  const values = [
    ["item", event?.item_id],
    ["call", event?.call_id],
    ["output", event?.output_index],
    ["item", item?.id],
    ["call", item?.call_id]
  ];
  for (const [kind, value] of values) {
    if (value == null || value === "") continue;
    aliases.push(`${kind}:${String(value)}`);
  }
  return [...new Set(aliases)];
}

function shouldFlushBefore(event) {
  return new Set([
    "response.output_item.done",
    "response.output_text.done",
    "response.reasoning_summary_text.done",
    "response.completed",
    "response.failed",
    "response.incomplete"
  ]).has(event?.type);
}

function deltaStreamKey(event) {
  const identity =
    event.item_id ??
    event.call_id ??
    event.output_index ??
    event.content_index ??
    event.summary_index ??
    "default";
  return `${event.type}:${identity}`;
}

function parseSseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const dataLines = [];
  const otherLines = [];
  for (const line of lines) {
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else otherLines.push(line);
  }
  return {
    data: dataLines.length > 0 ? dataLines.join("\n") : null,
    otherLines
  };
}

function serializeSseFrame(parsed, data) {
  const lines = [...parsed.otherLines.filter(Boolean), `data: ${data}`];
  return `${lines.join("\n")}\n\n`;
}

function nextFrameBoundary(value) {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function safeEventType(value) {
  const text = String(value || "missing");
  return /^[A-Za-z0-9._-]{1,120}$/.test(text) ? text : "invalid";
}
