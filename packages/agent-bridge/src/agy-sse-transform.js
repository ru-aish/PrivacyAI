import { StringDecoder } from "node:string_decoder";

import {
  GENERATED_DUMMY_PATTERN_SOURCE,
  StreamingPlaceholderRestorer,
  findUnresolvedPlaceholders,
  restoreValue
} from "@privacy-ai/sdk";

const AGY_PRIVATE_PLACEHOLDER_PATTERN = new RegExp(
  String.raw`(?:\[(?:EMAIL|PHONE|PERSON|ORGANIZATION|LOCATION|SSN|CREDIT_CARD|API_KEY|AWS_ACCESS_KEY|URL_CREDENTIAL|URL_QUERY_SECRET|CONNECTION_STRING_CREDENTIAL|MEDICAL_ID|MRN|PRIVATE_IDENTIFIER|PRIVATE_VALUE|PASSWORD|SECRET|CREDENTIAL|TOKEN|IP_ADDRESS|POSTAL_CODE|ZIP|TOOL|TOOL_NAME|FUNCTION|FUNCTION_NAME)_\d+\]|${GENERATED_DUMMY_PATTERN_SOURCE}|\bprivacyai_tool_[0-9a-f]{12,64}\b)`,
  "gi"
);

export class AgySseRestorer {
  constructor(sessionMap = {}, options = {}) {
    this.sessionMap = sessionMap;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.textStreams = new Map();
    this.maxBufferedChars = Number(options.maxBufferedChars || 2_000_000);
  }

  write(chunk) {
    this.buffer += this.decoder.write(chunk);
    this.#assertBufferLimit();
    return this.#drain(false);
  }

  end(chunk) {
    if (chunk) this.buffer += this.decoder.write(chunk);
    this.buffer += this.decoder.end();
    this.#assertBufferLimit();
    const output = this.#drain(true);
    if (this.buffer.length > 0) {
      throw agySseError(
        "PRIVACYAI_AGY_INCOMPLETE_SSE",
        "AGY model stream ended with an incomplete SSE frame."
      );
    }
    output.push(...this.#flushTextStreams().map(value =>
      serializeFrame({ otherLines: [] }, JSON.stringify(value))
    ));
    return output;
  }

  #drain(final) {
    const output = [];
    while (true) {
      const boundary = nextBoundary(this.buffer);
      if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      output.push(...this.#transformFrame(frame));
    }
    if (final && this.buffer.trim() === "") this.buffer = "";
    return output;
  }

  #transformFrame(frame) {
    const parsed = parseFrame(frame);
    if (parsed.data == null) return [`${frame}\n\n`];
    if (parsed.data === "[DONE]") {
      return [
        ...this.#flushTextStreams().map(value => serializeFrame(parsed, JSON.stringify(value))),
        serializeFrame(parsed, "[DONE]")
      ];
    }

    let event;
    try {
      event = JSON.parse(parsed.data);
    } catch {
      throw agySseError(
        "PRIVACYAI_AGY_INVALID_SSE",
        "PrivacyAI blocked a non-JSON AGY model stream event."
      );
    }

    const restored = this.#restoreEvent(event);
    if (!hasFinishReason(event)) {
      return [serializeFrame(parsed, JSON.stringify(restored))];
    }

    const flushed = this.#flushTextStreams();
    if (flushed.length === 0) {
      return [serializeFrame(parsed, JSON.stringify(restored))];
    }

    const output = [];
    const contentEvent = withoutFinishReasons(restored);
    if (hasCandidatePayload(contentEvent)) output.push(contentEvent);
    output.push(...flushed, finishOnlyEvent(restored));
    return output.map(value => serializeFrame(parsed, JSON.stringify(value)));
  }

  #restoreEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw agySseError("PRIVACYAI_AGY_INVALID_SSE", "AGY model stream event must be an object.");
    }
    const restored = structuredClone(event);
    if (restored.response?.error?.message && typeof restored.response.error.message === "string") {
      restored.response.error.message = restoreValue(restored.response.error.message, this.sessionMap);
    }

    const candidates = restored.response?.candidates;
    if (candidates == null) return restored;
    if (!Array.isArray(candidates)) {
      throw agySseError("PRIVACYAI_AGY_INVALID_SSE", "AGY response candidates must be an array.");
    }

    candidates.forEach((candidate, candidateIndex) => {
      const parts = candidate?.content?.parts;
      if (parts == null) return;
      if (!Array.isArray(parts)) {
        throw agySseError("PRIVACYAI_AGY_INVALID_SSE", "AGY candidate parts must be an array.");
      }
      parts.forEach((part, partIndex) => this.#restorePart(part, candidateIndex, partIndex, restored));
    });
    return restored;
  }

  #restorePart(part, candidateIndex, partIndex, event) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw agySseError("PRIVACYAI_AGY_INVALID_SSE", "AGY candidate part must be an object.");
    }
    const payloads = ["text", "functionCall", "functionResponse"].filter(key => part[key] != null);
    if (payloads.length !== 1) {
      throw agySseError(
        "PRIVACYAI_AGY_UNSUPPORTED_SSE_PART",
        "PrivacyAI blocked an unsupported AGY candidate part."
      );
    }

    if (typeof part.text === "string") {
      const key = `${candidateIndex}:${partIndex}`;
      let stream = this.textStreams.get(key);
      if (!stream) {
        stream = {
          restorer: new StreamingPlaceholderRestorer(this.sessionMap),
          template: null,
          candidateIndex,
          partIndex
        };
        this.textStreams.set(key, stream);
      }
      part.text = stream.restorer.push(part.text);
      stream.template = event;
      return;
    }

    if (part.functionCall != null) {
      validateFunctionCall(part.functionCall);
      part.functionCall.name = restoreValue(part.functionCall.name, this.sessionMap);
      part.functionCall.args = restoreValue(part.functionCall.args, this.sessionMap);
      assertResolvedToolPayload(part.functionCall, "PRIVACYAI_AGY_UNRESOLVED_TOOL_CALL");
      return;
    }

    validateFunctionResponse(part.functionResponse);
    part.functionResponse.name = restoreValue(part.functionResponse.name, this.sessionMap);
    part.functionResponse.response = restoreValue(part.functionResponse.response, this.sessionMap);
    assertResolvedToolPayload(part.functionResponse, "PRIVACYAI_AGY_UNRESOLVED_TOOL_RESPONSE");
  }

  #flushTextStreams() {
    const events = [];
    for (const [key, stream] of this.textStreams) {
      const text = stream.restorer.flush();
      this.textStreams.delete(key);
      if (!text || !stream.template) continue;
      events.push(createTextFlushEvent(
        stream.template,
        stream.candidateIndex,
        stream.partIndex,
        text
      ));
    }
    return events;
  }

  #assertBufferLimit() {
    if (this.buffer.length <= this.maxBufferedChars) return;
    throw agySseError(
      "PRIVACYAI_AGY_SSE_BUFFER_LIMIT",
      "PrivacyAI blocked an oversized incomplete AGY SSE frame."
    );
  }
}

