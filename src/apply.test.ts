import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyCommand } from "./commands/apply.ts";
import type { DesiredSnapshot } from "./types.ts";

const TOKEN = "cfut_test_token_do_not_leak";
const ACCOUNT = "accttest000000000000000000000001";

type FakeList = { id: string; name: string; items: string[]; type?: string; omitCount?: boolean };
type FakeRule = {
  id: string;
  name: string;
  precedence: number;
  action: string;
  enabled: boolean;
  traffic: string;
  filters?: string[];
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function createFakeGateway(): { fetch: typeof fetch; writes: string[]; lists: FakeList[]; rules: FakeRule[] } {
  const lists: FakeList[] = [];
  const rules: FakeRule[] = [];
  const writes: string[] = [];
  let seq = 1;

  const fetchFn = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "GET") writes.push(`${method} ${path}`);

    if (method === "GET" && path === "/gateway/lists") {
      return json({
        success: true,
        result: lists.map((list) => ({
          id: list.id,
          name: list.name,
          type: list.type,
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
              type: list.type,
              ...(list.omitCount ? {} : { count: list.items.length }),
            }
          : {},
      });
    }
    if (method === "POST" && path === "/gateway/lists") {
      const created: FakeList = {
        id: `L${seq++}`,
        name: body.name,
        items: (body.items ?? []).map((item: { value: string }) => item.value),
      };
      lists.push(created);
      return json({ success: true, result: { id: created.id, name: created.name } });
    }
    if (method === "PATCH" && oneList) {
      const list = lists.find((row) => row.id === oneList[1]);
      if (list) {
        const remove = new Set<string>(body.remove ?? []);
        list.items = list.items.filter((item) => !remove.has(item));
        for (const row of body.append ?? []) list.items.push(row.value);
      }
      return json({ success: true, result: { id: list?.id, name: list?.name } });
    }
    if (method === "GET" && path === "/gateway/rules") {
      return json({
        success: true,
        result: rules,
        result_info: { page: 1, per_page: 1000, total_count: rules.length },
      });
    }
    if (method === "POST" && path === "/gateway/rules") {
      const created: FakeRule = {
        id: `R${seq++}`,
        name: body.name,
        precedence: body.precedence,
        action: body.action,
        enabled: body.enabled !== false,
        traffic: body.traffic,
        filters: body.filters,
      };
      rules.push(created);
      return json({ success: true, result: created });
    }
    const oneRule = /^\/gateway\/rules\/([^/]+)$/.exec(path);
    if (method === "PUT" && oneRule) {
      const rule = rules.find((row) => row.id === oneRule[1]);
      if (rule) {
        rule.name = body.name;
        rule.precedence = body.precedence;
        rule.action = body.action;
        rule.enabled = body.enabled !== false;
        rule.traffic = body.traffic;
        rule.filters = body.filters ?? rule.filters;
      }
      return json({ success: true, result: rule ?? body });
    }
    return json({ success: false, errors: [{ message: `unhandled ${method} ${path}` }] }, 400);
  }) as typeof fetch;

  return { fetch: fetchFn, writes, lists, rules };
}

function desiredOf(allow: string[], block: string[]): DesiredSnapshot {
  return {
    version: 2,
    phase: 3,
    generatedAt: "2026-01-01T00:00:00.000Z",
    note: "t",
    configPath: "config.yaml",
    allow: allow.map((domain) => ({ domain, sourceId: "personal" })),
    block: block.map((domain) => ({ domain, sourceId: "oisd" })),
    folded: [],
    remote: { fetched: [] },
    counts: { allow: allow.length, block: block.length, folded: 0, dropped: 0 },
  };
}

