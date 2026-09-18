import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplyAbortError,
  MAX_TRAFFIC_CHARS,
  buildApplyPlan,
  checkApplySafety,
  chunkListIdsByTraffic,
  listSniTraffic,
  listTraffic,
  planIsNoop,
  planListUpdates,
  securitySniTraffic,
  securityTraffic,
} from "./apply-plan.ts";
import { defaultNetworkPolicies } from "./config.ts";
import type { Config, DesiredSnapshot } from "./types.ts";

function config(
  over: Partial<Config["plan"]> = {},
  policyOver: Partial<Config["policies"]["network"]> = {},
): Config {
  const dns = {
    allow: { name: "gateway-list:allow", precedence: 1000 },
    security: { name: "gateway-list:security", precedence: 2000, enabled: true },
    block: { name: "gateway-list:block", precedence: 3000 },
  };
  return {
    plan: {
      maxItems: 300000,
      itemsPerList: 2,
      listNamePrefix: "gateway-list",
      ...over,
    },
    sources: { allow: [], block: [], asn: [] },
    safety: {
      abortIfSourceShrinksPct: 40,
      abortIfAllowlistShrinks: 10,
      abortIfAddsOver: 50,
      requireReviewIfRemovesOver: 20,
    },
    policies: {
      ...dns,
      network: { ...defaultNetworkPolicies("gateway-list", dns), ...policyOver },
    },
  };
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

test("planListUpdates fills an existing list before creating a chunk", () => {
  const { patches, creates } = planListUpdates(
    ["a.example.com", "b.example.com", "c.example.com"],
    [{ id: "L0", name: "gateway-list:block", items: ["a.example.com"] }],
    "gateway-list",
    "block",
    2,
  );
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]?.append, ["b.example.com"]);
  assert.deepEqual(patches[0]?.remove, []);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.name, "gateway-list:block-1");
  assert.deepEqual(creates[0]?.items, ["c.example.com"]);
});

test("planListUpdates removes stale items and does not delete the list", () => {
  const { patches, creates } = planListUpdates(
    ["keep.example.com"],
    [{ id: "L0", name: "gateway-list:allow", items: ["keep.example.com", "gone.example.com"] }],
    "gateway-list",
    "allow",
    1000,
  );
  assert.deepEqual(patches[0]?.remove, ["gone.example.com"]);
  assert.deepEqual(creates, []);
});