function withoutFinishReasons(event) {
  const output = structuredClone(event);
  for (const candidate of output.response?.candidates || []) delete candidate.finishReason;
  return output;
}

function finishOnlyEvent(event) {
  const output = structuredClone(event);
  const candidates = output.response?.candidates;
  if (!Array.isArray(candidates)) return output;
  output.response.candidates = candidates
    .filter(candidate => candidate?.finishReason != null)
    .map(candidate => ({
      ...candidate,
      content: {
        role: candidate.content?.role || "model",
        parts: [{ text: "" }]
      }
    }));
  return output;
}

function hasCandidatePayload(event) {
  return (event.response?.candidates || []).some(candidate =>
    (candidate.content?.parts || []).some(part =>
      typeof part.text === "string"
        ? part.text.length > 0
        : part.functionCall != null || part.functionResponse != null
    )
  );
}

function createTextFlushEvent(template, candidateIndex, partIndex, text) {
  const event = structuredClone(template);
  const candidate = event.response?.candidates?.[candidateIndex];
  const content = candidate?.content;
  const part = content?.parts?.[partIndex];
  if (!candidate || !content || !part || typeof part.text !== "string") {
    throw agySseError(
      "PRIVACYAI_AGY_INVALID_SSE",
      "PrivacyAI could not flush an AGY text stream safely."
    );
  }

  candidate.content = {
    ...content,
    parts: [{ ...part, text }]
  };
  delete candidate.finishReason;
  event.response = {
    ...event.response,
    candidates: [candidate]
  };
  return event;
}

export function restoreAgySseEvent(event, sessionMap = {}) {
  const restorer = new AgySseRestorer(sessionMap);
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  return [
    ...restorer.write(Buffer.from(frame)),
    ...restorer.end()
  ].map(serialized => {
    const parsed = parseFrame(serialized.trimEnd());
    return JSON.parse(parsed.data);
  });
}

function validateFunctionCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agySseError("PRIVACYAI_AGY_INVALID_TOOL_CALL", "AGY function call must be an object.");
  }
  if (typeof value.name !== "string" || !value.args || typeof value.args !== "object" || Array.isArray(value.args)) {
    throw agySseError("PRIVACYAI_AGY_INVALID_TOOL_CALL", "AGY function call is malformed.");
  }
}

function validateFunctionResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agySseError("PRIVACYAI_AGY_INVALID_TOOL_RESPONSE", "AGY function response must be an object.");
  }
  if (
    typeof value.name !== "string" ||
    !value.response ||
    typeof value.response !== "object" ||
    Array.isArray(value.response)
  ) {
    throw agySseError("PRIVACYAI_AGY_INVALID_TOOL_RESPONSE", "AGY function response is malformed.");
  }
}

function assertResolvedToolPayload(value, code) {
  if (findUnresolvedPlaceholders(value, AGY_PRIVATE_PLACEHOLDER_PATTERN).length === 0) return;
  throw agySseError(
    code,
    "PrivacyAI blocked an unresolved private AGY tool payload."
  );
}

function hasFinishReason(event) {
  return Array.isArray(event?.response?.candidates) &&
    event.response.candidates.some(candidate => candidate?.finishReason != null);
}

function parseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const dataLines = [];
  const otherLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else otherLines.push(line);
  }
  return {
    data: dataLines.length > 0 ? dataLines.join("\n") : null,
    otherLines
  };
}

function serializeFrame(parsed, data) {
  const lines = [...parsed.otherLines.filter(line => line !== ""), `data: ${data}`];
  return `${lines.join("\n")}\n\n`;
}

function nextBoundary(buffer) {
  const unix = buffer.indexOf("\n\n");
  const windows = buffer.indexOf("\r\n\r\n");
  if (unix < 0 && windows < 0) return null;
  if (windows >= 0 && (unix < 0 || windows < unix)) return { index: windows, length: 4 };
  return { index: unix, length: 2 };
}

function agySseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
