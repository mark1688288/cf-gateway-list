import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CloudflareApiError, createCfClient } from "../cf-client.ts";
import { loadConfig } from "../config.ts";
import { CredentialsError, loadCloudflareCredentials } from "../env.ts";
import {
  buildSuggestedSnapshot,
  fetchBlockedDns,
  isAnalyticsUnavailable,
  pickSuggestions,
  rankBlockedDomains,
  renderSuggestedTxt,
  unavailableSnapshot,
  utcWindow,
  writeSuggestedSnapshot,
} from "../gateway-logs.ts";
import { domainValues, readLocalList } from "../list-file.ts";
import { defaultSnapshotsDir, resolveFromRepo } from "../paths.ts";

export type SuggestedOptions = {
  configPath: string;
  snapshotsDir?: string;
  suggestedPath?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  loadFile?: boolean;
  now?: Date;
};

async function domainsFromPathSources(
  sources: Array<{ path?: string; id: string }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const source of sources) {
    if (!source.path) continue;
    try {
      for (const domain of domainValues(await readLocalList(source.path, source.id))) {
        out.add(domain);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`suggested: cannot read ${source.path}: ${message}`);
    }
  }
  return out;
}

export async function suggestedCommand(options: SuggestedOptions): Promise<number> {
  const config = await loadConfig(options.configPath);
  const snapshotsDir = options.snapshotsDir ?? defaultSnapshotsDir();
  const suggestedPath = options.suggestedPath ?? resolveFromRepo("allowlist/suggested.txt");
  const generatedAt = (options.now ?? new Date()).toISOString();

  let creds;
  try {
    creds = await loadCloudflareCredentials({
      env: options.env,
      envPath: options.envPath,
      loadFile: options.loadFile,
    });
  } catch (error) {
    if (error instanceof CredentialsError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }

  const allow = await domainsFromPathSources(config.sources.allow);
  const personalBlock = await domainsFromPathSources(config.sources.block.filter((row) => row.path));

  try {
    const client = createCfClient({
      ...creds,
      fetch: options.fetch,
      sleep: options.sleep,
    });
    const fetched = await fetchBlockedDns(client, { now: options.now });
    const ranked = rankBlockedDomains(fetched.rows);
    const { suggested, skipped } = pickSuggestions(ranked, allow, personalBlock);
    const snapshot = buildSuggestedSnapshot({
      generatedAt,
      window: fetched.window,
      ranked,
      suggested,
      skipped,
      warning: fetched.note,
    });

    await writeSuggestedSnapshot(snapshotsDir, snapshot);
    await mkdir(dirname(suggestedPath), { recursive: true });
    await writeFile(suggestedPath, renderSuggestedTxt(snapshot), "utf8");

    console.log("suggested");
    console.log(`  window:     ${snapshot.window.start} → ${snapshot.window.end}`);
    console.log(`  status:     ${snapshot.status}`);
    if (snapshot.warning) console.log(`  warning:    ${snapshot.warning}`);
    console.log(`  blocked:    ${snapshot.blocked.length} domain(s)`);
    console.log(`  suggested:  ${snapshot.suggested.length} (not on personal allow/block)`);
    console.log(`  skipped:    ${snapshot.skipped.length}`);
    for (const row of snapshot.suggested.slice(0, 10)) {
      console.log(`    ${row.count}\t${row.domain}`);
    }
    if (snapshot.suggested.length > 10) {
      console.log(`    … ${snapshot.suggested.length - 10} more`);
    }
    console.log("  wrote:      allowlist/suggested.txt snapshots/suggested.json");
    return 0;
  } catch (error) {
    if (isAnalyticsUnavailable(error)) {
      const message = error instanceof Error ? error.message : String(error);
      const window = utcWindow(options.now ?? new Date(), 7);
      const snapshot = unavailableSnapshot(generatedAt, window, message);
      await writeSuggestedSnapshot(snapshotsDir, snapshot);
      console.log("suggested");
      console.log("  status:     unavailable");
      console.log(`  warning:    ${message}`);
      console.log("  wrote:      snapshots/suggested.json (left allowlist/suggested.txt unchanged)");
      return 0;
    }
    if (error instanceof CloudflareApiError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