test("chunkListIdsByTraffic splits before exceeding the expression budget", () => {
  const ids = Array.from({ length: 80 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  const chunks = chunkListIdsByTraffic(ids, MAX_TRAFFIC_CHARS);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(listTraffic(chunk).length <= MAX_TRAFFIC_CHARS);
  }
});

test("first apply skips the add tripwire; later huge adds abort", () => {
  const cfg = config();
  const first = buildApplyPlan({
    config: cfg,
    desired: desiredOf([], Array.from({ length: 80 }, (_, i) => `n${i}.example.com`)),
    allowLiveLists: [],
    blockLiveLists: [],
    existingRules: [],
  });
  assert.equal(first.firstApply, true);
  assert.doesNotThrow(() => checkApplySafety(first, cfg));

  const later = buildApplyPlan({
    config: cfg,
    desired: desiredOf([], Array.from({ length: 80 }, (_, i) => `n${i}.example.com`)),
    allowLiveLists: [],
    blockLiveLists: [{ id: "L0", name: "gateway-list:block", items: ["old.example.com"] }],
    existingRules: [],
  });
  assert.equal(later.firstApply, false);
  assert.throws(() => checkApplySafety(later, cfg), ApplyAbortError);
});

test("allow shrink tripwire", () => {
  const cfg = config();
  const plan = buildApplyPlan({
    config: cfg,
    desired: desiredOf(["keep.example.com"], []),
    allowLiveLists: [
      {
        id: "A0",
        name: "gateway-list:allow",
        items: Array.from({ length: 12 }, (_, i) => `a${i}.example.com`).concat("keep.example.com"),
      },
    ],
    blockLiveLists: [],
    existingRules: [],
  });
  assert.throws(() => checkApplySafety(plan, cfg), /allow list would lose/);
});

test("planIsNoop when live already matches desired", () => {
  const plan = buildApplyPlan({
    config: config(),
    desired: desiredOf(["maps.google.com"], ["ads.example.com"]),
    allowLiveLists: [{ id: "A0", name: "gateway-list:allow", items: ["maps.google.com"] }],
    blockLiveLists: [{ id: "B0", name: "gateway-list:block", items: ["ads.example.com"] }],
    existingRules: [
      {
        id: "R0",
        name: "gateway-list:allow",
        precedence: 1000,
        action: "allow",
        enabled: true,
        traffic: listTraffic(["A0"]),
      },
      {
        id: "R1",
        name: "gateway-list:security",
        precedence: 2000,
        action: "block",
        enabled: true,
        traffic: securityTraffic(),
      },
      {
        id: "R2",
        name: "gateway-list:block",
        precedence: 3000,
        action: "block",
        enabled: true,
        traffic: listTraffic(["B0"]),
      },
    ],
  });
  assert.equal(planIsNoop(plan), true);
});

test("listSniTraffic matches fold semantics", () => {
  assert.equal(
    listSniTraffic(["A0", "B0"]),
    "any(net.sni.domains[*] in $A0) or net.sni.host in $A0 or any(net.sni.domains[*] in $B0) or net.sni.host in $B0",
  );
  assert.equal(
    securitySniTraffic(),
    "any(net.fqdn.security_category[*] in {80 83 131 151 187 191})",
  );
});

test("chunkListIdsByTraffic splits SNI expressions before the budget", () => {
  const ids = Array.from({ length: 80 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  const chunks = chunkListIdsByTraffic(ids, MAX_TRAFFIC_CHARS, listSniTraffic);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(listSniTraffic(chunk).length <= MAX_TRAFFIC_CHARS);
  }
});

test("network pack is omitted when disabled and leftover net rules are disabled", () => {
  const plan = buildApplyPlan({
    config: config(),
    desired: desiredOf(["maps.google.com"], ["ads.example.com"]),
    allowLiveLists: [{ id: "A0", name: "gateway-list:allow", items: ["maps.google.com"] }],
    blockLiveLists: [{ id: "B0", name: "gateway-list:block", items: ["ads.example.com"] }],
    existingRules: [
      {
        id: "N0",
        name: "gateway-list:net:block",
        precedence: 3000,
        action: "block",
        enabled: true,
        filters: "l4",
        traffic: listSniTraffic(["B0"]),
      },
    ],
  });
  assert.equal(
    plan.rules.some((rule) => rule.name.startsWith("gateway-list:net:")),
    false,
  );
  assert.deepEqual(plan.disableRules, [{ id: "N0", name: "gateway-list:net:block" }]);
});

test("network pack reuses list IDs with l4 SNI traffic when enabled", () => {
  const plan = buildApplyPlan({
    config: config({}, { enabled: true }),
    desired: desiredOf(["maps.google.com"], ["ads.example.com"]),
    allowLiveLists: [{ id: "A0", name: "gateway-list:allow", items: ["maps.google.com"] }],
    blockLiveLists: [{ id: "B0", name: "gateway-list:block", items: ["ads.example.com"] }],
    existingRules: [],
  });
  const netAllow = plan.rules.find((rule) => rule.name === "gateway-list:net:allow");
  const netBlock = plan.rules.find((rule) => rule.name === "gateway-list:net:block");
  const netSecurity = plan.rules.find((rule) => rule.name === "gateway-list:net:security");
  assert.equal(netAllow?.filters, "l4");
  assert.equal(netAllow?.action, "allow");
  assert.equal(netAllow?.traffic, listSniTraffic(["A0"]));
  assert.equal(netBlock?.filters, "l4");
  assert.equal(netBlock?.traffic, listSniTraffic(["B0"]));
  assert.equal(netSecurity?.filters, "l4");
  assert.equal(netSecurity?.traffic, securitySniTraffic());
  assert.ok(plan.rules.some((rule) => rule.name === "gateway-list:allow" && rule.filters === "dns"));
});

test("planIsNoop when DNS and Network already match", () => {
  const plan = buildApplyPlan({
    config: config({}, { enabled: true }),
    desired: desiredOf(["maps.google.com"], ["ads.example.com"]),
    allowLiveLists: [{ id: "A0", name: "gateway-list:allow", items: ["maps.google.com"] }],
    blockLiveLists: [{ id: "B0", name: "gateway-list:block", items: ["ads.example.com"] }],
    existingRules: [
      {
        id: "R0",
        name: "gateway-list:allow",
        precedence: 1000,
        action: "allow",
        enabled: true,
        filters: "dns",
        traffic: listTraffic(["A0"]),
      },
      {
        id: "R1",
        name: "gateway-list:security",
        precedence: 2000,
        action: "block",
        enabled: true,
        filters: "dns",
        traffic: securityTraffic(),
      },
      {
        id: "R2",
        name: "gateway-list:block",
        precedence: 3000,
        action: "block",
        enabled: true,
        filters: "dns",
        traffic: listTraffic(["B0"]),
      },
      {
        id: "N0",
        name: "gateway-list:net:allow",
        precedence: 1000,
        action: "allow",
        enabled: true,
        filters: "l4",
        traffic: listSniTraffic(["A0"]),
      },
      {
        id: "N1",
        name: "gateway-list:net:security",
        precedence: 2000,
        action: "block",
        enabled: true,
        filters: "l4",
        traffic: securitySniTraffic(),
      },
      {
        id: "N2",
        name: "gateway-list:net:block",
        precedence: 3000,
        action: "block",
        enabled: true,
        filters: "l4",
        traffic: listSniTraffic(["B0"]),
      },
    ],
  });
  assert.equal(planIsNoop(plan), true);
});
