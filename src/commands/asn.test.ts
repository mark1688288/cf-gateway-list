import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeMmdb } from "../mmdb-write.ts";
import { asnCommand } from "./asn.ts";

const TOKEN = "cfut_test_token_do_not_leak";
const ACCOUNT = "accttest000000000000000000000001";

type FakeList = { id: string; name: string; items: string[]; type?: string; omitCount?: boolean };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function asnMmdb(): Uint8Array {
  return writeMmdb({
    ipVersion: 4,
    databaseType: "GeoLite2-ASN",
    networks: [
      {
        network: "14.1.0.0/16",
        data: {
          autonomous_system_number: 10206,
          autonomous_system_organization: "China Unicom Zhongwei Cloud",
        },
      },
      {
        network: "14.2.0.0/16",
        data: {
          autonomous_system_number: 10206,
          autonomous_system_organization: "China Unicom Zhongwei Cloud",
        },
      },
      {
        network: "1.0.0.0/24",
        data: { autonomous_system_number: 13335, autonomous_system_organization: "CLOUDFLARENET" },
      },
      {
        network: "160.19.0.0/16",
        data: { autonomous_system_number: 136907, autonomous_system_organization: "HWCLOUDS-AS-AP" },
      },
    ],
  });
}

function createFake(mmdb: Uint8Array): {
  fetch: typeof fetch;
  writes: string[];
  lists: FakeList[];
  ruleWrites: number;
} {
  const lists: FakeList[] = [];
  const writes: string[] = [];
  let seq = 1;
  let ruleWrites = 0;

  const fetchFn = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url.includes("GeoLite2-ASN") || url.includes("git.io")) {
      return new Response(Buffer.from(mmdb), {
        status: 200,
        headers: { etag: '"mmdb1"', "content-type": "application/octet-stream" },
      });
    }
    const path = new URL(url).pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path.startsWith("/gateway/rules") && method !== "GET") ruleWrites += 1;

    if (method === "GET" && path === "/gateway/lists") {
      return json({
        success: true,
        result: lists.map((list) => ({
          id: list.id,
          name: list.name,
          type: list.type ?? "IP",
          ...(list.omitCount ? {} : { count: list.items.length }),
        })),
        result_info: { page: 1, per_page: 1000, total_count: lists.length },
      });
    }
    const itemsMatch = /^\/gateway\/lists\/([^/]+)\/items$/.exec(path);
    if (method === "GET" && itemsMatch) {
      const list = lists.find((row) => row.id === itemsMatch[1]);
      const items = (list?.items ?? []).map((value) => ({ value }));
      return json({
        success: true,
        result: items,
        result_info: { page: 1, per_page: 1000, total_count: items.length },
      });
    }
    const oneList = /^\/gateway\/lists\/([^/]+)$/.exec(path);
    if (method === "GET" && oneList) {
      const list = lists.find((row) => row.id === oneList[1]);
      return json({
        success: true,
        result: list
          ? {
              id: list.id,
              name: list.name,
              type: list.type ?? "IP",
              ...(list.omitCount ? {} : { count: list.items.length }),
            }
          : {},
      });
    }
    if (method === "POST" && path === "/gateway/lists") {
      const created: FakeList = {
        id: `L${seq++}`,
        name: body.name,
        type: body.type,
        items: (body.items ?? []).map((item: { value: string }) => item.value),
      };
      lists.push(created);
      return json({ success: true, result: { id: created.id, name: created.name } });
    }
    if (method === "PATCH" && oneList) {
      const list = lists.find((row) => row.id === oneList[1]);
      if (list) {
        if (typeof body.name === "string") list.name = body.name;
        const remove = new Set<string>(body.remove ?? []);
        list.items = list.items.filter((item) => !remove.has(item));
        for (const row of body.append ?? []) list.items.push(row.value);
      }
      return json({ success: true, result: { id: list?.id, name: list?.name } });
    }
    if (path.startsWith("/gateway/rules")) {
      return json({ success: true, result: [], result_info: { page: 1, per_page: 1000, total_count: 0 } });
    }
    return json({ success: false, errors: [{ message: `unhandled ${method} ${path}` }] }, 400);
  }) as typeof fetch;

  return { fetch: fetchFn, writes, lists, ruleWrites };
}

