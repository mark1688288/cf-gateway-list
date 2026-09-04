import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isOwnedName, type CfClient, type GatewayList } from "./cf-client.ts";
import {
  ACCOUNT_QUOTA_SNAPSHOT_PHASE,
  DESIRED_SNAPSHOT_VERSION,
  type AccountQuotaListRow,
  type AccountQuotaSnapshot,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareName(a: AccountQuotaListRow, b: AccountQuotaListRow): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function toRow(list: GatewayList): AccountQuotaListRow {
  return {
    id: list.id,
    name: list.name,
    type: list.type,
    count: typeof list.count === "number" ? list.count : null,
  };
}

function sumCounts(rows: AccountQuotaListRow[]): number | null {
  let total = 0;
  for (const row of rows) {
    if (row.count === null) return null;
    total += row.count;
  }
  return total;
}

export function accountQuotaFromLists(lists: GatewayList[], prefix: string): AccountQuotaSnapshot {
  const owned: AccountQuotaListRow[] = [];
  const other: AccountQuotaListRow[] = [];
  const unknownCounts: string[] = [];

  for (const list of lists) {
    const row = toRow(list);
    if (row.count === null) unknownCounts.push(row.name);
    (isOwnedName(list.name, prefix) ? owned : other).push(row);
  }

  owned.sort(compareName);
  other.sort(compareName);
  unknownCounts.sort((a, b) => a.localeCompare(b));

  const ownedItems = sumCounts(owned);
  const otherItems = sumCounts(other);
  const accountItems =
    ownedItems === null || otherItems === null ? null : ownedItems + otherItems;

  return {
    version: DESIRED_SNAPSHOT_VERSION,
    phase: ACCOUNT_QUOTA_SNAPSHOT_PHASE,
    fetchedAt: new Date().toISOString(),
    prefix,
    ownedLists: owned.length,
    otherLists: other.length,
    ownedItems,
    otherItems,
    accountItems,
    unknownCounts,
    owned,
    other,
  };
}

/** Compile budget for this tool: leftover after other-list items, or maxItems if unknown. */
export function compileMaxItems(maxItems: number, otherItems: number | null): number {
  if (otherItems === null) return maxItems;
  return Math.max(0, maxItems - otherItems);
}

export function listSlotsNeeded(itemCount: number, itemsPerList: number): number {
  if (itemCount <= 0 || itemsPerList <= 0) return 0;
  return Math.ceil(itemCount / itemsPerList);
}

export function formatMaybeCount(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function accountItemQuotaMessage(options: {
  otherItems: number | null;
  desiredItems: number;
  maxItems: number;
}): string | null {
  if (options.otherItems === null) {
    return "account quota: other list item count is unknown; refuse to apply";
  }
  const account = options.otherItems + options.desiredItems;
  if (account > options.maxItems) {
    return (
      `account quota: other lists ${options.otherItems} + desired ${options.desiredItems}` +
      ` = ${account} exceeds max_items ${options.maxItems}`
    );
  }
  return null;
}

export function accountSlotQuotaMessage(options: {
  otherLists: number;
  ownedLists: number;
  creates: number;
  maxLists: number | undefined;
}): string | null {
  if (options.maxLists === undefined) return null;
  const total = options.otherLists + options.ownedLists + options.creates;
  if (total > options.maxLists) {
    return (
      `account quota: list slots other ${options.otherLists} + owned ${options.ownedLists}` +
      ` + create ${options.creates} = ${total} exceeds max_lists ${options.maxLists}`
    );
  }
  return null;
}

export async function fillMissingCounts(
  lists: GatewayList[],
  getList: (listId: string) => Promise<GatewayList>,
  options?: {
    ignoreGetErrors?: boolean;
    countItems?: (listId: string) => Promise<number>;
  },
): Promise<GatewayList[]> {
  const out: GatewayList[] = [];
  for (const list of lists) {
    if (typeof list.count === "number") {
      out.push(list);
      continue;
    }

    let merged: GatewayList = list;
    let getFailed: unknown;
    try {
      const detail = await getList(list.id);
      merged = {
        ...list,
        count: detail.count,
        type: list.type ?? detail.type,
      };
    } catch (error) {
      getFailed = error;
    }

    if (typeof merged.count === "number") {
      out.push(merged);
      continue;
    }

    if (options?.countItems) {
      try {
        const count = await options.countItems(list.id);
        out.push({ ...merged, count });
        continue;
      } catch (error) {
        if (options.ignoreGetErrors) {
          out.push(merged);
          continue;
        }
        throw getFailed ?? error;
      }
    }

    if (getFailed && !options?.ignoreGetErrors) throw getFailed;
    out.push(merged);
  }
  return out;
}

export async function readLiveAccountQuota(
  client: CfClient,
  prefix: string,
  options?: { ignoreGetErrors?: boolean },
): Promise<AccountQuotaSnapshot> {
  const lists = await fillMissingCounts(await client.listLists(), (id) => client.getList(id), {
    ...options,
    countItems: async (id) => (await client.listListItems(id)).length,
  });
  return accountQuotaFromLists(lists, prefix);
}

function isQuotaRow(value: unknown): value is AccountQuotaListRow {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return false;
  }
  if (value.count !== null && typeof value.count !== "number") return false;
  if (value.type !== undefined && typeof value.type !== "string") return false;
  return true;
}

export function parseAccountQuotaSnapshot(raw: unknown): AccountQuotaSnapshot | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== DESIRED_SNAPSHOT_VERSION) return null;
  if (raw.phase !== ACCOUNT_QUOTA_SNAPSHOT_PHASE) return null;
  if (typeof raw.fetchedAt !== "string" || typeof raw.prefix !== "string") return null;
  if (typeof raw.ownedLists !== "number" || typeof raw.otherLists !== "number") return null;
  if (raw.ownedItems !== null && typeof raw.ownedItems !== "number") return null;
  if (raw.otherItems !== null && typeof raw.otherItems !== "number") return null;
  if (raw.accountItems !== null && typeof raw.accountItems !== "number") return null;
  if (!Array.isArray(raw.unknownCounts) || !raw.unknownCounts.every((row) => typeof row === "string")) {
    return null;
  }
  if (!Array.isArray(raw.owned) || !raw.owned.every(isQuotaRow)) return null;
  if (!Array.isArray(raw.other) || !raw.other.every(isQuotaRow)) return null;
  return raw as AccountQuotaSnapshot;
}

export async function loadAccountQuotaSnapshot(dir: string): Promise<AccountQuotaSnapshot | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "account-quota.json"), "utf8"));
    return parseAccountQuotaSnapshot(raw);
  } catch {
    return null;
  }
}

export async function writeAccountQuotaSnapshot(
  dir: string,
  quota: AccountQuotaSnapshot,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "account-quota.json"), `${JSON.stringify(quota, null, 2)}\n`, "utf8");
}
