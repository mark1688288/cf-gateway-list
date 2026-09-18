import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compileMaxItems,
  loadAccountQuotaSnapshot,
  readLiveAccountQuota,
  writeAccountQuotaSnapshot,
} from "../account-quota.ts";
import { CloudflareApiError, createCfClient } from "../cf-client.ts";
import { compileDomains, enumerateDomains, type CompilerSource } from "../compiler.ts";
import { loadConfig } from "../config.ts";
import { CredentialsError, loadCloudflareCredentials } from "../env.ts";
import { fetchText, type FetchTextOptions } from "../fetch-source.ts";
import { readListText } from "../list-file.ts";
import { defaultSnapshotsDir, resolveFromRepo } from "../paths.ts";
import { oneEtag, readValidSourceCache, writeSourceCache } from "../source-cache.ts";
import {
  CompileAbortError,
  countLines,
  loadSourcesSnapshot,
  previousRecord,
  sha256Hex,
  sourceContent,
  sourceShrank,
} from "../source-integrity.ts";
import {
  DESIRED_SNAPSHOT_PHASE,
  DESIRED_SNAPSHOT_VERSION,
  type AccountQuotaSnapshot,
  type Config,
  type DesiredSnapshot,
  type DroppedSnapshot,
  type SourceConfig,
  type SourceRecord,
  type SourcesSnapshot,
} from "../types.ts";

export type CompileOptions = {
  configPath: string;
  snapshotsDir?: string;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  loadFile?: boolean;
} & FetchTextOptions;

export { CompileAbortError } from "../source-integrity.ts";

type LoadedSource = {
  compiler: CompilerSource;
  record: SourceRecord;
  notModified?: boolean;
};

function snapshotsDirectory(options: CompileOptions): string {
  return options.snapshotsDir ?? defaultSnapshotsDir();
}

function okRecord(
  source: SourceConfig,
  text: string,
  parsedDomains: number,
  extra: { etag?: string | null; fetchedAt?: string | null },
  previous: SourceRecord | undefined,
): SourceRecord {
  const sha256 = sha256Hex(text);
  return {
    id: source.id,
    origin: source.url ? "url" : "path",
    path: source.path,
    url: source.url,
    etag: extra.etag ?? null,
    sha256,
    lineCount: countLines(text),
    parsedDomains,
    fetchedAt: extra.fetchedAt ?? null,
    status: "ok",
    content: sourceContent(previous, sha256),
  };
}

function optionalFailedRecord(source: SourceConfig, error: string): SourceRecord {
  return {
    id: source.id,
    origin: source.url ? "url" : "path",
    path: source.path,
    url: source.url,
    etag: null,
    sha256: null,
    lineCount: 0,
    parsedDomains: 0,
    fetchedAt: new Date().toISOString(),
    status: "optional-failed",
    error,
  };
}

async function loadOneSource(
  source: SourceConfig,
  role: "allow" | "block",
  config: Config,
  previous: SourceRecord | undefined,
  options: CompileOptions,
  snapshotsDir: string,
): Promise<LoadedSource | SourceRecord> {
  let text: string;
  let etag: string | null = null;
  let fetchedAt: string | null = null;
  let notModified = false;

  if (source.path) {
    try {
      text = await readListText(source.path, source.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!source.required) {
        console.log(`skip optional source ${source.id}: ${message}`);
        return optionalFailedRecord(source, message);
      }
      throw new CompileAbortError(message, 1);
    }
  } else if (source.url) {
    try {
      const loaded = await loadRemoteSource(source, previous, options, snapshotsDir);
      text = loaded.text;
      etag = loaded.etag;
      fetchedAt = loaded.fetchedAt;
      notModified = loaded.notModified;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!source.required) {
        console.log(`skip optional source ${source.id}: ${message}`);
        return optionalFailedRecord(source, message);
      }
      throw new CompileAbortError(`source ${source.id}: ${message}`, 1);
    }
  } else {
    throw new CompileAbortError(`source ${source.id}: needs path or url`, 1);
  }

  const parsedDomains = enumerateDomains(text, source.format, role).length;
  if (source.url && source.required && parsedDomains === 0) {
    throw new CompileAbortError(
      `source ${source.id}: parsed 0 domains (required source is empty)`,
      2,
    );
  }

  if (source.url) {
    const { shrank, shrinkPct } = sourceShrank(
      previous,
      countLines(text),
      config.safety.abortIfSourceShrinksPct,
    );
    if (shrank && previous) {
      throw new CompileAbortError(
        `source ${source.id}: shrunk ${shrinkPct.toFixed(1)}% (${previous.lineCount} → ${countLines(text)} lines); abort_if_source_shrinks_pct is ${config.safety.abortIfSourceShrinksPct}`,
        2,
      );
    }
  }

  return {
    compiler: {
      id: source.id,
      role,
      priority: source.priority,
      format: source.format,
      pinned: Boolean(source.path),
      text,
    },
    record: okRecord(source, text, parsedDomains, { etag, fetchedAt }, previous),
    notModified,
  };
}

