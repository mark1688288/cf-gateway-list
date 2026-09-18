import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (parent of src/). */
export const repoRoot = resolve(here, "..");

/** Resolve a user path against the repo root. Absolute paths pass through. */
export function resolveFromRepo(userPath: string): string {
  return resolve(repoRoot, userPath);
}

/** Snapshot dir. GATEWAY_LIST_SNAPSHOTS isolates tests from repo snapshots/. */
export function defaultSnapshotsDir(): string {
  const fromEnv = process.env.GATEWAY_LIST_SNAPSHOTS?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolveFromRepo("snapshots");
}
