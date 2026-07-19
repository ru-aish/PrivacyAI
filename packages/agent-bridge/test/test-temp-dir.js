import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const roots = new Set();

after(async () => {
  const failures = [];
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  roots.clear();
  if (failures.length > 0) {
    throw new AggregateError(failures, "Could not clean one or more test temporary directories");
  }
});

export async function createTestTempDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}
