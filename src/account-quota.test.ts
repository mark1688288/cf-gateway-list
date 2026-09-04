import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountItemQuotaMessage,
  accountQuotaFromLists,
  accountSlotQuotaMessage,
  compileMaxItems,
  fillMissingCounts,
  listSlotsNeeded,
  loadAccountQuotaSnapshot,
  parseAccountQuotaSnapshot,
  writeAccountQuotaSnapshot,
} from "./account-quota.ts";
import type { GatewayList } from "./cf-client.ts";

const lists: GatewayList[] = [
  { id: "o1", name: "gateway-list:allow", type: "DOMAIN", count: 2 },
  { id: "o2", name: "gateway-list:block", type: "DOMAIN", count: 10 },
  { id: "h1", name: "corp-ips", type: "IP", count: 40 },
  { id: "h2", name: "staff-mail", type: "EMAIL", count: 5 },
];

test("accountQuotaFromLists splits owned vs other and sums counts", () => {
  const quota = accountQuotaFromLists(lists, "gateway-list");
  assert.equal(quota.ownedLists, 2);
  assert.equal(quota.otherLists, 2);
  assert.equal(quota.ownedItems, 12);
  assert.equal(quota.otherItems, 45);
  assert.equal(quota.accountItems, 57);
  assert.deepEqual(quota.unknownCounts, []);
  assert.deepEqual(
    quota.other.map((row) => row.name),
    ["corp-ips", "staff-mail"],
  );
  assert.equal(quota.other.find((row) => row.name === "corp-ips")?.type, "IP");
});

test("missing count makes the group unknown, not zero", () => {
  const quota = accountQuotaFromLists(
    [
      { id: "o1", name: "gateway-list:allow", count: 2 },
      { id: "h1", name: "mystery", type: "DOMAIN" },
      { id: "h2", name: "known", type: "IP", count: 3 },
    ],
    "gateway-list",
  );
  assert.equal(quota.otherLists, 2);
  assert.equal(quota.otherItems, null);
  assert.equal(quota.ownedItems, 2);
  assert.equal(quota.accountItems, null);
  assert.deepEqual(quota.unknownCounts, ["mystery"]);
});

test("compileMaxItems subtracts other items and floors at 0", () => {
  assert.equal(compileMaxItems(300000, null), 300000);
  assert.equal(compileMaxItems(300000, 12345), 287655);
  assert.equal(compileMaxItems(10, 40), 0);
});

test("listSlotsNeeded ceils by items_per_list", () => {
  assert.equal(listSlotsNeeded(0, 1000), 0);
  assert.equal(listSlotsNeeded(1, 1000), 1);
  assert.equal(listSlotsNeeded(1000, 1000), 1);
  assert.equal(listSlotsNeeded(1001, 1000), 2);
});

test("account item quota refuses unknown other and overflow", () => {
  assert.match(
    accountItemQuotaMessage({ otherItems: null, desiredItems: 10, maxItems: 100 }) ?? "",
    /unknown/,
  );
  assert.match(
    accountItemQuotaMessage({ otherItems: 90, desiredItems: 20, maxItems: 100 }) ?? "",
    /exceeds max_items 100/,
  );
  assert.equal(
    accountItemQuotaMessage({ otherItems: 90, desiredItems: 10, maxItems: 100 }),
    null,
  );
});

test("account slot quota only enforces when max_lists is set", () => {
  assert.equal(
    accountSlotQuotaMessage({ otherLists: 88, ownedLists: 58, creates: 1, maxLists: undefined }),
    null,
  );
  assert.match(
    accountSlotQuotaMessage({ otherLists: 88, ownedLists: 10, creates: 3, maxLists: 100 }) ?? "",
    /exceeds max_lists 100/,
  );
  assert.equal(
    accountSlotQuotaMessage({ otherLists: 88, ownedLists: 10, creates: 2, maxLists: 100 }),
    null,
  );
});

test("fillMissingCounts GETs only rows without count", async () => {
  const fetched: string[] = [];
  const filled = await fillMissingCounts(
    [
      { id: "has", name: "a", count: 4 },
      { id: "miss", name: "b", type: "IP" },
    ],
    async (id) => {
      fetched.push(id);
      return { id, name: "b", type: "IP", count: 9 };
    },
  );
  assert.deepEqual(fetched, ["miss"]);
  assert.equal(filled[1]?.count, 9);
});

test("fillMissingCounts counts items when GET still has no count", async () => {
  const counted: string[] = [];
  const filled = await fillMissingCounts(
    [{ id: "miss", name: "gateway-list:block-90", type: "DOMAIN" }],
    async (id) => ({ id, name: "gateway-list:block-90", type: "DOMAIN" }),
    {
      countItems: async (id) => {
        counted.push(id);
        return 390;
      },
    },
  );
  assert.deepEqual(counted, ["miss"]);
  assert.equal(filled[0]?.count, 390);
});

test("fillMissingCounts counts items when GET fails", async () => {
  const filled = await fillMissingCounts(
    [{ id: "x", name: "x" }],
    async () => {
      throw new Error("nope");
    },
    { countItems: async () => 4 },
  );
  assert.equal(filled[0]?.count, 4);
});

test("fillMissingCounts prefers the GET error when item count also fails", async () => {
  await assert.rejects(
    () =>
      fillMissingCounts(
        [{ id: "x", name: "x" }],
        async () => {
          throw new Error("get failed");
        },
        {
          countItems: async () => {
            throw new Error("items failed");
          },
        },
      ),
    /get failed/,
  );
});

test("fillMissingCounts can swallow get errors", async () => {
  await assert.rejects(
    () =>
      fillMissingCounts([{ id: "x", name: "x" }], async () => {
        throw new Error("nope");
      }),
    /nope/,
  );
  const filled = await fillMissingCounts(
    [{ id: "x", name: "x" }],
    async () => {
      throw new Error("nope");
    },
    { ignoreGetErrors: true },
  );
  assert.equal(filled[0]?.count, undefined);
  const stillUnknown = await fillMissingCounts(
    [{ id: "x", name: "x" }],
    async () => {
      throw new Error("nope");
    },
    {
      ignoreGetErrors: true,
      countItems: async () => {
        throw new Error("items nope");
      },
    },
  );
  assert.equal(stillUnknown[0]?.count, undefined);
});

test("account-quota snapshot round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-quota-"));
  const quota = accountQuotaFromLists(lists, "gateway-list");
  await writeAccountQuotaSnapshot(dir, quota);
  const loaded = await loadAccountQuotaSnapshot(dir);
  assert.ok(loaded);
  assert.equal(loaded.otherItems, 45);
  assert.equal(loaded.phase, 10);
  const text = await readFile(join(dir, "account-quota.json"), "utf8");
  assert.match(text, /corp-ips/);
});

test("parseAccountQuotaSnapshot rejects junk", async () => {
  assert.equal(parseAccountQuotaSnapshot({ version: 1 }), null);
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-quota-bad-"));
  await writeFile(join(dir, "account-quota.json"), "{not json", "utf8");
  assert.equal(await loadAccountQuotaSnapshot(dir), null);
});
