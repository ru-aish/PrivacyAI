import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, sep } from "node:path";

export async function createLocalRegistry(options) {
  const repositoryRoot = options.repositoryRoot;
  const storageRoot = options.storageRoot;
  const catalog = await discoverInstalledPackages(repositoryRoot);
  for (const release of options.releases || []) addCatalogEntry(catalog, release);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });

  const tarballsByKey = new Map();
  const requests = [];
  let baseURL = null;

  const server = createServer(async (request, response) => {
    try {
      requests.push({ method: request.method, path: request.url });
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }

      const url = new URL(request.url, baseURL || "http://127.0.0.1");
      if (url.pathname.startsWith("/tarballs/")) {
        const key = url.pathname.slice("/tarballs/".length).replace(/\.tgz$/, "");
        const entry = tarballsByKey.get(key);
        if (!entry) {
          sendJson(response, 404, { error: "tarball_not_found" });
          return;
        }
        const tarball = await ensureTarball(entry, storageRoot);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": (await stat(tarball.path)).size,
          "cache-control": "no-store"
        });
        createReadStream(tarball.path).pipe(response);
        return;
      }

      const name = decodeURIComponent(url.pathname.slice(1));
      const versions = catalog.get(name);
      if (!versions) {
        sendJson(response, 404, { error: "package_not_found" });
        return;
      }

      const versionEntries = [...versions.values()];
      const manifests = {};
      for (const entry of versionEntries) {
        const tarball = await ensureTarball(entry, storageRoot);
        tarballsByKey.set(entry.key, entry);
        manifests[entry.manifest.version] = {
          ...entry.manifest,
          dist: {
            tarball: `${baseURL}/tarballs/${entry.key}.tgz`,
            shasum: tarball.sha1,
            integrity: `sha512-${tarball.sha512}`
          }
        };
      }
      const latest = versionEntries
        .map(entry => entry.manifest.version)
        .sort(compareVersions)
        .at(-1);
      sendJson(response, 200, {
        name,
        "dist-tags": { latest },
        versions: manifests
      });
    } catch (error) {
      sendJson(response, 500, { error: "registry_failure" });
      options.onError?.(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseURL = `http://127.0.0.1:${address.port}`;

  return {
    url: baseURL,
    requests,
    packageCount: [...catalog.values()].reduce((count, versions) => count + versions.size, 0),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function discoverInstalledPackages(repositoryRoot) {
  const storeRoot = join(repositoryRoot, "node_modules", ".pnpm");
  const catalog = new Map();
  const storeEntries = await readdir(storeRoot, { withFileTypes: true });
  for (const storeEntry of storeEntries) {
    if (!storeEntry.isDirectory()) continue;
    const modulesRoot = join(storeRoot, storeEntry.name, "node_modules");
    let candidates;
    try {
      candidates = await readdir(modulesRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const candidate of candidates) {
      if (!candidate.isDirectory() && !candidate.isSymbolicLink()) continue;
      if (candidate.name.startsWith("@")) {
        const scopeRoot = join(modulesRoot, candidate.name);
        for (const scoped of await readdir(scopeRoot, { withFileTypes: true })) {
          if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
          await addDirectoryPackage(catalog, join(scopeRoot, scoped.name));
        }
      } else {
        await addDirectoryPackage(catalog, join(modulesRoot, candidate.name));
      }
    }
  }
  return catalog;
}

async function addDirectoryPackage(catalog, directory) {
  const manifestPath = join(directory, "package.json");
  try {
    await access(manifestPath);
  } catch {
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
  addCatalogEntry(catalog, { manifest, directory: await realpath(directory) });
}

function addCatalogEntry(catalog, input) {
  const manifest = structuredClone(input.manifest);
  const key = createHash("sha256")
    .update(`${manifest.name}\0${manifest.version}`)
    .digest("hex")
    .slice(0, 32);
  const versions = catalog.get(manifest.name) || new Map();
  versions.set(manifest.version, {
    key,
    manifest,
    directory: input.directory || null,
    sourceTarball: input.tarball || null,
    tarballPromise: null
  });
  catalog.set(manifest.name, versions);
}

async function ensureTarball(entry, storageRoot) {
  if (entry.tarballPromise) return entry.tarballPromise;
  entry.tarballPromise = (async () => {
    const path = entry.sourceTarball || await packDirectory(entry, storageRoot);
    const bytes = await readFile(path);
    return {
      path,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("base64")
    };
  })();
  return entry.tarballPromise;
}

async function packDirectory(entry, storageRoot) {
  if (!entry.directory) throw new Error("Registry entry has no package directory or tarball.");
  const destination = join(storageRoot, entry.key);
  const stage = join(destination, "stage");
  const packageRoot = join(stage, "package");
  const tarball = join(destination, `${entry.key}.tgz`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await rm(stage, { recursive: true, force: true });
  await cp(entry.directory, packageRoot, {
    recursive: true,
    filter(source) {
      const path = relative(entry.directory, source);
      return path === "" || !path.split(sep).includes("node_modules");
    }
  });
  const result = await runProcess("tar", ["-czf", tarball, "-C", stage, "package"]);
  await rm(stage, { recursive: true, force: true });
  if (result.code !== 0) {
    throw new Error(`Could not archive local dependency ${entry.manifest.name}.`);
  }
  return tarball;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: options.env || registryProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function registryProcessEnvironment() {
  const env = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return env;
}

function compareVersions(left, right) {
  const a = String(left).split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part);
  const b = String(right).split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  response.end(body);
}
