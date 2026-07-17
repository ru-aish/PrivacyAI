import { randomBytes } from "node:crypto";

import { createAgyImageSanitizer } from "./agy-image-adapter.js";
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
  const imageSanitizer = options.imageSanitizer || createAgyImageSanitizer(options.imageSanitizerOptions);
  const ownsImageSanitizer = !options.imageSanitizer;
  const verificationStore = await openContextVerificationStore(options);
  const ownsVerificationStore = !options.verificationStore;
  const sanitizerFingerprint = options.policyFingerprint || options.sanitizer.identity?.fingerprint;
  const policyFingerprint = verificationFingerprint({
    boundary: "agy-transport",
    version: 3,
    sanitizerFingerprint: sanitizerFingerprint || null,
    ephemeralSanitizerNonce: sanitizerFingerprint
      ? null
      : randomBytes(32).toString("hex")
  });
  const serial = new KeyedSerialQueue();
  const sessionCaches = new Map();
  const activeOperations = new Set();
  const context = {
    ...options,
    vault,
    imageSanitizer,
    verificationStore,
    policyFingerprint,
    serial,
    sessionCaches,
    requestCount: 0
  };
  let state = "open";
  let closePromise = null;
  let imageSanitizerClosed = !ownsImageSanitizer;
  let verificationStoreClosed = !ownsVerificationStore;

  const assertOpen = () => {
    if (state !== "open") {
      throw controllerError("PRIVACYAI_AGY_CONTROLLER_CLOSED", "AGY session controller is closed.");
    }
  };
  const trackOperation = operation => {
    activeOperations.add(operation);
    operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation)
    );
    return operation;
  };

  return {
    policyFingerprint,
    async transform(body, requestOptions = {}) {
      assertOpen();
      const sessionKey = agySessionKey(body, requestOptions.fallbackSessionId);
      return trackOperation(context.serial.run(sessionKey, async () => {
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
          imageSanitizer: context.imageSanitizer,
          sessionMap,
          cache,
          policyFingerprint: context.policyFingerprint,
          maxContextChars: context.maxContextChars,
          maxImagesPerRequest: context.maxImagesPerRequest,
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
      }));
    },
    async loadSessionMap(sessionKey) {
      assertOpen();
      return trackOperation((async () => {
        const [vaultRecord, threadRecord] = await Promise.all([
          vault.load(sessionKey),
          Promise.resolve(verificationStore.loadThread(sessionKey))
        ]);
        return mergeAgySessionMaps(vaultRecord.sessionMap, threadRecord.sessionMap);
      })());
    },
    close() {
      if (state === "closed") return Promise.resolve();
      if (closePromise) return closePromise;
      state = "closing";
      closePromise = (async () => {
        await Promise.allSettled([...activeOperations]);
        sessionCaches.clear();
        const errors = [];
        if (!imageSanitizerClosed && typeof imageSanitizer.close === "function") {
          try {
            await imageSanitizer.close();
            imageSanitizerClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (!verificationStoreClosed) {
          try {
            await Promise.resolve(verificationStore.close());
            verificationStoreClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "PrivacyAI could not fully close the AGY session controller.", {
            cause: errors[0]
          });
        }
        state = "closed";
      })().finally(() => {
        closePromise = null;
      });
      return closePromise;
    }
  };
}

function mergeAgySessionMaps(current, inherited) {
  return mergeSessionMaps(current, inherited, {
    maxAliasesPerOriginal: 8,
    collisionError: kind => controllerError(
      "PRIVACYAI_AGY_SESSION_MAP_COLLISION",
      kind === "placeholder"
        ? "PrivacyAI blocked an ambiguous AGY placeholder mapping."
        : kind === "case"
          ? "PrivacyAI blocked a case-insensitive AGY session-map collision."
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
