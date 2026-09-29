const DEFAULT_CLOSE_TIMEOUT_MS = 2000;

export function trackServerSockets(server, sockets = new Set()) {
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

export function listenOnHost(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export function closeHttpServer(server, sockets, options) {
  return closeHttpServers([server], sockets, options);
}

export async function closeHttpServers(servers, sockets = new Set(), options = {}) {
  const timeoutMs = closeTimeout(options.timeoutMs);
  const uniqueServers = [...new Set((servers || []).filter(Boolean))];
  const closing = uniqueServers.map(server => closeOneServer(server, timeoutMs));

  for (const server of uniqueServers) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }
  for (const socket of [...sockets]) socket.destroy();

  await Promise.all(closing);
}

function closeOneServer(server, timeoutMs) {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      const error = new Error("PrivacyAI timed out while closing an owned HTTP server.");
      error.code = "PRIVACYAI_SERVER_CLOSE_TIMEOUT";
      finish(error);
    }, timeoutMs);
    timer.unref?.();

    try {
      server.close(finish);
    } catch (error) {
      finish(error);
    }
  });
}

function closeTimeout(value) {
  const normalized = value == null ? DEFAULT_CLOSE_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > 60_000) {
    throw new TypeError("HTTP server close timeout must be an integer between 1 and 60000 milliseconds.");
  }
  return normalized;
}