async function setup(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-asn-"));
  await mkdir(join(dir, "snapshots"), { recursive: true });
  const configPath = join(dir, "config.yaml");
  await writeFile(
    configPath,
    `plan:
  max_items: 300000
  items_per_list: 1000
  list_name_prefix: gateway-list
sources:
  allow:
    - id: personal
      path: ${join(dir, "allow.txt")}
      priority: 100
      required: true
  block:
    - id: personal-block
      path: ${join(dir, "block.txt")}
      priority: 90
      required: true
  asn:
    - id: geolite2-asn
      url: https://git.io/GeoLite2-ASN.mmdb
      format: mmdb
      priority: 20
      required: true
safety:
  abort_if_source_shrinks_pct: 40
  abort_if_allowlist_shrinks: 10
  abort_if_adds_over: 50
  require_review_if_removes_over: 20
policies:
  allow:
    name: gateway-list:allow
    precedence: 1000
  security:
    name: gateway-list:security
    precedence: 2000
    enabled: true
  block:
    name: gateway-list:block
    precedence: 3000
`,
    "utf8",
  );
  await writeFile(join(dir, "allow.txt"), "\n", "utf8");
  await writeFile(join(dir, "block.txt"), "\n", "utf8");
  return { dir, configPath };
}

const creds = {
  loadFile: false as const,
  env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
  sleep: async () => undefined,
};

function run(
  rest: string[],
  extras: {
    dir: string;
    configPath: string;
    fetch: typeof fetch;
    dryRun?: boolean;
    dashboard?: boolean;
  },
): Promise<number> {
  return asnCommand({
    configPath: extras.configPath,
    snapshotsDir: join(extras.dir, "snapshots"),
    dryRun: extras.dryRun ?? false,
    dashboard: extras.dashboard,
    rest,
    fetch: extras.fetch,
    ...creds,
  });
}

test("asn without a subcommand is usage", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run([], { dir, configPath, fetch: fake.fetch }), 1);
  assert.deepEqual(fake.writes, []);
});

test("asn add creates an IP list and never writes a rule", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run(["add", "AS10206"], { dir, configPath, fetch: fake.fetch }), 0);
  assert.equal(fake.lists.length, 1);
  assert.equal(fake.lists[0]?.name, "AS10206 China Unicom Zhongwei Cloud");
  assert.equal(fake.lists[0]?.type, "IP");
  assert.deepEqual(fake.lists[0]?.items.slice().sort(), ["14.1.0.0/16", "14.2.0.0/16"]);
  assert.equal(fake.ruleWrites, 0);
  assert.equal(
    fake.writes.some((row) => row.startsWith("POST /gateway/rules")),
    false,
  );
});

test("asn add --dry-run writes nothing to Cloudflare", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run(["add", "AS10206"], { dir, configPath, fetch: fake.fetch, dryRun: true }), 0);
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.lists.length, 0);
});

test("asn add fails if the list already exists; update patches it", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  fake.lists.push({
    id: "L9",
    name: "AS10206",
    type: "IP",
    items: ["14.1.0.0/16", "9.9.9.0/24"],
  });
  assert.equal(await run(["add", "AS10206"], { dir, configPath, fetch: fake.fetch }), 2);
  assert.equal(await run(["update", "10206"], { dir, configPath, fetch: fake.fetch }), 0);
  assert.equal(fake.lists[0]?.name, "AS10206 China Unicom Zhongwei Cloud");
  assert.ok(fake.lists[0]?.items.includes("14.2.0.0/16"));
  assert.equal(fake.lists[0]?.items.includes("9.9.9.0/24"), false);
  assert.equal(fake.ruleWrites, 0);
});

test("asn update fails when the list is missing", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run(["update", "AS10206"], { dir, configPath, fetch: fake.fetch }), 2);
  assert.deepEqual(fake.writes, []);
});

test("asn add of an unknown ASN refuses without creating a list", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run(["add", "AS64512"], { dir, configPath, fetch: fake.fetch }), 2);
  assert.equal(fake.lists.length, 0);
});

