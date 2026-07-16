import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export async function resolveExecutable(name, options = {}) {
  if (name.includes("/")) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }

  const pathValue = options.path || process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        if (name === "codex") {
          const native = await resolveCodexNativeBinary(candidate);
          if (native) return native;
        }
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}


async function resolveCodexNativeBinary(entrypoint) {
  if (process.platform !== "linux") return null;
  const target = process.arch === "x64"
    ? ["@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"]
    : process.arch === "arm64"
      ? ["@openai", "codex-linux-arm64", "vendor", "aarch64-unknown-linux-musl", "bin", "codex"]
      : null;
  if (!target) return null;

  let resolved;
  try {
    resolved = await realpath(entrypoint);
  } catch {
    return null;
  }
  const packageRoot = dirname(dirname(resolved));
  const native = join(packageRoot, "node_modules", ...target);
  try {
    await access(native, constants.X_OK);
    return native;
  } catch {
    return null;
  }
}
