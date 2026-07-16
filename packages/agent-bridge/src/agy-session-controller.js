import { randomBytes } from "node:crypto";

import {
  agySessionKey,
  normalizeAgySessionMap,
  sanitizeAgyRequestBody
} from "./agy-request-transform.js";
import {
  openContextVerificationStore,
  verificationFingerprint
} from "./context-verification-store.js";
import {
  KeyedSerialQueue,
  commitVerificationWrites,
  mergeSessionMaps,
  sessionMapsEqual,
  sessionVerificationCache
} from "./model-session-state.js";
import { SessionVault } from "./session-vault.js";

export async function createAgySessionController(options = {}) {
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("AGY session controller requires a local sanitizer function.");
  }

  const vault = options.vault || new SessionVault(options);
  const verificationStore = await openContextVerificationStore(options);
  const ownsVerificationStore = !options.verificationStore;
  const sanitizerFingerprint = options.policyFingerprint || options.sanitizer.identity?.fingerprint;
  const policyFingerprint = verificationFingerprint({
    boundary: "agy-transport",
    version: 2,
    sanitizerFingerprint: sanitizerFingerprint || null,
    ephemeralSanitizerNonce: sanitizerFingerprint
      ? null
      : randomBytes(32).toString("hex")
  });
  const serial = new KeyedSerialQueue();
  const sessionCaches = new Map();
  const context = {
    ...options,
    vault,
    verificationStore,
    policyFingerprint,
    serial,
    sessionCaches,
    requestCount: 0
  };
  let closed = false;

  return {
    policyFingerprint,
    async transform(body, requestOptions = {}) {
      if (closed) throw controllerError("PRIVACYAI_AGY_CONTROLLER_CLOSED", "AGY session controller is closed.");
      const sessionKey = agySessionKey(body, requestOptions.fallbackSessionId);

      return context.serial.run(sessionKey, async () => {
        throwIfAborted(requestOptions.signal);
        const [currentVault, currentThread] = await Promise.all([
          context.vault.load(sessionKey),
          Promise.resolve(context.verificationStore.loadThread(sessionKey))
        ]);
        const sessionMap = normalizeAgySessionMap(
          body,
          mergeAgySessionMaps(
            currentVault?.sessionMap || {},
            currentThread.sessionMap || {}
          )
        );
        const cache = sessionVerificationCache(context, sessionKey);
        const result = await sanitizeAgyRequestBody(body, {
          sanitizer: context.sanitizer,
          sessionMap,
          cache,
          policyFingerprint: context.policyFingerprint,
          maxContextChars: context.maxContextChars,
          fallbackSessionId: requestOptions.fallbackSessionId,
          signal: requestOptions.signal,
          onBatchComplete: context.onSanitizerBatchComplete,
          onArtifactComplete: context.onSanitizerArtifactComplete
        });
        throwIfAborted(requestOptions.signal);

        const candidateMap = mergeAgySessionMaps(sessionMap, result.sessionMapAdditions);
        let completeMap = candidateMap;
        if (!sessionMapsEqual(currentVault?.sessionMap || {}, candidateMap)) {
          const persisted = await context.vault.update(sessionKey, latest =>
            mergeAgySessionMaps(latest.sessionMap, candidateMap)
          );
          completeMap = persisted.sessionMap;
        }
        context.verificationStore.saveThread(sessionKey, {
          parentSessionKeys: [],
          sessionMap: completeMap,
          policyFingerprint: context.policyFingerprint
        });
        commitVerificationWrites(cache, result.cacheWrites, {
          maxEntries: context.maxCacheEntriesPerSession,
          verificationStore: context.verificationStore
        });
        for (const item of result.itemRecords || []) {
          context.verificationStore.recordThreadItem({ ...item, sessionKey });
        }
        context.requestCount += 1;
        if (context.requestCount % 100 === 0) context.verificationStore.prune();
        if (typeof context.onSanitizedRequest === "function") {
          await context.onSanitizedRequest(result.body, { sessionKey });
        }
        return { body: result.body, sessionKey, sessionMap: completeMap };
      });
    },
    async loadSessionMap(sessionKey) {
      if (closed) throw controllerError("PRIVACYAI_AGY_CONTROLLER_CLOSED", "AGY session controller is closed.");
      const [vaultRecord, threadRecord] = await Promise.all([
        vault.load(sessionKey),
        Promise.resolve(verificationStore.loadThread(sessionKey))
      ]);
      return mergeAgySessionMaps(vaultRecord.sessionMap, threadRecord.sessionMap);
    },
    close() {
      if (closed) return;
      closed = true;
      sessionCaches.clear();
      if (ownsVerificationStore) verificationStore.close();
    }
  };
}

function mergeAgySessionMaps(current, inherited) {
  return mergeSessionMaps(current, inherited, {
    collisionError: kind => controllerError(
      "PRIVACYAI_AGY_SESSION_MAP_COLLISION",
      kind === "placeholder"
        ? "PrivacyAI blocked an ambiguous AGY placeholder mapping."
        : "PrivacyAI blocked an ambiguous AGY private-value mapping."
    )
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI stopped the AGY request because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_AGY_REQUEST_ABORTED";
  throw error;
}

function controllerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
