import { randomBytes } from "node:crypto";

import { restoreValue } from "@privacy-ai/sdk";

import { createAgyImageSanitizer } from "./agy-image-adapter.js";
import {
  agySessionKey,
  normalizeAgySessionMap,
  sanitizeAgyRequestBody
} from "./agy-request-transform.js";
import {
  openContextVerificationStore,
  updateRepositoryThread,
  verificationFingerprint
} from "./context-verification-store.js";
import {
  commitHookFileMutation,
  stageHookFileMutation
} from "./hook-file-mutation.js";
import {
  KeyedSerialQueue,
  commitVerificationWrites,
  mergeSessionMaps,
  sessionMapsEqual,
  sessionVerificationCache
} from "./model-session-state.js";
import { SessionVault } from "./session-vault.js";
import { recordLineageBestEffort } from "./lineage/recorder.js";
import {
  openInstallationPrivacyIdentity,
  privacyIdentityMetadata,
  sessionPrivacyIdentity
} from "./privacy-identity.js";

export async function createAgySessionController(options = {}) {
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("AGY session controller requires a local sanitizer function.");
  }

  const identityRoot = await openInstallationPrivacyIdentity(options);
  const vault = options.vault || new SessionVault({ ...options, identityRoot });
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
    identityRoot,
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
      const privacyIdentity = sessionPrivacyIdentity(context.identityRoot, sessionKey);
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
          ),
          privacyIdentity
        );
        await commitAgyMutationHistory(body, sessionKey, sessionMap, context);
        const cache = sessionVerificationCache(context, sessionKey);
        const result = await sanitizeAgyRequestBody(body, {
          sanitizer: context.sanitizer,
          imageSanitizer: context.imageSanitizer,
          identity: privacyIdentity,
          identityRoot: context.identityRoot,
          sessionMap,
          cache,
          policyFingerprint: context.policyFingerprint,
          maxContextChars: context.maxContextChars,
          maxContextTokens: context.maxContextTokens,
          tokenCounter: context.tokenCounter,
          maxImagesPerRequest: context.maxImagesPerRequest,
          fallbackSessionId: requestOptions.fallbackSessionId,
          signal: requestOptions.signal,
          onBatchComplete: context.onSanitizerBatchComplete,
          onArtifactComplete: context.onSanitizerArtifactComplete
        });
        const candidateMap = mergeAgySessionMaps(sessionMap, result.sessionMapAdditions);
        const lineageHandle = await recordLineageBestEffort(context.lineageRecorder, "protectedRequest", {
          sessionKey, provider: "antigravity", operation: "generate_content",
          placeholders: Object.keys(candidateMap), cacheActivity: { hits: result.metrics?.cacheHitCount, misses: result.metrics?.uncachedSlotCount, writes: result.cacheWrites.length }, signal: requestOptions.signal
        });
        throwIfAborted(requestOptions.signal);

        let completeMap = candidateMap;
        if (!sessionMapsEqual(currentVault?.sessionMap || {}, candidateMap)) {
          const persisted = await context.vault.update(sessionKey, latest =>
            mergeAgySessionMaps(latest.sessionMap, candidateMap)
          );
          completeMap = persisted.sessionMap;
        }
        await updateRepositoryThread(context.verificationStore, sessionKey, () => ({
          baseSessionMap: currentThread.sessionMap || {},
          parentSessionKeys: [],
          sessionMap: completeMap,
          policyFingerprint: context.policyFingerprint,
          ...privacyIdentityMetadata(privacyIdentity, completeMap)
        }));
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
        return { body: result.body, sessionKey, sessionMap: completeMap, lineageHandle };
      }));
    },
    async stageToolCalls(sessionKey, calls) {
      assertOpen();
      if (!Array.isArray(calls) || calls.length === 0) return { stagedCount: 0 };
      return trackOperation(context.serial.run(sessionKey, async () => {
        const [vaultRecord, threadRecord] = await Promise.all([
          context.vault.load(sessionKey),
          Promise.resolve(context.verificationStore.loadThread(sessionKey))
        ]);
        const sessionMap = mergeAgySessionMaps(
          vaultRecord?.sessionMap || {},
          threadRecord.sessionMap || {}
        );
        let stagedCount = 0;
        const results = [];
        for (const call of calls) {
          const event = agyToolMutationEvent(call, sessionKey, context.cwd);
          if (!event) continue;
          try {
            const result = await stageHookFileMutation(event, {
              store: context.verificationStore,
              sessionMap,
              policyFingerprint: context.policyFingerprint,
              cwd: context.cwd
            });
            results.push(result);
            stagedCount += result.stagedCount || 0;
          } catch {
            // Unsupported or unprovable writes remain ordinary cache misses.
          }
        }
        return { stagedCount, results };
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

async function commitAgyMutationHistory(body, sessionKey, sessionMap, context) {
  if (!context.cwd || !Array.isArray(body?.request?.contents)) return;
  const calls = new Map();
  const completed = new Set();
  for (const content of body.request.contents) {
    for (const part of content?.parts || []) {
      const call = part?.functionCall;
      if (call && typeof call.id === "string" && call.id) {
        calls.set(call.id, call);
      }
      const response = part?.functionResponse;
      if (response && typeof response.id === "string" && response.id) {
        completed.add(response.id);
      }
    }
  }

  for (const callId of completed) {
    const event = agyToolMutationEvent(calls.get(callId), sessionKey, context.cwd, sessionMap);
    if (!event) continue;
    try {
      await commitHookFileMutation(event, {
        store: context.verificationStore,
        sessionMap,
        policyFingerprint: context.policyFingerprint,
        cwd: context.cwd
      });
    } catch {
      // A failed filesystem proof remains a cache miss; sanitization continues.
    }
  }
}

function agyToolMutationEvent(call, sessionKey, cwd, sessionMap = {}) {
  if (
    !call ||
    typeof call !== "object" ||
    typeof call.id !== "string" ||
    call.id.length === 0 ||
    typeof call.name !== "string" ||
    call.name.length === 0 ||
    !call.args ||
    typeof call.args !== "object" ||
    Array.isArray(call.args)
  ) {
    return null;
  }
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionKey,
    tool_use_id: call.id,
    tool_name: restoreValue(call.name, sessionMap),
    cwd,
    tool_input: restoreValue(call.args, sessionMap)
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