test("asn update --dashboard refreshes other IP AS* lists and leaves the rest alone", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  fake.lists.push(
    { id: "L1", name: "AS10206", type: "IP", items: ["14.1.0.0/16", "9.9.9.0/24"] },
    { id: "L2", name: "AS13335", type: "IP", items: ["1.0.0.0/24"] },
    { id: "L3", name: "ASN136907 HWCLOUDS-AS-AP", type: "IP", items: ["8.8.8.0/24"] },
    { id: "L4", name: "AS64512", type: "IP", items: ["10.0.0.0/8"] },
    { id: "L5", name: "Apple iAd Tracking", type: "DOMAIN", items: ["ads.example"] },
    { id: "L6", name: "corp-ips", type: "IP", items: ["192.0.2.0/24"] },
    { id: "L7", name: "gateway-list:block", type: "DOMAIN", items: ["bad.example"] },
  );
  assert.equal(await run(["update", "--dashboard"], { dir, configPath, fetch: fake.fetch }), 0);
  const byId = Object.fromEntries(fake.lists.map((list) => [list.id, list]));
  assert.equal(byId.L1?.name, "AS10206 China Unicom Zhongwei Cloud");
  assert.deepEqual(byId.L1?.items.slice().sort(), ["14.1.0.0/16", "14.2.0.0/16"]);
  assert.equal(byId.L2?.name, "AS13335 CLOUDFLARENET");
  assert.deepEqual(byId.L2?.items, ["1.0.0.0/24"]);
  assert.equal(byId.L3?.name, "AS136907 HWCLOUDS-AS-AP");
  assert.deepEqual(byId.L3?.items, ["160.19.0.0/16"]);
  assert.equal(byId.L4?.name, "AS64512");
  assert.deepEqual(byId.L4?.items, ["10.0.0.0/8"]);
  assert.deepEqual(byId.L5?.items, ["ads.example"]);
  assert.deepEqual(byId.L6?.items, ["192.0.2.0/24"]);
  assert.deepEqual(byId.L7?.items, ["bad.example"]);
  assert.equal(fake.ruleWrites, 0);
});

test("asn update --dashboard still runs when an owned list omits count on GET", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  fake.lists.push(
    { id: "L1", name: "AS10206", type: "IP", items: ["14.1.0.0/16", "9.9.9.0/24"] },
    {
      id: "L90",
      name: "gateway-list:block-90",
      type: "DOMAIN",
      items: ["bad.example"],
      omitCount: true,
    },
    {
      id: "L91",
      name: "gateway-list:block-91",
      type: "DOMAIN",
      items: ["worse.example"],
      omitCount: true,
    },
  );
  assert.equal(await run(["update", "--dashboard"], { dir, configPath, fetch: fake.fetch }), 0);
  assert.deepEqual(fake.lists[0]?.items.slice().sort(), ["14.1.0.0/16", "14.2.0.0/16"]);
  assert.deepEqual(fake.lists[1]?.items, ["bad.example"]);
  assert.deepEqual(fake.lists[2]?.items, ["worse.example"]);
});

test("asn update --dashboard --dry-run writes nothing", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  fake.lists.push({ id: "L1", name: "AS10206", type: "IP", items: ["9.9.9.0/24"] });
  assert.equal(
    await run(["update"], { dir, configPath, fetch: fake.fetch, dryRun: true, dashboard: true }),
    0,
  );
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(fake.lists[0]?.items, ["9.9.9.0/24"]);
});

test("asn update --dashboard with only unknown ASNs is exit 2", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  fake.lists.push({ id: "L4", name: "AS64512", type: "IP", items: ["10.0.0.0/8"] });
  assert.equal(await run(["update", "--dashboard"], { dir, configPath, fetch: fake.fetch }), 2);
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(fake.lists[0]?.items, ["10.0.0.0/8"]);
});

test("asn update --dashboard with no matching lists is exit 2", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  fake.lists.push(
    { id: "L5", name: "Apple iAd Tracking", type: "DOMAIN", items: ["ads.example"] },
    { id: "L6", name: "corp-ips", type: "IP", items: ["192.0.2.0/24"] },
  );
  assert.equal(await run(["update", "--dashboard"], { dir, configPath, fetch: fake.fetch }), 2);
  assert.deepEqual(fake.writes, []);
});

test("asn update --dashboard does not take an ASN argument", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run(["update", "--dashboard", "AS10206"], { dir, configPath, fetch: fake.fetch }), 1);
  assert.deepEqual(fake.writes, []);
});

test("asn add --dashboard is usage", async () => {
  const { dir, configPath } = await setup();
  const fake = createFake(asnMmdb());
  assert.equal(await run(["add", "--dashboard"], { dir, configPath, fetch: fake.fetch }), 1);
  assert.equal(fake.lists.length, 0);
});