async function loadRemoteSource(
  source: SourceConfig,
  previous: SourceRecord | undefined,
  options: CompileOptions,
  snapshotsDir: string,
): Promise<{ text: string; etag: string | null; fetchedAt: string; notModified: boolean }> {
  const url = source.url;
  if (!url) throw new CompileAbortError(`source ${source.id}: needs path or url`, 1);

  const previousHash =
    previous?.status === "ok" && previous.sha256 ? previous.sha256 : null;
  const cached =
    previousHash == null
      ? null
      : await readValidSourceCache(snapshotsDir, source.id, previousHash);
  const ifNoneMatch = cached ? oneEtag(previous?.etag) : undefined;

  let fetched = await fetchText(url, { ...options, ifNoneMatch });
  if (fetched.status === 304) {
    if (cached) {
      return {
        text: cached,
        etag: fetched.etag ?? previous?.etag ?? null,
        fetchedAt: new Date().toISOString(),
        notModified: true,
      };
    }
    fetched = await fetchText(url, { ...options, ifNoneMatch: undefined });
  }

  try {
    await writeSourceCache(snapshotsDir, source.id, fetched.text);
  } catch {
    // Next compile full-GETs. Do not fail compile on a cache write.
  }
  return {
    text: fetched.text,
    etag: fetched.etag,
    fetchedAt: new Date().toISOString(),
    notModified: false,
  };
}

async function maybeLiveAccountQuota(
  config: Config,
  options: CompileOptions,
): Promise<{ quota?: AccountQuotaSnapshot; warning?: string }> {
  if (options.fetch !== undefined && options.env === undefined && options.loadFile !== true) {
    return {};
  }
  const loadFile =
    options.loadFile ?? (options.env === undefined && options.fetch === undefined);
  let creds;
  try {
    creds = await loadCloudflareCredentials({
      env: options.env,
      envPath: options.envPath,
      loadFile,
    });
  } catch (error) {
    if (error instanceof CredentialsError) return {};
    throw error;
  }

  try {
    const client = createCfClient({
      ...creds,
      fetch: options.fetch,
      sleep: options.sleep,
    });
    const quota = await readLiveAccountQuota(client, config.plan.listNamePrefix, {
      ignoreGetErrors: true,
    });
    return { quota };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CloudflareApiError) {
      return { warning: `account quota live-read failed: ${message}` };
    }
    return { warning: `account quota live-read failed: ${message}` };
  }
}

