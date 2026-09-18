import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAccountQuotaSnapshot } from "../account-quota.ts";
import { loadConfig } from "../config.ts";
import { defaultSnapshotsDir } from "../paths.ts";
import { loadDesiredSnapshot, SnapshotError } from "../snapshot.ts";
import { loadSuggestedSnapshot } from "../gateway-logs.ts";
import { loadSourcesSnapshot } from "../source-integrity.ts";
import { renderCompileSummary } from "../summary.ts";
import type { DroppedSnapshot } from "../types.ts";

export type SummaryOptions = {
  configPath: string;
  snapshotsDir?: string;
  previousDir?: string;
  githubSummaryPath?: string;
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

export async function summaryCommand(options: SummaryOptions): Promise<number> {
  try {
    const config = await loadConfig(options.configPath);
    const snapshotsDir = options.snapshotsDir ?? defaultSnapshotsDir();
    const previousDir = options.previousDir ?? join(snapshotsDir, "previous");
    const current = await loadDesiredSnapshot(snapshotsDir);
    let previous;
    try {
      previous = await loadDesiredSnapshot(previousDir);
    } catch (error) {
      if (error instanceof SnapshotError) previous = undefined;
      else throw error;
    }
    const markdown = renderCompileSummary({
      current,
      previous,
      sources: await loadSourcesSnapshot(snapshotsDir),
      dropped: await loadDropped(snapshotsDir),
      maxItems: config.plan.maxItems,
      itemsPerList: config.plan.itemsPerList,
      maxLists: config.plan.maxLists,
      accountQuota: await loadAccountQuotaSnapshot(snapshotsDir),
      suggested: await loadSuggestedSnapshot(snapshotsDir),
    });

    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(join(snapshotsDir, "summary.md"), markdown, "utf8");
    process.stdout.write(markdown);

    const ghPath = options.githubSummaryPath ?? process.env.GITHUB_STEP_SUMMARY;
    if (ghPath) {
      await appendFile(ghPath, markdown, "utf8");
    }
    return 0;
  } catch (error) {
    if (error instanceof SnapshotError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
