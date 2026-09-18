import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  accountItemQuotaMessage,
  accountSlotQuotaMessage,
  formatMaybeCount,
  readLiveAccountQuota,
  writeAccountQuotaSnapshot,
} from "../account-quota.ts";
import {
  ApplyAbortError,
  buildApplyPlan,
  checkApplySafety,
  planIsNoop,
  planRules,
  type ApplyPlan,
  type LiveOwnedList,
  type LiveOwnedRule,
} from "../apply-plan.ts";
import { CloudflareApiError, createCfClient } from "../cf-client.ts";
import { createGatewayList, patchGatewayList, upsertGatewayRule } from "../cf-write.ts";
import { loadConfig } from "../config.ts";
import { isAllowListName, isBlockListName, liveDomains } from "../domain-diff.ts";
import { CredentialsError, loadCloudflareCredentials } from "../env.ts";
import { defaultSnapshotsDir } from "../paths.ts";
import { loadDesiredSnapshot, SnapshotError } from "../snapshot.ts";
import { DESIRED_SNAPSHOT_VERSION, type LastAppliedSnapshot } from "../types.ts";

export type ApplyOptions = {
  configPath: string;
  dryRun: boolean;
  snapshotsDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  loadFile?: boolean;
};

async function loadRoleLists(
  client: ReturnType<typeof createCfClient>,
  prefix: string,
  role: "allow" | "block",
): Promise<LiveOwnedList[]> {
  const match = role === "allow" ? isAllowListName : isBlockListName;
  const owned = (await client.ownedLists(prefix)).filter((row) => match(row.name, prefix));
  const out: LiveOwnedList[] = [];
  for (const list of owned) {
    const items = await client.listListItems(list.id);
    out.push({
      id: list.id,
      name: list.name,
      items: liveDomains(items.map((item) => item.value)),
    });
  }
  return out;
}

function printPlan(plan: ApplyPlan, dryRun: boolean): void {
  console.log(dryRun ? "apply --dry-run" : "apply");
  const patches = [...plan.allowPatches, ...plan.blockPatches];
  const creates = [...plan.allowCreates, ...plan.blockCreates];
  if (patches.length === 0 && creates.length === 0) {
    console.log("  lists:     no changes");
  }
  for (const patch of patches) {
    console.log(`  patch:     ${patch.name} +${patch.append.length} -${patch.remove.length}`);
  }
  for (const created of creates) {
    console.log(`  create:    ${created.name} ${created.items.length} item(s)`);
  }
  for (const rule of plan.rules) {
    if (rule.unchanged) continue;
    const state = rule.enabled ? rule.action : "disabled";
    console.log(`  rule:      ${rule.name} ${state} precedence ${rule.precedence}`);
  }
  for (const rule of plan.disableRules) {
    console.log(`  disable:   ${rule.name}`);
  }
  if (dryRun && creates.length > 0) {
    console.log("  note:      rules that need new list IDs are applied after create");
  }
}

