import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig } from "./config.ts";
import { repoRoot } from "./paths.ts";

const validRaw = {
  plan: {
    max_items: 300000,
    items_per_list: 1000,
    list_name_prefix: "gateway-list",
  },
  sources: {
    allow: [
      {
        id: "personal",
        path: "allowlist/personal.txt",
        priority: 100,
        required: true,
      },
    ],
    block: [
      {
        id: "personal-block",
        path: "blocklist/personal.txt",
        priority: 90,
        required: true,
      },
      {
        id: "oisd-small",
        url: "https://small.oisd.nl/",
        format: "adblock",
        priority: 40,
        required: true,
      },
    ],
    asn: [
      {
        id: "geolite2-asn",
        url: "https://git.io/GeoLite2-ASN.mmdb",
        format: "mmdb",
        priority: 20,
        required: true,
      },
      {
        id: "geolite2-asn-github",
        url: "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-ASN.mmdb",
        format: "mmdb",
        priority: 10,
        required: false,
      },
    ],
  },
  safety: {
    abort_if_source_shrinks_pct: 40,
    abort_if_allowlist_shrinks: 10,
    abort_if_adds_over: 50000,
    require_review_if_removes_over: 1000,
  },
  policies: {
    allow: { name: "gateway-list:allow", precedence: 1000 },
    security: { name: "gateway-list:security", precedence: 2000, enabled: true },
    block: { name: "gateway-list:block", precedence: 3000 },
  },
};

function cloneValid(): typeof validRaw {
  return structuredClone(validRaw);
}

function throwsPath(raw: unknown, path: RegExp, fileLabel?: string): void {
  assert.throws(
    () => (fileLabel === undefined ? parseConfig(raw) : parseConfig(raw, fileLabel)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, path);
      return true;
    },
  );
}

test("repo config.yaml loads and marks oisd-small as adblock", async () => {
  const config = await loadConfig("config.yaml");
  const oisd = config.sources.block.find((source) => source.id === "oisd-small");
  assert.ok(oisd);
  assert.equal(oisd.format, "adblock");
  assert.equal(oisd.url, "https://small.oisd.nl/");
  assert.equal(oisd.path, undefined);
  assert.equal(config.sources.asn[0]?.id, "geolite2-asn");
  assert.equal(config.sources.asn[0]?.format, "mmdb");
  assert.equal(config.sources.asn[0]?.url, "https://git.io/GeoLite2-ASN.mmdb");
  assert.equal(config.sources.asn[1]?.id, "geolite2-asn-github");
});

test("valid fixture parses", () => {
  const config = parseConfig(cloneValid());
  assert.equal(config.plan.maxItems, 300000);
  assert.equal(config.plan.maxLists, undefined);
  assert.equal(config.sources.allow[0]?.id, "personal");
  assert.equal(config.sources.block[1]?.format, "adblock");
  assert.equal(config.policies.network.enabled, false);
  assert.equal(config.policies.network.allow.name, "gateway-list:net:allow");
  assert.equal(config.policies.network.security.name, "gateway-list:net:security");
  assert.equal(config.policies.network.block.name, "gateway-list:net:block");
  assert.equal(config.policies.network.allow.precedence, 1000);
  assert.equal(config.policies.network.block.precedence, 3000);
});

test("policies.network.enabled and name overrides parse", () => {
  const raw = cloneValid() as typeof validRaw & {
    policies: typeof validRaw.policies & {
      network?: {
        enabled?: boolean;
        allow?: { name?: string; precedence?: number };
        block?: { name?: string; precedence?: number };
      };
    };
  };
  raw.policies.network = {
    enabled: true,
    allow: { name: "gateway-list:net:allow", precedence: 1100 },
    block: { name: "gateway-list:sni-block", precedence: 3100 },
  };
  const config = parseConfig(raw);
  assert.equal(config.policies.network.enabled, true);
  assert.equal(config.policies.network.allow.precedence, 1100);
  assert.equal(config.policies.network.block.name, "gateway-list:sni-block");
  assert.equal(config.policies.network.security.name, "gateway-list:net:security");
});

test("network policy names must be unique, owned, and not clash with DNS", () => {
  const clash = cloneValid() as typeof validRaw & {
    policies: typeof validRaw.policies & { network?: { allow?: { name: string } } };
  };
  clash.policies.network = { allow: { name: "gateway-list:allow" } };
  throwsPath(clash, /policies\.network\.allow\.name: clashes with a DNS policy name/);

  const prefix = cloneValid() as typeof validRaw & {
    policies: typeof validRaw.policies & { network?: { allow?: { name: string } } };
  };
  prefix.policies.network = { allow: { name: "other:net:allow" } };
  throwsPath(prefix, /policies\.network\.allow\.name: name must start with "gateway-list"/);

  const dup = cloneValid() as typeof validRaw & {
    policies: typeof validRaw.policies & {
      network?: { allow?: { name: string }; block?: { name: string } };
    };
  };
  dup.policies.network = {
    allow: { name: "gateway-list:net:shared" },
    block: { name: "gateway-list:net:shared" },
  };
  throwsPath(dup, /policies\.network\.block\.name: duplicate network policy name "gateway-list:net:shared"/);
});

