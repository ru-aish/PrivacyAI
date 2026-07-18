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
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    cleanupErrors,
    options.message || "PrivacyAI could not fully clean up its runtime resources.",
    { cause: cleanupErrors[0] }
  );
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