export async function compileCommand(options: CompileOptions): Promise<number> {
  try {
    return await runCompile(options);
  } catch (error) {
    if (error instanceof CompileAbortError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}

async function runCompile(options: CompileOptions): Promise<number> {
  const config = await loadConfig(options.configPath);
  const snapshotsDir = snapshotsDirectory(options);
  const previousSnapshot = await loadSourcesSnapshot(snapshotsDir);
  const loaded: LoadedSource[] = [];
  const optionalFailed: SourceRecord[] = [];

  const groups: Array<{ role: "allow" | "block"; sources: SourceConfig[] }> = [
    { role: "allow", sources: config.sources.allow },
    { role: "block", sources: config.sources.block },
  ];

  for (const { role, sources } of groups) {
    for (const source of sources) {
      const one = await loadOneSource(
        source,
        role,
        config,
        previousRecord(previousSnapshot, source.id),
        options,
        snapshotsDir,
      );
      if ("compiler" in one) loaded.push(one);
      else optionalFailed.push(one);
    }
  }

  const live = await maybeLiveAccountQuota(config, options);
  const previousQuota =
    live.quota?.otherItems == null ? await loadAccountQuotaSnapshot(snapshotsDir) : null;
  const budgetFrom =
    live.quota?.otherItems != null
      ? live.quota
      : previousQuota?.otherItems != null
        ? previousQuota
        : undefined;
  const otherItems = budgetFrom?.otherItems ?? null;
  const quotaSource: "live" | "snapshot" | "none" =
    live.quota?.otherItems != null ? "live" : budgetFrom ? "snapshot" : "none";
  const budget = compileMaxItems(config.plan.maxItems, otherItems);

  const compiled = compileDomains(
    loaded.map((row) => row.compiler),
    { maxItems: budget },
  );
  const generatedAt = new Date().toISOString();
  const fetched = loaded.filter((row) => row.record.origin === "url").map((row) => row.record.id);

  const snapshot: DesiredSnapshot = {
    version: DESIRED_SNAPSHOT_VERSION,
    phase: DESIRED_SNAPSHOT_PHASE,
    generatedAt,
    note: "Phase 3: compiled local + fetched remote sources.",
    configPath: options.configPath,
    allow: compiled.allow,
    block: compiled.block,
    folded: compiled.folded,
    remote: { fetched },
    counts: {
      allow: compiled.allow.length,
      block: compiled.block.length,
      folded: compiled.folded.length,
      dropped: compiled.dropped.length,
    },
  };

  const droppedSnapshot: DroppedSnapshot = {
    version: DESIRED_SNAPSHOT_VERSION,
    phase: DESIRED_SNAPSHOT_PHASE,
    generatedAt,
    dropped: compiled.dropped,
  };

  const sourcesSnapshot: SourcesSnapshot = {
    version: DESIRED_SNAPSHOT_VERSION,
    phase: DESIRED_SNAPSHOT_PHASE,
    generatedAt,
    sources: [...loaded.map((row) => row.record), ...optionalFailed],
  };

  await mkdir(snapshotsDir, { recursive: true });
  const writeJson = async (name: string, value: unknown): Promise<void> => {
    await writeFile(join(snapshotsDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  await writeJson("desired.json", snapshot);
  await writeJson("dropped.json", droppedSnapshot);
  await writeJson("sources.json", sourcesSnapshot);
  if (live.quota) await writeAccountQuotaSnapshot(snapshotsDir, live.quota);

  console.log("compile");
  console.log(`  config:     ${options.configPath}`);
  console.log(`  prefix:     ${config.plan.listNamePrefix}`);
  console.log(`  max items:  ${config.plan.maxItems}`);
  if (live.warning) console.log(`  warning:    ${live.warning}`);
  if (budget !== config.plan.maxItems) {
    console.log(`  budget:     ${budget} (${config.plan.maxItems} − ${otherItems} other)`);
  }
  if (quotaSource === "none" || otherItems === null) {
    console.log("  other:      unknown");
  } else if (quotaSource === "snapshot") {
    console.log(
      `  other:      ${otherItems} items / ${budgetFrom?.otherLists ?? "?"} lists (from snapshots/account-quota.json)`,
    );
  } else {
    console.log(`  other:      ${otherItems} items / ${budgetFrom?.otherLists ?? "?"} lists`);
  }
  for (const row of loaded) {
    const where = row.record.url ?? row.record.path ?? row.record.id;
    const notModified = row.notModified ? " 304" : "";
    console.log(
      `  source:     ${row.record.id} ${row.record.origin} ${where} ${row.record.content}${notModified} (${row.record.lineCount} lines, ${row.record.parsedDomains} domains)`,
    );
  }
  for (const row of optionalFailed) {
    console.log(`  source:     ${row.id} optional-failed ${row.error ?? ""}`.trim());
  }
  console.log(`  allow:      ${snapshot.counts.allow} domain(s)`);
  console.log(`  block:      ${snapshot.counts.block} domain(s)`);
  console.log(`  folded:     ${snapshot.counts.folded}`);
  console.log(`  dropped:    ${snapshot.counts.dropped}`);
  console.log(
    live.quota
      ? "  wrote:      snapshots/desired.json snapshots/dropped.json snapshots/sources.json snapshots/account-quota.json"
      : "  wrote:      snapshots/desired.json snapshots/dropped.json snapshots/sources.json",
  );
  return 0;
}