test("optional plan.max_lists parses and rejects 0", () => {
  const raw = cloneValid();
  (raw.plan as { max_lists?: number }).max_lists = 200;
  assert.equal(parseConfig(raw).plan.maxLists, 200);
  (raw.plan as { max_lists?: number }).max_lists = 0;
  throwsPath(raw, /plan\.max_lists: expected an integer >= 1/);
});

test("missing required key cites a dotted path", () => {
  const raw = cloneValid();
  // @ts-expect-error intentional
  delete raw.plan.max_items;
  throwsPath(raw, /^config\.yaml: plan\.max_items: expected a number$/);
});

test("errors use the real file label", () => {
  throwsPath({ plan: [] }, /\/tmp\/other\.yaml: plan: expected a mapping/, "/tmp/other.yaml");
});

test("source needs path or url", () => {
  const raw = cloneValid();
  raw.sources.allow[0] = { id: "x", priority: 1, required: true } as (typeof validRaw)["sources"]["allow"][0];
  throwsPath(raw, /sources\.allow\[0\]: needs path or url/);
});

test("source cannot have both path and url", () => {
  const raw = cloneValid();
  raw.sources.allow[0] = {
    id: "x",
    path: "allowlist/personal.txt",
    url: "https://example.com/list.txt",
    priority: 1,
    required: true,
  } as (typeof validRaw)["sources"]["allow"][0];
  throwsPath(raw, /sources\.allow\[0\]: use path or url, not both/);
});

test("duplicate source id across allow and block", () => {
  const raw = cloneValid();
  raw.sources.block[0].id = "personal";
  throwsPath(raw, /sources\.block\[0\]\.id: duplicate source id "personal" \(already sources\.allow\[0\]\)/);
});

test("sources.asn is required and must be mmdb urls", () => {
  const missing = cloneValid();
  // @ts-expect-error intentional
  delete missing.sources.asn;
  throwsPath(missing, /sources\.asn: expected a non-empty list/);

  const pathOnly = cloneValid();
  pathOnly.sources.asn[0] = {
    id: "local-asn",
    path: "snapshots/cache/GeoLite2-ASN.mmdb",
    priority: 1,
    required: true,
  };
  throwsPath(pathOnly, /sources\.asn\[0\]: ASN source needs url/);

  const badFormat = cloneValid();
  badFormat.sources.asn[0] = {
    id: "geolite2-asn",
    url: "https://git.io/GeoLite2-ASN.mmdb",
    format: "adblock",
    priority: 1,
    required: true,
  };
  throwsPath(badFormat, /sources\.asn\[0\]\.format: must be mmdb/);

  const mmdbOnAllow = cloneValid();
  mmdbOnAllow.sources.allow[0] = {
    id: "personal",
    path: "allowlist/personal.txt",
    format: "mmdb",
    priority: 100,
    required: true,
  };
  throwsPath(mmdbOnAllow, /sources\.allow\[0\]\.format: mmdb is only valid under sources\.asn/);
});

test("numeric range checks", () => {
  const cases: Array<{ mutate: (raw: typeof validRaw) => void; path: RegExp }> = [
    {
      mutate: (raw) => {
        raw.plan.max_items = 0;
      },
      path: /plan\.max_items: expected an integer >= 1/,
    },
    {
      mutate: (raw) => {
        raw.plan.items_per_list = 5001;
      },
      path: /plan\.items_per_list: expected an integer <= 5000/,
    },
    {
      mutate: (raw) => {
        raw.plan.items_per_list = 1.5;
      },
      path: /plan\.items_per_list: expected an integer/,
    },
    {
      mutate: (raw) => {
        raw.sources.allow[0].priority = 1.2;
      },
      path: /sources\.allow\[0\]\.priority: expected an integer/,
    },
    {
      mutate: (raw) => {
        raw.safety.abort_if_source_shrinks_pct = 101;
      },
      path: /safety\.abort_if_source_shrinks_pct: expected an integer <= 100/,
    },
    {
      mutate: (raw) => {
        raw.policies.allow.precedence = -1;
      },
      path: /policies\.allow\.precedence: expected an integer >= 0/,
    },
    {
      mutate: (raw) => {
        raw.policies.allow.precedence = 3000;
        raw.policies.block.precedence = 1000;
      },
      path: /policies: expected policies\.allow\.precedence < policies\.security\.precedence < policies\.block\.precedence/,
    },
    {
      mutate: (raw) => {
        (raw.policies as { network?: { allow: { precedence: number }; block: { precedence: number } } }).network = {
          allow: { precedence: 4000 },
          block: { precedence: 3000 },
        };
      },
      path: /policies\.network: expected policies\.network\.allow\.precedence < policies\.network\.security\.precedence < policies\.network\.block\.precedence/,
    },
  ];

  for (const { mutate, path } of cases) {
    const raw = cloneValid();
    mutate(raw);
    throwsPath(raw, path);
  }
});

test("loadConfig missing file names the path", async () => {
  await assert.rejects(
    () => loadConfig("snapshots/does-not-exist.yaml"),
    /snapshots\/does-not-exist\.yaml: file not found \(/,
  );
});

test("loadConfig opens an absolute path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-cfg-"));
  const abs = join(dir, "custom.yaml");
  const { stringify } = await import("yaml");
  await writeFile(abs, stringify(cloneValid()), "utf8");
  const config = await loadConfig(abs);
  assert.equal(config.plan.listNamePrefix, "gateway-list");
  assert.ok(!abs.startsWith(repoRoot));
});
