export async function runCleanupSteps(steps, options = {}) {
  const errors = [];
  for (const step of steps || []) {
    if (typeof step?.run !== "function") continue;
    try {
      await step.run();
    } catch (error) {
      errors.push({ name: step.name || "cleanup", error });
    }
  }

  if (errors.length === 0) return;
  const cleanupErrors = errors.map(entry => entry.error);
  if (options.primaryError) {
    attachCleanupErrors(options.primaryError, errors);
    return;
  }
  throwCleanupErrors(
    cleanupErrors,
    options.message || "PrivacyAI could not fully clean up its runtime resources."
  );
}

export async function closeResourcesAfterFailure(resources, primaryError, message) {
  const results = await Promise.allSettled((resources || []).map(async resource => {
    if (typeof resource?.close === "function") await resource.close();
  }));
  const cleanupErrors = results
    .filter(result => result.status === "rejected")
    .map(result => result.reason);
  if (cleanupErrors.length === 0) throw primaryError;
  throw new AggregateError(
    [primaryError, ...cleanupErrors],
    message,
    { cause: primaryError }
  );
}

export function createRetryableResourceCloser(resources, message) {
  const pending = new Set((resources || []).filter(resource => typeof resource?.close === "function"));
  let closePromise = null;

  return function close() {
    if (pending.size === 0) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = closePendingResources(pending, message).finally(() => {
      closePromise = null;
    });
    return closePromise;
  };
}

async function closePendingResources(pending, message) {
  const errors = [];
  for (const resource of [...pending]) {
    try {
      await resource.close();
      pending.delete(resource);
    } catch (error) {
      errors.push(error);
    }
  }
  throwCleanupErrors(errors, message);
}

function throwCleanupErrors(errors, message) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message, { cause: errors[0] });
}

function attachCleanupErrors(primaryError, errors) {
  if (!primaryError || (typeof primaryError !== "object" && typeof primaryError !== "function")) return;
  try {
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: errors.map(entry => ({ name: entry.name, error: entry.error }))
    });
  } catch {
    // Cleanup metadata is diagnostic only and must never replace the primary error.
  }
}
