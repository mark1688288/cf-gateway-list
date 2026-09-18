import {
  formatMaybeCount,
  readLiveAccountQuota,
  writeAccountQuotaSnapshot,
} from "../account-quota.ts";
import { createCfClient, CloudflareApiError } from "../cf-client.ts";
import { loadConfig } from "../config.ts";
import { CredentialsError, loadCloudflareCredentials } from "../env.ts";
import { resolveFromRepo } from "../paths.ts";

export type ListsOptions = {
  configPath: string;
  snapshotsDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  loadFile?: boolean;
};

function formatListCount(count: number | null | undefined): string {
  return count === undefined || count === null ? "?" : String(count);
}

export async function listsCommand(options: ListsOptions): Promise<number> {
  try {
    const config = await loadConfig(options.configPath);
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
    const snapshotsDir = options.snapshotsDir ?? resolveFromRepo("snapshots");
    const quota = await readLiveAccountQuota(client, prefix);
    const rules = await client.listRules();
    const ownedRules = rules.filter((row) => row.name.startsWith(prefix));

    await writeAccountQuotaSnapshot(snapshotsDir, quota);

    const itemsLine =
      quota.ownedItems === null || quota.otherItems === null
        ? `owned ${formatMaybeCount(quota.ownedItems)} + other ${formatMaybeCount(quota.otherItems)} = unknown / ${config.plan.maxItems}`
        : `owned ${quota.ownedItems} + other ${quota.otherItems} = ${quota.accountItems} / ${config.plan.maxItems}`;
    const slotTotal = quota.ownedLists + quota.otherLists;
    const slotsLine =
      config.plan.maxLists === undefined
        ? `${quota.ownedLists} owned + ${quota.otherLists} other = ${slotTotal}`
        : `${quota.ownedLists} owned + ${quota.otherLists} other = ${slotTotal} / ${config.plan.maxLists}`;

    console.log("Cloudflare Gateway lists");
    console.log(`  prefix:      ${prefix}`);
    console.log(`  owned lists: ${quota.ownedLists}`);
    for (const list of quota.owned) {
      const type = list.type ? `  ${list.type}` : "";
      console.log(`    ${list.name}  ${list.id}${type}  ${formatListCount(list.count)} items`);
    }
    console.log(`  other lists: ${quota.otherLists} (not managed; counted for quota)`);
    for (const list of quota.other) {
      const type = list.type ?? "?";
      console.log(`    ${list.name}  ${list.id}  ${type}  ${formatListCount(list.count)} items`);
    }
    console.log(`  items:       ${itemsLine}`);
    console.log(`  slots:       ${slotsLine}`);
    console.log(`  owned rules: ${ownedRules.length}`);
    for (const rule of ownedRules) {
      const prec = rule.precedence === undefined ? "?" : String(rule.precedence);
      const action = rule.action ?? "?";
      const filter = rule.filters?.[0] ?? "-";
      console.log(`    ${rule.name}  ${filter}  precedence ${prec}  ${action}`);
    }
    console.log(`  other rules: ${rules.length - ownedRules.length} (ignored)`);
    console.log("  wrote:      snapshots/account-quota.json");
    return 0;
  } catch (error) {
    if (error instanceof CredentialsError) {
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
