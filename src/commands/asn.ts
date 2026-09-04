import {
  accountItemQuotaMessage,
  accountSlotQuotaMessage,
  formatMaybeCount,
  readLiveAccountQuota,
  writeAccountQuotaSnapshot,
} from "../account-quota.ts";
import {
  asnSourceUrls,
  extractFromLoaded,
  extractManyFromLoaded,
  loadGeoLite2AsnMmdb,
  type LoadedAsnMmdb,
} from "../asn-mmdb.ts";
import {
  AsnAbortError,
  findAsnLists,
  findDashboardAsnLists,
  normalizeAsnItems,
  planAsnAdd,
  planAsnUpdate,
  planIsNoop,
  uniqueDashboardAsns,
  type AsnPlan,
  type LiveAsnList,
} from "../asn-plan.ts";
import { parseAsn } from "../asn.ts";
import {
  CloudflareApiError,
  createCfClient,
  isOwnedName,
  type CfClient,
  type GatewayList,
} from "../cf-client.ts";
import { createAsnGatewayList, patchAsnGatewayList } from "../cf-write.ts";
import { loadConfig } from "../config.ts";
import { CredentialsError, loadCloudflareCredentials } from "../env.ts";
import { MmdbError } from "../mmdb.ts";
import { resolveFromRepo } from "../paths.ts";

export const ASN_USAGE = `usage: asn add <ASNNNN> | asn update <ASNNNN> | asn update --dashboard [--dry-run]
  Creates or refreshes a Gateway IP reusable list from GeoLite2-ASN.
  --dashboard updates every other type=IP list named AS<number> (user-made or asn add).
  Does not create or update a Gateway rule — set precedence yourself.`;

export type AsnCommandOptions = {
  configPath: string;
  dryRun: boolean;
  rest: string[];
  dashboard?: boolean;
  snapshotsDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  loadFile?: boolean;
  mmdbUrls?: readonly string[];
};

function printPlanBody(plan: AsnPlan): void {
  console.log(`  asn:        AS${plan.asn}${plan.organization ? ` ${plan.organization}` : ""}`);
  console.log(`  prefixes:   ${plan.prefixes.length}`);
  if (plan.patches.length === 0 && plan.creates.length === 0) {
    console.log("  lists:      no changes");
  }
  for (const patch of plan.patches) {
    const rename = patch.nextName !== patch.name ? ` → ${patch.nextName}` : "";
    console.log(
      `  patch:      ${patch.name}${rename} +${patch.append.length} -${patch.remove.length}`,
    );
  }
  for (const created of plan.creates) {
    console.log(`  create:     ${created.name}  ${created.items.length} item(s)  type IP`);
  }
}

function printPlan(plan: AsnPlan, dryRun: boolean): void {
  console.log(dryRun ? `asn ${plan.action} --dry-run` : `asn ${plan.action}`);
  printPlanBody(plan);
  console.log("  rules:      none (attach the list in Zero Trust and set precedence yourself)");
}

type AsnContext = {
  config: Awaited<ReturnType<typeof loadConfig>>;
  client: CfClient;
  loaded: LoadedAsnMmdb;
  lists: GatewayList[];
  quota: Awaited<ReturnType<typeof readLiveAccountQuota>>;
};

async function loadExisting(
  client: CfClient,
  lists: GatewayList[],
  asn: number,
): Promise<LiveAsnList[]> {
  const matched = findAsnLists(lists, asn);
  const out: LiveAsnList[] = [];
  for (const list of matched) {
    const items = await client.listListItems(list.id);
    out.push({
      id: list.id,
      name: list.name,
      type: list.type,
      items: normalizeAsnItems(items.map((item) => item.value)),
    });
  }
  return out;
}

function assertKnownQuota(
  accountItems: number | null,
  unknownCounts: readonly string[] = [],
): asserts accountItems is number {
  if (accountItems === null) {
    const suffix = unknownCounts.length > 0 ? ` (${unknownCounts.join(", ")})` : "";
    throw new AsnAbortError(
      `account quota: list item count is unknown${suffix}; refuse to change ASN lists`,
    );
  }
}