export async function applyCommand(options: ApplyOptions): Promise<number> {
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
    const quota = await readLiveAccountQuota(client, prefix);
    await writeAccountQuotaSnapshot(snapshotsDir, quota);

    const desiredItems = desired.allow.length + desired.block.length;
    const itemError = accountItemQuotaMessage({
      otherItems: quota.otherItems,
      desiredItems,
      maxItems: config.plan.maxItems,
    });
    if (itemError) throw new ApplyAbortError(itemError);

    const allowLiveLists = await loadRoleLists(client, prefix, "allow");
    const blockLiveLists = await loadRoleLists(client, prefix, "block");
    const existingRules: LiveOwnedRule[] = (await client.ownedRules(prefix)).map((rule) => ({
      id: rule.id,
      name: rule.name,
      precedence: rule.precedence,
      action: rule.action,
      enabled: rule.enabled,
      traffic: rule.traffic,
      filters: rule.filters?.includes("l4") ? "l4" : rule.filters?.includes("dns") ? "dns" : undefined,
    }));

    const plan = buildApplyPlan({
      config,
      desired,
      allowLiveLists,
      blockLiveLists,
      existingRules,
    });
    const creates = plan.allowCreates.length + plan.blockCreates.length;
    const slotError = accountSlotQuotaMessage({
      otherLists: quota.otherLists,
      ownedLists: quota.ownedLists,
      creates,
      maxLists: config.plan.maxLists,
    });
    if (slotError) throw new ApplyAbortError(slotError);
    checkApplySafety(plan, config);

    const accountUsed =
      quota.otherItems === null ? "unknown" : String(quota.otherItems + desiredItems);
    console.log(
      `  quota:      other ${formatMaybeCount(quota.otherItems)} + desired ${desiredItems} = ${accountUsed} / ${config.plan.maxItems}`,
    );
    const slotTotal = quota.otherLists + quota.ownedLists + creates;
    const slots =
      config.plan.maxLists === undefined
        ? `${slotTotal}`
        : `${slotTotal} / ${config.plan.maxLists}`;
    console.log(
      `  slots:      other ${quota.otherLists} + owned ${quota.ownedLists} + create ${creates} = ${slots}`,
    );
    printPlan(plan, options.dryRun);

    if (options.dryRun) {
      console.log("  wrote:     nothing");
      return 0;
    }

    if (planIsNoop(plan) && plan.allowCreates.length === 0 && plan.blockCreates.length === 0) {
      console.log("  result:    no-op");
      return 0;
    }

    const resolved = new Map<string, { id: string; count: number }>();

    const ingestExisting = (lists: LiveOwnedList[], patches: typeof plan.allowPatches): void => {
      const patchById = new Map(patches.map((row) => [row.id, row]));
      for (const list of lists) {
        const patch = patchById.get(list.id);
        const items = new Set(list.items);
        if (patch) {
          for (const domain of patch.remove) items.delete(domain);
          for (const domain of patch.append) items.add(domain);
        }
        resolved.set(list.name, { id: list.id, count: items.size });
      }
    };
    ingestExisting(allowLiveLists, plan.allowPatches);
    ingestExisting(blockLiveLists, plan.blockPatches);

    for (const patch of [...plan.allowPatches, ...plan.blockPatches]) {
      await patchGatewayList(client, prefix, {
        id: patch.id,
        name: patch.name,
        append: patch.append.map((value) => ({ value })),
        remove: patch.remove,
      });
    }

    for (const created of [...plan.allowCreates, ...plan.blockCreates]) {
      const made = await createGatewayList(client, prefix, {
        name: created.name,
        description: "Managed by gateway-list",
        items: created.items.map((value) => ({ value })),
      });
      resolved.set(created.name, { id: made.id, count: created.items.length });
    }

    const asPlanned = (role: "allow" | "block") =>
      [...resolved.entries()]
        .filter(([name]) =>
          role === "allow" ? isAllowListName(name, prefix) : isBlockListName(name, prefix),
        )
        .map(([name, row]) => ({ name, id: row.id, count: row.count }));

    const finalRules = planRules({
      config,
      allowLists: asPlanned("allow"),
      blockLists: asPlanned("block"),
      existingRules,
    });

    const securityNames = new Set([
      config.policies.security.name,
      config.policies.network.security.name,
    ]);
    for (const rule of finalRules.rules) {
      if (rule.unchanged) continue;
      const isSecurity = securityNames.has(rule.name);
      if (rule.enabled && !isSecurity && !rule.traffic.includes("$")) {
        throw new ApplyAbortError(`refusing to attach ${rule.name} to an empty list`);
      }
      await upsertGatewayRule(client, prefix, {
        id: rule.existingId,
        name: rule.name,
        precedence: rule.precedence,
        action: rule.action,
        enabled: rule.enabled,
        filters: [rule.filters],
        traffic: rule.traffic,
      });
    }

    for (const extra of finalRules.disableRules) {
      const current = existingRules.find((rule) => rule.id === extra.id);
      const filters = current?.filters === "l4" ? "l4" : "dns";
      await upsertGatewayRule(client, prefix, {
        id: extra.id,
        name: extra.name,
        precedence: current?.precedence ?? 9000,
        action: current?.action === "allow" ? "allow" : "block",
        enabled: false,
        filters: [filters],
        traffic:
          current?.traffic ??
          (filters === "l4"
            ? 'net.sni.host == "__gateway-list-disabled.invalid"'
            : 'dns.fqdn == "__gateway-list-disabled.invalid"'),
      });
    }

    const lastApplied: LastAppliedSnapshot = {
      version: DESIRED_SNAPSHOT_VERSION,
      phase: 6,
      generatedAt: new Date().toISOString(),
      desiredGeneratedAt: desired.generatedAt,
      lists: [...resolved.entries()].map(([name, row]) => ({
        id: row.id,
        name,
        count: row.count,
      })),
      rules: finalRules.rules
        .filter((rule) => rule.enabled)
        .map((rule) => ({
          id: rule.existingId ?? resolved.get(rule.name)?.id ?? "",
          name: rule.name,
          precedence: rule.precedence,
          action: rule.action,
        })),
      counts: {
        allow: plan.allowDesired.length,
        block: plan.blockDesired.length,
      },
    };
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(
      join(snapshotsDir, "last-applied.json"),
      `${JSON.stringify(lastApplied, null, 2)}\n`,
      "utf8",
    );
    console.log("  wrote:     snapshots/last-applied.json");
    return 0;
  } catch (error) {
    if (
      error instanceof SnapshotError ||
      error instanceof CredentialsError ||
      error instanceof ApplyAbortError
    ) {
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
