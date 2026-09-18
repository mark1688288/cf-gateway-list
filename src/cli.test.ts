import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./paths.ts";
import { DESIRED_SNAPSHOT_PHASE, DESIRED_SNAPSHOT_VERSION } from "./types.ts";

const cli = resolve(repoRoot, "src/cli.ts");

function runCli(
  args: string[],
  cwd = repoRoot,
  env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("invalid config exits 1 and cites the actual file plus a dotted path", () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-list-cli-"));
  const abs = join(dir, "broken.yaml");
  writeFileSync(abs, "plan: []\n", "utf8");

  const result = runCli(["compile", "--config", abs], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${escapeRegExp(abs)}: plan: expected a mapping`));
});

test("compile --config /abs/path opens that file, not repo+abs", () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-list-cli-ok-"));
  const abs = join(dir, "local.yaml");
  writeFileSync(
    abs,
    `plan:
  max_items: 300000
  items_per_list: 1000
  list_name_prefix: gateway-list
sources:
  allow:
    - id: personal
      path: allowlist/personal.txt
      priority: 100
      required: true
  block:
    - id: personal-block
      path: blocklist/personal.txt
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
  const snapshotsDir = join(dir, "snapshots");
  const result = runCli(["compile", "--config", abs], tmpdir(), {
    GATEWAY_LIST_SNAPSHOTS: snapshotsDir,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote:\s+snapshots\/desired\.json/);
  assert.doesNotMatch(result.stderr, /ENOENT/);

  const desired = JSON.parse(
    readFileSync(join(snapshotsDir, "desired.json"), "utf8"),
  ) as {
    version: number;
    phase: number;
    allow: unknown;
    block: unknown;
    folded: unknown;
    remote: { fetched: unknown };
  };
  assert.equal(desired.version, DESIRED_SNAPSHOT_VERSION);
  assert.equal(desired.phase, DESIRED_SNAPSHOT_PHASE);
  assert.ok(Array.isArray(desired.allow));
  assert.ok(Array.isArray(desired.block));
  assert.ok(Array.isArray(desired.folded));
  assert.deepEqual(desired.remote.fetched, []);
});

test("--help prints usage and does not start the shell", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /interactive shell/);
  assert.match(result.stdout, /compile/);
  assert.match(result.stdout, /asn add/);
});

test("no args starts a shell; help and exit", () => {
  const result = spawnSync(process.execPath, [cli], {
    cwd: repoRoot,
    encoding: "utf8",
    input: "help\nexit\n",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /interactive shell/);
  assert.match(result.stdout, /compile/);
});

test("shell unknown command stays open until exit", () => {
  const result = spawnSync(process.execPath, [cli], {
    cwd: repoRoot,
    encoding: "utf8",
    input: "nope\nexit\n",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /unknown command: nope/);
});

test("shell why without a domain does not quit the session", () => {
  const result = spawnSync(process.execPath, [cli], {
    cwd: repoRoot,
    encoding: "utf8",
    input: "why\nexit\n",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /usage: why <domain>/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