function checkAsnQuota(options: {
  accountItems: number;
  currentAsnItems: number;
  desiredItems: number;
  creates: number;
  otherLists: number;
  ownedLists: number;
  maxItems: number;
  maxLists: number | undefined;
}): number {
  const nextItems = options.accountItems - options.currentAsnItems + options.desiredItems;
  const itemError = accountItemQuotaMessage({
    otherItems: options.accountItems - options.currentAsnItems,
    desiredItems: options.desiredItems,
    maxItems: options.maxItems,
  });
  if (itemError) throw new AsnAbortError(itemError);
  const slotError = accountSlotQuotaMessage({
    otherLists: options.otherLists,
    ownedLists: options.ownedLists,
    creates: options.creates,
    maxLists: options.maxLists,
  });
  if (slotError) throw new AsnAbortError(slotError);
  return nextItems;
}

async function applyPlan(client: CfClient, plan: AsnPlan): Promise<void> {
  for (const patch of plan.patches) {
    await patchAsnGatewayList(client, {
      id: patch.id,
      name: patch.nextName,
      append: patch.append.map((value) => ({ value })),
      remove: patch.remove,
    });
  }
  for (const created of plan.creates) {
    await createAsnGatewayList(client, {
      name: created.name,
      description: `GeoLite2-ASN prefixes for AS${plan.asn}. Not attached to a Gateway rule — set precedence yourself.`,
      items: created.items.map((value) => ({ value })),
    });
  }
}

async function loadAsnContext(options: AsnCommandOptions): Promise<AsnContext> {
  const config = await loadConfig(options.configPath);
  const snapshotsDir = options.snapshotsDir ?? resolveFromRepo("snapshots");
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
  const urls = options.mmdbUrls ?? asnSourceUrls(config.sources.asn);
  const loaded = await loadGeoLite2AsnMmdb({
    snapshotsDir,
    fetch: options.fetch,
    sleep: options.sleep,
    urls,
  });
  const mib = (loaded.bytes.length / 1024 / 1024).toFixed(1);
  console.log(`  mmdb:       GeoLite2-ASN ${loaded.content} (${mib} MiB)`);

  const lists = await client.listLists();
  const prefix = config.plan.listNamePrefix;
  const quota = await readLiveAccountQuota(client, prefix);
  await writeAccountQuotaSnapshot(snapshotsDir, quota);
  return { config, client, loaded, lists, quota };
}

async function runSingleAsn(
  ctx: AsnContext,
  action: "add" | "update",
  asn: number,
  dryRun: boolean,
): Promise<number> {
  const extract = extractFromLoaded(ctx.loaded, asn);
  const existing = await loadExisting(ctx.client, ctx.lists, asn);
  const plan =
    action === "add"
      ? planAsnAdd(extract, existing, ctx.config.plan.itemsPerList)
      : planAsnUpdate(extract, existing, ctx.config.plan.itemsPerList);

  assertKnownQuota(ctx.quota.accountItems, ctx.quota.unknownCounts);
  const currentAsnItems = existing.reduce((sum, list) => sum + list.items.length, 0);
  const nextItems = checkAsnQuota({
    accountItems: ctx.quota.accountItems,
    currentAsnItems,
    desiredItems: plan.prefixes.length,
    creates: plan.creates.length,
    otherLists: ctx.quota.otherLists,
    ownedLists: ctx.quota.ownedLists,
    maxItems: ctx.config.plan.maxItems,
    maxLists: ctx.config.plan.maxLists,
  });
  console.log(
    `  quota:      account ${formatMaybeCount(ctx.quota.accountItems)} → ${nextItems} / ${ctx.config.plan.maxItems}`,
  );
  printPlan(plan, dryRun);

  if (dryRun) {
    console.log("  wrote:      nothing");
    return 0;
  }
  if (planIsNoop(plan)) {
    console.log("  result:     no-op");
    return 0;
  }
  await applyPlan(ctx.client, plan);
  console.log("  wrote:      Cloudflare IP list(s) only (no rule)");
  return 0;
}

