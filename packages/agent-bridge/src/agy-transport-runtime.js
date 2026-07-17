import { createAgySessionController } from "./agy-session-controller.js";
import { startAgyTransportProxy } from "./agy-transport-proxy.js";
import { createEphemeralTlsAuthority } from "./ephemeral-tls-authority.js";

const DEFAULT_MODEL_HOST = "daily-cloudcode-pa.googleapis.com";

export async function startAgyTransportRuntime(options = {}) {
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("AGY transport runtime requires a local sanitizer function.");
  }
  assertProxyCompatibility(options.baseEnv || process.env, options);

  const modelHost = String(options.modelHost || DEFAULT_MODEL_HOST);
  const createAuthority = options.createAuthority || createEphemeralTlsAuthority;
  const createController = options.createSessionController || createAgySessionController;
  const startProxy = options.startProxy || startAgyTransportProxy;

  let authority;
  let controller;
  let proxy;
  try {
    authority = await createAuthority(modelHost, options);
    controller = await createController(options);
    proxy = await startProxy({
      ...options,
      modelHost,
      authority,
      sessionController: controller,
      baseEnv: options.baseEnv || process.env
    });
  } catch (error) {
    const cleanupErrors = await collectCloseErrors([proxy, controller, authority]);
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      "PrivacyAI could not start the AGY transport runtime and fully clean up partial resources.",
      { cause: error }
    );
  }

  const pendingResources = new Set([proxy, controller, authority].filter(
    resource => typeof resource?.close === "function"
  ));
  let closePromise = null;
  return {
    modelHost,
    runtimeDir: authority.runtimeDir,
    env: proxy.env,
    proxyURL: proxy.proxyURL,
    close() {
      if (pendingResources.size === 0) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = closePendingResources(pendingResources)
        .finally(() => {
          closePromise = null;
        });
      return closePromise;
    }
  };
}

async function closePendingResources(pendingResources) {
  const errors = [];
  for (const resource of [...pendingResources]) {
    try {
      await resource.close();
      pendingResources.delete(resource);
    } catch (error) {
      errors.push(error);
    }
  }
  throwCloseErrors(errors, "PrivacyAI could not fully close the AGY transport runtime.");
}

async function collectCloseErrors(resources) {
  const results = await Promise.allSettled(resources.map(async resource => {
    if (typeof resource?.close === "function") await resource.close();
  }));
  return results
    .filter(result => result.status === "rejected")
    .map(result => result.reason);
}

function throwCloseErrors(errors, message) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message, { cause: errors[0] });
}

function assertProxyCompatibility(env, options) {
  if (options.allowExistingProxy === true) return;
  const existing = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy
  ].filter(Boolean);
  if (existing.length === 0) return;

  const error = new Error(
    "PrivacyAI AGY transport cannot currently chain through an existing HTTP/SOCKS proxy. " +
    "Unset the proxy for this session or use --privacy-strict."
  );
  error.code = "PRIVACYAI_AGY_EXISTING_PROXY_UNSUPPORTED";
  throw error;
}
