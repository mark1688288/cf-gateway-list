import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whyCommand } from "./commands/why.ts";
import type { Config, DesiredSnapshot } from "./types.ts";
import { defaultNetworkPolicies } from "./config.ts";
import { renderWhy } from "./why.ts";

const dns = {
  allow: { name: "gateway-list:allow", precedence: 1000 },
  security: { name: "gateway-list:security", precedence: 2000, enabled: true },
  block: { name: "gateway-list:block", precedence: 3000 },
};
const policies: Config["policies"] = {
  ...dns,
  network: defaultNetworkPolicies("gateway-list", dns),
};

function snapshot(over: Partial<DesiredSnapshot> = {}): DesiredSnapshot {
  return {
    version: 2,
    phase: 3,
    generatedAt: "2026-01-01T00:00:00.000Z",
    note: "t",
    configPath: "config.yaml",
    allow: [],
    block: [{ domain: "google.com", sourceId: "oisd-small" }],
    folded: [{ domain: "ads.google.com", sourceId: "oisd-small", parent: "google.com" }],
    remote: { fetched: ["oisd-small"] },
    counts: { allow: 0, block: 1, folded: 1, dropped: 0 },
    ...over,
  };
}

test("why ads.google.com is a stable, testable block of text", () => {
  const text = renderWhy({
    query: "ads.google.com",
    desired: snapshot(),
    policies,
  });
  assert.equal(
    text,
    [
      "why ads.google.com",
      "  normalized:     ads.google.com",
      "  sources:        oisd-small (block, folded)",
      "  folded:         yes (parent google.com)",
      "  dropped:        no",
      "  allow:          no",
      "  allow-wins:     no",
      "  policy:         gateway-list:block",
      "",
    ].join("\n"),
  );
});

test("why reports allow winning a child of an allowed parent", () => {
  const text = renderWhy({
    query: "maps.google.com",
    desired: snapshot({
      allow: [{ domain: "google.com", sourceId: "personal" }],
    }),
    policies,
  });
  assert.match(text, /allow-wins:     yes/);
  assert.match(text, /allow:          yes \(suffix of google\.com\)/);
  assert.match(
    text,
    /allow-children: yes - dns\.domains suffix match also covers children of google\.com/,
  );
  assert.match(text, /policy:         gateway-list:allow/);
  assert.match(text, /personal \(allow google\.com\)/);
});

test("why reports a dropped domain", () => {
  const text = renderWhy({
    query: "extra.example.com",
    desired: snapshot({ block: [], folded: [] }),
    dropped: [{ domain: "extra.example.com", sourceId: "oisd-small", reason: "budget" }],
    policies,
  });
  assert.match(text, /dropped:        yes \(budget\)/);
  assert.match(text, /oisd-small \(dropped:budget\)/);
});

test("why unknown domain falls back to security policy best effort", () => {
  const text = renderWhy({
    query: "unknown.example.net",
    desired: snapshot({ block: [], folded: [] }),
    policies,
  });
  assert.match(text, /sources:        \(none\)/);
  assert.match(text, /policy:         gateway-list:security \(possible; categories not in snapshot\)/);
  assert.doesNotMatch(text, /network-policy:/);
});

test("why names the matching network policy when enabled", () => {
  const text = renderWhy({
    query: "ads.google.com",
    desired: snapshot(),
    policies: { ...policies, network: { ...policies.network, enabled: true } },
  });
  assert.match(text, /policy:         gateway-list:block/);
  assert.match(text, /network-policy: gateway-list:net:block/);
});

test("why command exits 1 without a snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-why-"));
  await writeFile(
    join(dir, "config.yaml"),
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
  abort_if_adds_over: 50000
  require_review_if_removes_over: 1000
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
  const code = await whyCommand({
    domain: "ads.google.com",
    configPath: join(dir, "config.yaml"),
    snapshotsDir: join(dir, "snapshots"),
  });
  assert.equal(code, 1);
});

test("why command prints from a snapshot directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-why-ok-"));
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await writeFile(join(dir, "snapshots", "desired.json"), `${JSON.stringify(snapshot())}\n`, "utf8");
  await writeFile(
    join(dir, "config.yaml"),
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
  abort_if_adds_over: 50000
  require_review_if_removes_over: 1000
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
  const code = await whyCommand({
    domain: "ads.google.com",
    configPath: join(dir, "config.yaml"),
    snapshotsDir: join(dir, "snapshots"),
  });
  assert.equal(code, 0);
});
