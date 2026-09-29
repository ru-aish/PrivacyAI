import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem"
];

export async function createEphemeralTlsAuthority(hostname, options = {}) {
  validateHostname(hostname);
  const runtimeRoot = resolve(options.runtimeDir || options.tmpDir || tmpdir());
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const runtimeDir = await mkdtemp(join(runtimeRoot, "privacyai-agy-tls-"));
  await chmod(runtimeDir, 0o700);
  const removeRuntimeDir = options.removeRuntimeDir || rm;

  const paths = {
    caKey: join(runtimeDir, "ca.key"),
    caCert: join(runtimeDir, "ca.pem"),
    caSerial: join(runtimeDir, "ca.srl"),
    leafKey: join(runtimeDir, "leaf.key"),
    leafCsr: join(runtimeDir, "leaf.csr"),
    leafCert: join(runtimeDir, "leaf.pem"),
    caConfig: join(runtimeDir, "ca.cnf"),
    leafConfig: join(runtimeDir, "leaf.cnf"),
    trustBundle: join(runtimeDir, "trust-bundle.pem")
  };

  const runOpenSsl = options.runOpenSsl || defaultOpenSslRunner(options.opensslPath || "openssl");
  let closed = false;
  let closePromise = null;
  try {
    await writeFile(paths.caConfig, caConfig(), { mode: 0o600 });
    await writeFile(paths.leafConfig, leafConfig(hostname), { mode: 0o600 });

    await runOpenSsl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", paths.caKey,
      "-out", paths.caCert,
      "-days", "1",
      "-config", paths.caConfig,
      "-extensions", "ca_ext"
    ]);
    await runOpenSsl([
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", paths.leafKey,
      "-out", paths.leafCsr,
      "-config", paths.leafConfig
    ]);
    await runOpenSsl([
      "x509", "-req",
      "-in", paths.leafCsr,
      "-CA", paths.caCert,
      "-CAkey", paths.caKey,
      "-CAcreateserial",
      "-out", paths.leafCert,
      "-days", "1",
      "-extfile", paths.leafConfig,
      "-extensions", "leaf_ext"
    ]);

    for (const path of [paths.caKey, paths.caCert, paths.leafKey, paths.leafCert]) {
      await chmod(path, 0o600);
    }

    const systemBundlePath = await resolveSystemCaBundle(options);
    const [systemBundle, caCertificate, leafCertificate, leafPrivateKey] = await Promise.all([
      readFile(systemBundlePath),
      readFile(paths.caCert),
      readFile(paths.leafCert),
      readFile(paths.leafKey)
    ]);
    await writeFile(
      paths.trustBundle,
      Buffer.concat([systemBundle, Buffer.from("\n"), caCertificate, Buffer.from("\n")]),
      { mode: 0o600 }
    );

    // The session needs the signed leaf key, not the authority key. Deleting the
    // CA key immediately prevents the running proxy from minting more trusted
    // certificates after startup.
    await Promise.all([
      rm(paths.caKey, { force: true }),
      rm(paths.caSerial, { force: true }),
      rm(paths.leafCsr, { force: true }),
      rm(paths.caConfig, { force: true }),
      rm(paths.leafConfig, { force: true })
    ]);

    return {
      hostname,
      runtimeDir,
      caCertificate,
      leafCertificate,
      leafPrivateKey,
      trustBundlePath: paths.trustBundle,
      close() {
        if (closed) return Promise.resolve();
        if (closePromise) return closePromise;
        closePromise = Promise.resolve()
          .then(() => removeRuntimeDir(runtimeDir, { recursive: true, force: true }))
          .then(() => {
            closed = true;
          })
          .finally(() => {
            closePromise = null;
          });
        return closePromise;
      }
    };
  } catch (error) {
    try {
      await removeRuntimeDir(runtimeDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PrivacyAI could not create or fully clean up the temporary AGY transport certificate.",
        { cause: error }
      );
    }
    throw tlsError(
      "PRIVACYAI_AGY_TLS_SETUP_FAILED",
      "PrivacyAI could not create the temporary AGY transport certificate.",
      error
    );
  }
}

async function resolveSystemCaBundle(options) {
  const baseEnv = options.baseEnv || {};
  const explicit = options.systemCaBundle ||
    baseEnv.PRIVACYAI_SYSTEM_CA_BUNDLE ||
    process.env.PRIVACYAI_SYSTEM_CA_BUNDLE;
  const candidates = explicit
    ? [explicit]
    : [baseEnv.SSL_CERT_FILE, process.env.SSL_CERT_FILE, ...DEFAULT_CA_BUNDLES];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await readFile(candidate);
      return resolve(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  throw tlsError(
    "PRIVACYAI_AGY_SYSTEM_CA_NOT_FOUND",
    "PrivacyAI could not locate the operating system CA bundle."
  );
}

function defaultOpenSslRunner(executable) {
  return async args => {
    try {
      await execFileAsync(executable, args, {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, RANDFILE: "/dev/null" }
      });
    } catch (error) {
      throw tlsError(
        "PRIVACYAI_AGY_OPENSSL_FAILED",
        "OpenSSL failed while preparing the temporary AGY transport certificate.",
        error
      );
    }
  };
}

function caConfig() {
  return [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = ca_ext",
    "prompt = no",
    "[dn]",
    "CN = PrivacyAI AGY Session CA",
    "[ca_ext]",
    "basicConstraints = critical,CA:TRUE,pathlen:0",
    "keyUsage = critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid:always,issuer"
  ].join("\n") + "\n";
}

function leafConfig(hostname) {
  return [
    "[req]",
    "distinguished_name = dn",
    "req_extensions = req_ext",
    "prompt = no",
    "[dn]",
    `CN = ${hostname}`,
    "[req_ext]",
    `subjectAltName = DNS:${hostname}`,
    "[leaf_ext]",
    "basicConstraints = critical,CA:FALSE",
    "keyUsage = critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = DNS:${hostname}`,
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid,issuer"
  ].join("\n") + "\n";
}

function validateHostname(hostname) {
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > 253 ||
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(hostname)
  ) {
    throw new TypeError("Ephemeral TLS authority requires a valid DNS hostname.");
  }
}

function tlsError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
