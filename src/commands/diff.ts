import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareApiError, createCfClient } from "../cf-client.ts";
import { loadConfig } from "../config.ts";
import {
  desiredDomains,
  diffDomainSets,
  hasDrift,
  isAllowListName,
  isBlockListName,
  liveDomains,
} from "../domain-diff.ts";
import { CredentialsError, loadCloudflareCredentials } from "../env.ts";
import { defaultSnapshotsDir } from "../paths.ts";
import { loadDesiredSnapshot, SnapshotError } from "../snapshot.ts";
import { DESIRED_SNAPSHOT_VERSION, type DiffSnapshot } from "../types.ts";

export type DiffOptions = {
  configPath: string;
  snapshotsDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  loadFile?: boolean;
};

function sample(values: string[], limit = 10): string {
  if (values.length === 0) return "(none)";
  const head = values.slice(0, limit).join(", ");
  return values.length > limit ? `${head}, …` : head;
}

export async function diffCommand(options: DiffOptions): Promise<number> {
  try {
    const config = await loadConfig(options.configPath);
    const snapshotsDir = options.snapshotsDir ?? defaultSnapshotsDir();
    const desired = await loadDesiredSnapshot(snapshotsDir);
    const creds = await loadCloudflareCredentials({
      env: options.env,
      envPath: options.envPath,
      loadFile: options.loadFile,
    });
    const client = createCfClient({
      ...creds,
      fetch: options.fetch,
      sleep: options.sleep,
    });

    const prefix = config.plan.listNamePrefix;
    const lists = await client.ownedLists(prefix);
    const allowLists = lists.filter((row) => isAllowListName(row.name, prefix));
    const blockLists = lists.filter((row) => isBlockListName(row.name, prefix));

    const collect = async (owned: typeof allowLists): Promise<string[]> => {
      const values: string[] = [];
      for (const list of owned) {
        const items = await client.listListItems(list.id);
        values.push(...items.map((item) => item.value));
      }
      return liveDomains(values);
    };

    const liveAllow = await collect(allowLists);
    const liveBlock = await collect(blockLists);
    const allow = diffDomainSets(desiredDomains(desired.allow), liveAllow);
    const block = diffDomainSets(desiredDomains(desired.block), liveBlock);
    const drift = hasDrift(allow, block);
    const generatedAt = new Date().toISOString();

    const snapshot: DiffSnapshot = {
      version: DESIRED_SNAPSHOT_VERSION,
      phase: 5,
      generatedAt,
      desiredGeneratedAt: desired.generatedAt,
      drift,
      allow,
      block,
      counts: {
        toAdd: allow.counts.toAdd + block.counts.toAdd,
        toRemove: allow.counts.toRemove + block.counts.toRemove,
        unchanged: allow.counts.unchanged + block.counts.unchanged,
      },
    };

    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(
      join(snapshotsDir, "diff.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );

    console.log("diff");
    console.log(
      `  desired:   ${desired.allow.length} allow / ${desired.block.length} block (phase ${desired.phase})`,
    );
    console.log(`  live:      ${allowLists.length} allow list(s), ${blockLists.length} block list(s)`);
    console.log(
      `  allow:     +${allow.counts.toAdd} / -${allow.counts.toRemove} / =${allow.counts.unchanged}`,
    );
    console.log(
      `  block:     +${block.counts.toAdd} / -${block.counts.toRemove} / =${block.counts.unchanged}`,
    );
    if (drift) {
      console.log(`  add:       ${sample([...allow.toAdd, ...block.toAdd])}`);
      console.log(`  remove:    ${sample([...allow.toRemove, ...block.toRemove])}`);
    }
    console.log(`  drift:     ${drift ? "yes" : "no"}`);
    console.log("  wrote:     snapshots/diff.json");
    return 0;
  } catch (error) {
    if (error instanceof SnapshotError || error instanceof CredentialsError) {
      console.error(error.message);
      return error.exitCode;
    }
    if (error instanceof CloudflareApiError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