async function setup(
  desired: DesiredSnapshot,
  extras: { itemsPerList?: number; maxItems?: number; maxLists?: number; networkEnabled?: boolean } = {},
): Promise<{ dir: string; configPath: string }> {
  const itemsPerList = extras.itemsPerList ?? 2;
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-apply-"));
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await writeFile(join(dir, "snapshots", "desired.json"), `${JSON.stringify(desired)}\n`, "utf8");
  const configPath = join(dir, "config.yaml");
  await writeFile(
    configPath,
    `plan:
  max_items: ${extras.maxItems ?? 300000}
  items_per_list: ${itemsPerList}
  list_name_prefix: gateway-list
${extras.maxLists === undefined ? "" : `  max_lists: ${extras.maxLists}`}
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
  network:
    enabled: ${extras.networkEnabled === true}
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

test("dry-run prints a plan and writes nothing", async () => {
  const { dir, configPath } = await setup(desiredOf(["maps.google.com"], ["ads.example.com"]));
  const fake = createFakeGateway();
  const code = await applyCommand({
    configPath,
    snapshotsDir: join(dir, "snapshots"),
    dryRun: true,
    fetch: fake.fetch,
    ...creds,
  });
  assert.equal(code, 0);
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.lists.length, 0);
  await assert.rejects(() => access(join(dir, "snapshots", "last-applied.json")));
});

test("first apply creates lists then rules; second apply is a no-op", async () => {
  const { dir, configPath } = await setup(
    desiredOf(["maps.google.com"], ["ads.example.com", "tracker.example.net"]),
  );
  const fake = createFakeGateway();
  const run = (dryRun: boolean) =>
    applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun,
      fetch: fake.fetch,
      ...creds,
    });

  assert.equal(await run(false), 0);
  assert.ok(fake.writes.some((row) => row.startsWith("POST /gateway/lists")));
  assert.ok(fake.writes.some((row) => row.startsWith("POST /gateway/rules")));
  assert.ok(fake.rules.some((rule) => rule.name === "gateway-list:allow" && rule.action === "allow"));
  assert.ok(fake.rules.some((rule) => rule.name === "gateway-list:block" && rule.action === "block"));
  assert.ok(fake.rules.some((rule) => rule.name === "gateway-list:security"));
  assert.match(
    fake.rules.find((rule) => rule.name === "gateway-list:allow")?.traffic ?? "",
    /dns\.domains/,
  );
  await access(join(dir, "snapshots", "last-applied.json"));

  const writesAfterFirst = fake.writes.length;
  assert.equal(await run(false), 0);
  assert.equal(fake.writes.length, writesAfterFirst);
});

test("apply fills an existing owned list before creating another", async () => {
  const { dir, configPath } = await setup(
    desiredOf([], ["a.example.com", "b.example.com", "c.example.com"]),
  );
  const fake = createFakeGateway();
  fake.lists.push({ id: "L0", name: "gateway-list:block", items: ["a.example.com"] });
  assert.equal(
    await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: false,
      fetch: fake.fetch,
      ...creds,
    }),
    0,
  );
  const original = fake.lists.find((list) => list.id === "L0");
  assert.ok(original?.items.includes("a.example.com"));
  assert.ok(original?.items.includes("b.example.com"));
  assert.equal(fake.lists.some((list) => list.name === "gateway-list:block-1"), true);
  assert.equal(
    fake.writes.some((row) => row.startsWith("DELETE")),
    false,
  );
});

test("apply does not mutate a human-created list", async () => {
  const { dir, configPath } = await setup(desiredOf([], ["ads.example.com"]));
  const fake = createFakeGateway();
  fake.lists.push({ id: "H1", name: "my-hand-list", items: ["keep.example.com"] });
  assert.equal(
    await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: false,
      fetch: fake.fetch,
      ...creds,
    }),
    0,
  );
  const human = fake.lists.find((list) => list.id === "H1");
  assert.deepEqual(human?.items, ["keep.example.com"]);
  assert.equal(
    fake.writes.some((row) => row.includes("H1")),
    false,
  );
});

test("apply refuses an allow shrink tripwire", async () => {
  const { dir, configPath } = await setup(desiredOf(["keep.example.com"], []));
  const fake = createFakeGateway();
  fake.lists.push({
    id: "A0",
    name: "gateway-list:allow",
    items: Array.from({ length: 12 }, (_, i) => `a${i}.example.com`).concat("keep.example.com"),
  });
  const code = await applyCommand({
    configPath,
    snapshotsDir: join(dir, "snapshots"),
    dryRun: false,
    fetch: fake.fetch,
    ...creds,
  });
  assert.equal(code, 2);
  assert.deepEqual(fake.writes, []);
});

test("apply --dry-run refuses when other lists + desired exceed max_items", async () => {
  const { dir, configPath } = await setup(desiredOf(["maps.google.com"], ["ads.example.com"]), {
    maxItems: 5,
  });
  const fake = createFakeGateway();
  fake.lists.push({
    id: "H1",
    name: "corp-ips",
    type: "IP",
    items: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
  });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg ?? ""));
  };
  try {
    const code = await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: true,
      fetch: fake.fetch,
      ...creds,
    });
    assert.equal(code, 2);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join("\n"), /other lists 4 \+ desired 2 = 6 exceeds max_items 5/);
  assert.deepEqual(fake.writes, []);
});

test("apply counts other-list items when GET omits count", async () => {
  const { dir, configPath } = await setup(desiredOf([], ["ads.example.com"]));
  const fake = createFakeGateway();
  fake.lists.push({
    id: "H2",
    name: "mystery",
    type: "DOMAIN",
    items: ["x.example.com"],
    omitCount: true,
  });
  const logs: string[] = [];
  const orig = console.log;
  console.log = (msg?: unknown) => {
    logs.push(String(msg ?? ""));
  };
  try {
    const code = await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: true,
      fetch: fake.fetch,
      ...creds,
    });
    assert.equal(code, 0);
  } finally {
    console.log = orig;
  }
  assert.match(logs.join("\n"), /other 1 \+ desired 1 = 2/);
  assert.deepEqual(fake.writes, []);
});

test("apply refuses when list slots would exceed max_lists", async () => {
  const { dir, configPath } = await setup(
    desiredOf([], ["a.example.com", "b.example.com", "c.example.com"]),
    { maxLists: 2, itemsPerList: 1 },
  );
  const fake = createFakeGateway();
  fake.lists.push({ id: "H1", name: "human-a", items: ["keep.example.com"] });
  fake.lists.push({ id: "H2", name: "human-b", items: ["also.example.com"] });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg ?? ""));
  };
  try {
    const code = await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: true,
      fetch: fake.fetch,
      ...creds,
    });
    assert.equal(code, 2);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join("\n"), /exceeds max_lists 2/);
  assert.deepEqual(fake.writes, []);
});

test("apply with network.enabled upserts l4 rules on the same list IDs", async () => {
  const { dir, configPath } = await setup(
    desiredOf(["maps.google.com"], ["ads.example.com"]),
    { networkEnabled: true },
  );
  const fake = createFakeGateway();
  assert.equal(
    await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: false,
      fetch: fake.fetch,
      ...creds,
    }),
    0,
  );
  const dnsAllow = fake.rules.find((rule) => rule.name === "gateway-list:allow");
  const netAllow = fake.rules.find((rule) => rule.name === "gateway-list:net:allow");
  const netBlock = fake.rules.find((rule) => rule.name === "gateway-list:net:block");
  const netSecurity = fake.rules.find((rule) => rule.name === "gateway-list:net:security");
  assert.deepEqual(dnsAllow?.filters, ["dns"]);
  assert.deepEqual(netAllow?.filters, ["l4"]);
  assert.deepEqual(netBlock?.filters, ["l4"]);
  assert.deepEqual(netSecurity?.filters, ["l4"]);
  assert.match(netAllow?.traffic ?? "", /net\.sni\.domains/);
  assert.match(netAllow?.traffic ?? "", /net\.sni\.host/);
  assert.match(netBlock?.traffic ?? "", /net\.sni\.host/);
  assert.match(netSecurity?.traffic ?? "", /net\.fqdn\.security_category/);
  const allowId = fake.lists.find((list) => list.name === "gateway-list:allow")?.id;
  const blockId = fake.lists.find((list) => list.name === "gateway-list:block")?.id;
  assert.ok(allowId);
  assert.ok(blockId);
  assert.match(netAllow?.traffic ?? "", new RegExp(`\\$${allowId}`));
  assert.match(dnsAllow?.traffic ?? "", new RegExp(`\\$${allowId}`));
  assert.match(netBlock?.traffic ?? "", new RegExp(`\\$${blockId}`));
});

test("apply disables leftover network rules when the pack is off", async () => {
  const { dir, configPath } = await setup(desiredOf(["maps.google.com"], ["ads.example.com"]));
  const fake = createFakeGateway();
  fake.lists.push({ id: "A0", name: "gateway-list:allow", items: ["maps.google.com"] });
  fake.lists.push({ id: "B0", name: "gateway-list:block", items: ["ads.example.com"] });
  fake.rules.push({
    id: "N0",
    name: "gateway-list:net:block",
    precedence: 3000,
    action: "block",
    enabled: true,
    traffic: "any(net.sni.domains[*] in $B0) or net.sni.host in $B0",
    filters: ["l4"],
  });
  assert.equal(
    await applyCommand({
      configPath,
      snapshotsDir: join(dir, "snapshots"),
      dryRun: false,
      fetch: fake.fetch,
      ...creds,
    }),
    0,
  );
  const leftover = fake.rules.find((rule) => rule.id === "N0");
  assert.equal(leftover?.enabled, false);
  assert.deepEqual(leftover?.filters, ["l4"]);
  assert.equal(
    fake.rules.some((rule) => rule.name === "gateway-list:net:allow" && rule.enabled !== false),
    false,
  );
});
