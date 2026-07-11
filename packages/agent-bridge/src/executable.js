import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

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
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}
