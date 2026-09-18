import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { defaultSnapshotsDir } from "../paths.ts";
import { loadDesiredSnapshot, SnapshotError } from "../snapshot.ts";
import type { DroppedSnapshot } from "../types.ts";
import { renderWhy } from "../why.ts";

export type WhyOptions = {
  domain: string;
  configPath?: string;
  snapshotsDir?: string;
};

async function loadDropped(dir: string): Promise<DroppedSnapshot | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "dropped.json"), "utf8"));
    if (typeof raw !== "object" || raw === null || !("dropped" in raw)) return null;
    return raw as DroppedSnapshot;
  } catch {
    return null;
  }
}

export async function whyCommand(options: WhyOptions): Promise<number> {
  const query = options.domain.trim();
  if (!query) {
    console.error("usage: node src/cli.ts why <domain>");
    return 1;
  }
  try {
    const config = await loadConfig(options.configPath ?? "config.yaml");
    const snapshotsDir = options.snapshotsDir ?? defaultSnapshotsDir();
    const desired = await loadDesiredSnapshot(snapshotsDir);
    const dropped = await loadDropped(snapshotsDir);
    process.stdout.write(
      renderWhy({
        query,
        desired,
        dropped: dropped?.dropped,
        policies: config.policies,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof SnapshotError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
