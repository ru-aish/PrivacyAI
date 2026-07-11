export async function checkPrivacyModel(config, options = {}) {
  if (options.skip || process.env.PRIVACYAI_SKIP_MODEL_CHECK === "1") {
    return { ok: true, skipped: true };
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "Node.js does not provide fetch()." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 3000);

  try {
    if (config.provider === "ollama") {
      const baseURL = config.baseURL.replace(/\/v1$/, "");
      const response = await fetchImpl(`${baseURL}/api/tags`, { signal: controller.signal });
      if (!response.ok) return { ok: false, reason: `Ollama returned HTTP ${response.status}.` };
      const body = await response.json();
      const models = Array.isArray(body?.models) ? body.models : [];
      const found = models.some(item => item?.name === config.model || item?.model === config.model);
      return found
        ? { ok: true }
        : { ok: false, reason: `Local model ${config.model} is not downloaded.` };
    }

    const response = await fetchImpl(`${config.baseURL}/models`, {
      headers: { authorization: `Bearer ${config.apiKey || "not-required"}` },
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, reason: `Model server returned HTTP ${response.status}.` };
    const body = await response.json();
    const found = Array.isArray(body?.data) && body.data.some(item => item?.id === config.model);
    return found
      ? { ok: true }
      : { ok: false, reason: `Local model ${config.model} is not available.` };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, reason: "The local privacy model did not respond in time." };
    }
    return { ok: false, reason: "The local privacy model is not reachable." };
  } finally {
    clearTimeout(timer);
  }
}