async function runDashboardUpdate(ctx: AsnContext, dryRun: boolean): Promise<number> {
  const prefix = ctx.config.plan.listNamePrefix;
  const others = ctx.lists.filter((list) => !isOwnedName(list.name, prefix));
  const targets = findDashboardAsnLists(others);
  const asns = uniqueDashboardAsns(targets);
  if (asns.length === 0) {
    throw new AsnAbortError(
      "no other type=IP reusable lists named AS<number>. Use asn add <ASNNNN> first",
    );
  }

  const extracts = extractManyFromLoaded(ctx.loaded, asns);
  const plans: AsnPlan[] = [];
  const skipped: Array<{ asn: number; reason: string }> = [];
  const existingByAsn = new Map<number, LiveAsnList[]>();

  for (const asn of asns) {
    const extract = extracts.get(asn);
    if (!extract || extract.prefixes.length === 0) {
      skipped.push({ asn, reason: "no prefixes in GeoLite2-ASN" });
      continue;
    }
    const existing = await loadExisting(ctx.client, targets, asn);
    existingByAsn.set(asn, existing);
    plans.push(planAsnUpdate(extract, existing, ctx.config.plan.itemsPerList));
  }

  if (plans.length === 0) {
    for (const skip of skipped) {
      console.log(`  skip:       AS${skip.asn}  ${skip.reason}`);
    }
    throw new AsnAbortError("asn update --dashboard: no AS<number> lists could be refreshed");
  }

  assertKnownQuota(ctx.quota.accountItems, ctx.quota.unknownCounts);
  let currentAsnItems = 0;
  let desiredItems = 0;
  let creates = 0;
  for (const plan of plans) {
    const existing = existingByAsn.get(plan.asn) ?? [];
    currentAsnItems += existing.reduce((sum, list) => sum + list.items.length, 0);
    desiredItems += plan.prefixes.length;
    creates += plan.creates.length;
  }
  const nextItems = checkAsnQuota({
    accountItems: ctx.quota.accountItems,
    currentAsnItems,
    desiredItems,
    creates,
    otherLists: ctx.quota.otherLists,
    ownedLists: ctx.quota.ownedLists,
    maxItems: ctx.config.plan.maxItems,
    maxLists: ctx.config.plan.maxLists,
  });

  console.log(dryRun ? "asn update --dashboard --dry-run" : "asn update --dashboard");
  console.log(
    `  quota:      account ${formatMaybeCount(ctx.quota.accountItems)} → ${nextItems} / ${ctx.config.plan.maxItems}`,
  );
  console.log(`  targets:    ${targets.length} other IP list(s) / ${asns.length} ASN(s)`);
  for (const skip of skipped) {
    console.log(`  skip:       AS${skip.asn}  ${skip.reason}`);
  }
  for (const plan of plans) {
    printPlanBody(plan);
  }
  console.log("  rules:      none (attach the list in Zero Trust and set precedence yourself)");

  if (dryRun) {
    console.log("  wrote:      nothing");
    return 0;
  }
  if (plans.every(planIsNoop)) {
    console.log("  result:     no-op");
    return 0;
  }
  for (const plan of plans) {
    if (planIsNoop(plan)) continue;
    await applyPlan(ctx.client, plan);
  }
  console.log("  wrote:      Cloudflare IP list(s) only (no rule)");
  return 0;
}

function parseAsnInvocation(
  options: AsnCommandOptions,
):
  | { ok: false }
  | { ok: true; mode: "dashboard" }
  | { ok: true; mode: "single"; action: "add" | "update"; asn: number } {
  const dashboard = Boolean(options.dashboard) || options.rest.includes("--dashboard");
  const tokens = options.rest.filter((arg) => arg !== "--dashboard");
  const [rawAction, rawAsn, ...extra] = tokens;
  const action = rawAction?.toLowerCase();
  if (action !== "add" && action !== "update") return { ok: false };
  if (extra.length > 0) return { ok: false };
  if (dashboard) {
    if (action !== "update" || rawAsn) return { ok: false };
    return { ok: true, mode: "dashboard" };
  }
  if (!rawAsn) return { ok: false };
  return { ok: true, mode: "single", action, asn: parseAsn(rawAsn) };
}

export async function asnCommand(options: AsnCommandOptions): Promise<number> {
  let parsed: ReturnType<typeof parseAsnInvocation>;
  try {
    parsed = parseAsnInvocation(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!parsed.ok) {
    console.error(ASN_USAGE);
    return 1;
  }

  try {
    const ctx = await loadAsnContext(options);
    if (parsed.mode === "dashboard") {
      return await runDashboardUpdate(ctx, options.dryRun);
    }
    return await runSingleAsn(ctx, parsed.action, parsed.asn, options.dryRun);
  } catch (error) {
    if (
      error instanceof CredentialsError ||
      error instanceof AsnAbortError ||
      error instanceof MmdbError
    ) {
      console.error(error.message);
      return error instanceof AsnAbortError ? error.exitCode : 1;
    }
    if (error instanceof CloudflareApiError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
