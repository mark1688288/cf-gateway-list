# Cloudflare Zero Trust Gateway GitOps CLI

Manage **Cloudflare Gateway** allowlists, blocklists, and ASN IP reusable lists from git.

Files in git are the **desired state**. `compile` fetches [OISD](https://small.oisd.nl/)<sup>[1](#fn-oisd)</sup>, [HaGeZi](https://github.com/hagezi/dns-blocklists)<sup>[2](#fn-hagezi)</sup>, and your personal lists, folds child domains, and writes a snapshot. After you review that snapshot, `apply` incrementally patches Gateway lists and Allow/Block policies whose names start with `gateway-list`. GitHub Actions compiles weekly; **it does not change Cloudflare unless you opt in**.

Allow is its own Gateway list plus an Allow policy with higher precedence than Block. Blocking a parent does not also block a child you have allowed.

Separately, `asn add` / `asn update` create or refresh Gateway **IP** reusable lists from [MaxMind GeoLite2-ASN](https://dev.maxmind.com/geoip/docs/databases/asn/)<sup>[3](#fn-maxmind)</sup> (`.mmdb`). They never attach a policy — you wire the list in Zero Trust yourself.

<img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_13" src="https://github.com/user-attachments/assets/bd73fb06-5f63-4e31-81d8-3bee9bc4d547" />

## Quick

`compile` never writes to Cloudflare. `apply` does. Dry-run the first apply.

### Local

```bash
git clone https://github.com/mark1688288/cf-gateway-list.git
cd cf-gateway-list
npm install
cp .env.example .env   # token / account id; needed for lists / diff / apply / suggested / asn
```

Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `.env`. Token needs Account → Zero Trust → Read + Edit.

```bash
node src/cli.ts
```

```
gateway-list> compile
gateway-list> apply --dry-run
gateway-list> apply
```

### Actions

Fork this repository, then set up **your** fork (secrets and variables are not copied):

1. Open the **Actions** tab and enable workflows.
2. Enable **Sync Gateway lists**. The Monday schedule stays off until you do.
3. **Settings → Secrets and variables → Actions**
   - **Secrets** tab → **New repository secret** → name `CLOUDFLARE_API_TOKEN`, paste the token
   - **Variables** tab → **New repository variable** → name `CLOUDFLARE_ACCOUNT_ID`, paste the account id (not a secret)

The workflow compiles every Monday and when you run it by hand. It does **not** apply unless you check apply on a manual run, or set `AUTO_APPLY=true` for the schedule. Leave `AUTO_APPLY` off at first; read the Job Summary, then run **Sync Gateway lists** with apply checked.

## Workflow

Each command does one job: `compile` never writes to Cloudflare, and `apply` never re-fetches sources.

```
Edit allowlist / blocklist / config.yaml
        │
        ▼
     compile          fetch sources, fold, budget → snapshots/desired.json
        │
        ├─ summary    diff vs the previous desired; Job Summary
        ├─ why        explain one domain (allow / block / fold)
        └─ suggested  last week's blocked DNS → allowlist/suggested.txt (copy by hand)
        │
        ├─ lists      live Gateway lists / rules + quota
        └─ diff       desired vs live owned lists
        │
        ▼
  apply --dry-run     plan PATCH / create; write nothing
        │
        ▼
      apply           incremental PATCH of owned lists, then upsert the policy pack
```

To add a remote source or change a personal list, edit `config.yaml` / the `*.txt` files and run `compile`. A new source is labelled `new` (full GET). Later compiles use ETag + SHA-256 to decide `unchanged` (reuse cache) or `updated` (fetch again). If a block set contains both a parent and a child (for example `tracker.example.com` and `ads.tracker.example.com`), the child is folded away so it does not use a list slot.

<img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_4" src="https://github.com/user-attachments/assets/b2b91e97-c792-4dfe-a7c4-6b0655cc1aab" />

## Compile

`compile` reads the sources in [`config.yaml`](config.yaml) and merges them into a desired snapshot. It works without a Cloudflare token. With credentials it also reads live list `count` values (read-only), subtracts items on lists you manage by hand, then applies the [budget](https://github.com/mark1688288/cf-gateway-list/tree/main#quota-and-dropped).

Default sources:

| Role | Source | Kind |
| --- | --- | --- |
| allow | `allowlist/personal.txt` | git-managed, highest priority |
| block | `blocklist/personal.txt` | git-managed, next |
| block | [OISD Small](https://small.oisd.nl/) | remote, required |
| block | [HaGeZi Light](https://github.com/hagezi/dns-blocklists) | remote, required |
| asn | [GeoLite2-ASN.mmdb](https://github.com/P3TERX/GeoLite.mmdb) | `asn add` / `asn update` only; `compile` ignores this group |

Personal sources always beat remotes (higher priority). If the same domain appears more than once, only the highest-priority entry is kept. Add another remote block source under `sources.block` if you need one; the defaults stay conservative on purpose.

Writes:

- `snapshots/desired.json` — allow / block / folded (this is what `apply` uses)
- `snapshots/dropped.json` — domains dropped for budget
- `snapshots/sources.json` — per-source ETag, SHA-256, and `new` / `unchanged` / `updated`
- `snapshots/account-quota.json` — only when credentials are present

All of those are gitignored. Remote bodies are stored at `snapshots/cache/<id>.txt`.

<img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_3" src="https://github.com/user-attachments/assets/752dae21-00d9-46b8-aa12-d77af8e106e4" /><img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_5" src="https://github.com/user-attachments/assets/36cfe9a7-87e1-448b-94f5-ec7feb19dcc8" />

### ETag and SHA-256

Remotes are not downloaded in full every week. Each compile records the source **ETag** (HTTP) and the **SHA-256** of the body.

1. Read that source's previous `sha256` and `etag` from `snapshots/sources.json`.
2. Read `snapshots/cache/<id>.txt`. The cache is valid only if it exists and `sha256(cache)` **exactly matches** the previous hash. A mismatch is treated as no cache.
3. Send `If-None-Match: <etag>` only when the cache is valid. Only **one** ETag is sent (OISD returns 503 if the header is a comma-separated list).
4. Requests pin `Accept-Encoding: identity` so the stored ETag matches the bytes that are hashed (OISD sends `Vary: Accept-Encoding`).
5. **304** → reuse the cache; do not download the body. 304 with an invalid cache → GET again without `If-None-Match`.
6. **200** → overwrite the cache with the new body and hash it.
7. Compare to the previous SHA-256: no previous hash → `new` (first compile, or you added a source); same → `unchanged`; different → `updated`.

A failed cache write does not fail compile; the next run falls back to a full GET. A required remote that parses to 0 domains aborts. An optional source that fails is skipped and marked `optional-failed`.

<img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_6" src="https://github.com/user-attachments/assets/c281348d-8c66-4bf3-8144-315162664cb1" />

### Fold

After block sources are merged, child domains are folded. Gateway DNS Allow / Block rules use:

```
any(dns.domains[*] in $LIST) or dns.fqdn in $LIST
```

The optional Network pack uses the same lists with the SNI equivalent (`net.sni.domains` / `net.sni.host`). `dns.domains` / `net.sni.domains` are the suffix chain, so `tracker.example.com` in the list already covers `ads.tracker.example.com`. Keeping the child would waste a slot.

- Only **block** is folded. Allow stays as written.
- Folding stops at the public suffix (nothing is folded into `co.uk` or `github.io`).
- Folded children are recorded in `desired.json` under `folded` and show up in `why`.

Adding a new list or updating a remote runs fold again whenever the new set has a parent/child relationship with what is already there.

### Quota and dropped

Account `max_items` defaults to 300000. Lists you create in the dashboard (names that do not start with `gateway-list`) still count toward that quota. When live counts are available:

```
budget = max_items − other_items
```

Domains over budget are dropped by priority (local / pinned sources are kept first) and written to `dropped.json`. `lists`, `summary`, and `apply` all show compiled + other.

## Safety

Two layers of guards: one stops a truncated download from looking like “delete half the blocklist”, and the other stops a huge apply from hammering the Gateway API.

**Compile** (against the previous `sources.json`):

| `config.yaml` | Default | Effect |
| --- | ---: | --- |
| `abort_if_source_shrinks_pct` | 40 | Abort if a remote lost ≥ 40% of its lines. A truncated or empty file cannot become a mass delete. |

**Apply** (desired vs live owned lists; add/remove caps are skipped on a first apply to an empty account):

| `config.yaml` | Default | Effect |
| --- | ---: | --- |
| `abort_if_allowlist_shrinks` | 10 | Abort if allow would lose ≥ 10 domains |
| `abort_if_adds_over` | 50000 | Abort if the apply would add more than 50k domains |
| `require_review_if_removes_over` | 1000 | Abort if the apply would remove more than 1000 domains |

`apply` itself is an **incremental PATCH** (`append` / `remove` of drift only). It never deletes every list and recreates them. The client uses a token bucket (burst 8, refill 4/s) and retries HTTP 429 with `Retry-After` (up to 5 attempts). If other + desired exceeds `max_items`, apply refuses. A tripped guard fails the job — do not assume a half-applied rule set is in effect.

Only lists and rules whose names start with `gateway-list` are managed. Dashboard-created objects are left alone.

<img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_9" src="https://github.com/user-attachments/assets/0918aa70-fbf7-4cb4-a564-0838cccf0c5c" />

## Policy pack

`apply` upserts these three DNS policies (names and precedence come from `config.yaml`):

| Precedence | Name | Action | Contents |
| ---: | --- | --- | --- |
| 1000 | `gateway-list:allow` | Allow | personal allow list (and any you add later) |
| 2000 | `gateway-list:security` | Block | Cloudflare security categories |
| 3000 | `gateway-list:block` | Block | compiled block chunks |

Each list holds at most `items_per_list` items (default 1000). If the traffic filter exceeds 4096 characters it is split into `gateway-list:block-1` and so on. An empty allow set disables the Allow rule instead of attaching it to an empty list.

Set `policies.network.enabled: true` to also upsert a Network (Layer 4) pack on the **same** DOMAIN lists. No extra list slots. Traffic is `any(net.sni.domains[*] in $LIST) or net.sni.host in $LIST`. Names default to `gateway-list:net:allow`, `gateway-list:net:security`, and `gateway-list:net:block`, with the same 1000 / 2000 / 3000 precedence inside the Network builder.

That pack only takes effect when devices use the Cloudflare One Client in Gateway with WARP (or Traffic and DNS) and Zero Trust → Traffic settings has **Allow Secure Web Gateway to proxy traffic** → **TCP**. SNI selectors default to HTTPS on port 443. Encrypted Client Hello and connections with no SNI are not matched. DNS-only / Gateway with DoH is not enough. TLS decryption is not required.

## Review

- `summary` — adds/removes vs the previous desired (top 50), each source as `new` / `unchanged` / `updated`, quota, and suggested. Actions writes this to the Job Summary.
- `why <domain>` — explains the snapshot: source, parent-fold / dropped, whether allow wins, and a best-effort guess at which Gateway policy would match. An allow hit notes that the `dns.domains` suffix match also covers children.
- `suggested` — reads last week's blocked queries from Gateway DNS analytics (`gatewayResolverQueriesAdaptiveGroups`) and writes `allowlist/suggested.txt` plus `snapshots/suggested.json` for review. It **does not** write `personal.txt`, and it **is not** committed (live DNS activity). The token also needs Account Analytics Read; missing that permission is a warning, not a failed compile. To allow a domain, copy it into `allowlist/personal.txt` and compile again.

## Requirements

- Node.js 22+ (24 is fine; uses official type stripping, no `tsc` build)
- A Cloudflare Zero Trust account (Free is enough)
- API token: Account → Zero Trust → Read + Edit; `suggested` also needs Account Analytics Read
- Account ID (store it as an Actions **variable**, not a secret)

## Local

Setup is in [Quick](#quick). `node src/cli.ts` opens a shell. Type a command, then Enter:

```
gateway-list> compile
gateway-list> summary
gateway-list> lists
gateway-list> diff
gateway-list> why ads.google.com
gateway-list> suggested
gateway-list> apply --dry-run
gateway-list> apply
gateway-list> asn add AS13335
gateway-list> asn update AS13335
gateway-list> asn update --dashboard
gateway-list> help
gateway-list> exit
```

One-shot form still works for scripts and GitHub Actions (`node src/cli.ts compile`, and so on). `npm test` runs the suite.

```bash
node src/cli.ts --help
npm test
```

## Config

- [`config.yaml`](config.yaml) — sources (allow / block / asn), account `max_items` (300k), safety thresholds; optional `plan.max_lists`
- [`allowlist/personal.txt`](allowlist/personal.txt) — your allow domains (git-managed)
- [`blocklist/personal.txt`](blocklist/personal.txt) — extra domains you want blocked

One domain per line. Lines starting with `#`, `//`, or `!` are comments; a trailing `#` / `//` is stripped too.

## GitHub Actions

Fork and credential setup is in [Quick](#quick). [`.github/workflows/sync.yml`](.github/workflows/sync.yml) is already in the repo.

- Every Monday 03:00 UTC: `compile` + `suggested` + Job Summary + upload the snapshot artifact
- `workflow_dispatch`: checking apply writes the **artifact's** `desired.json` to Cloudflare
- Scheduled apply also requires `AUTO_APPLY=true`; a tripped safety guard fails the job
- No `pull_request` trigger: a PR *into this repository* cannot run compile or apply here. That is not your fork's own Actions.
- A push to `main` that touches `src/`, `config.yaml`, allowlist, or blocklist compiles only — it does not apply

The fork compiles against your Cloudflare account. It cannot use this repository's credentials.

### Pause the schedule

Do this on **your** fork.

| Objective | Do |
| --- | --- |
| No Monday run at all | Disable **Sync Gateway lists** |
| Weekly compile, but never auto-apply | Leave `AUTO_APPLY` unset (the default) |
| No Actions on this fork | Do not enable workflows (forks start this way) |

To stop the Monday cron (and manual **Run workflow**, and push-to-`main` compiles): **Actions** → **Sync Gateway lists** → **⋯** → **Disable workflow**.

```bash
gh workflow disable "Sync Gateway lists"
```

A schedule `keepalive` job re-enables the workflow only when a scheduled run actually happens, so it will **not** turn the workflow back on after you disable it. Secrets and variables stay.

To resume: **Actions** → **Sync Gateway lists** → **Enable workflow**.

```bash
gh workflow enable "Sync Gateway lists"
```

## Commands

```
gateway-list                              interactive shell
gateway-list compile [--config config.yaml]
gateway-list summary [--config config.yaml]
gateway-list lists   [--config config.yaml]
gateway-list diff    [--config config.yaml]
gateway-list apply   [--config config.yaml] [--dry-run]
gateway-list why     <domain>
gateway-list suggested
gateway-list asn add <ASN> [--dry-run]
gateway-list asn update <ASN> [--dry-run]
gateway-list asn update --dashboard [--dry-run]
```

In the shell the commands are the same (`compile`, `summary`, `lists`, `diff`, `apply`, `why <domain>`, `suggested`, `asn add` / `asn update`), plus `help` and `exit`.

## ASN reusable lists

`asn add` / `asn update` are **not** part of `compile` / `apply`. They create or refresh a Gateway **IP** reusable list from [MaxMind GeoLite2-ASN](https://dev.maxmind.com/geoip/docs/databases/asn/) (`.mmdb`). They **never** attach that list to a Gateway rule, so you pick the policy and precedence in Zero Trust yourself.

```
node src/cli.ts asn add AS13335
node src/cli.ts asn update AS13335
node src/cli.ts asn update --dashboard
node src/cli.ts asn add AS13335 --dry-run
```

List name:

- `AS13335` if the database has no organisation
- `AS13335 CLOUDFLARENET` when GeoLite2-ASN has that name

If the prefix set is larger than `plan.items_per_list`, further chunks are `AS13335-2 …`. IPv6 prefixes more specific than `/64` are collapsed (Gateway IP lists). Adjacent prefixes are merged.

`asn update --dashboard` refreshes **every other** (not `gateway-list*`) type=`IP` reusable list whose name is `AS<number>` or `ASN<number>` — the lists you created in the dashboard or with `asn add`. One GeoLite2 walk, then the same incremental PATCH as `asn update AS…`. An ASN with no prefixes in the database is skipped; the rest still update.

URLs come from `sources.asn` in [`config.yaml`](config.yaml) (tried high priority first). The file is cached at `snapshots/cache/GeoLite2-ASN.mmdb`. These lists do **not** use the `gateway-list` prefix, so `apply` will not patch them or create a rule for them.

To use a list, create a Gateway policy in Zero Trust that references it (name it something other than `gateway-list*`) and set precedence yourself. Typical traffic filter:

```
any(net.dst.ip in $<list_id>)
```

<img width="1376" height="768" alt="Cloudflare_Zero_Trust_GitOps_-_Slide_11" src="https://github.com/user-attachments/assets/2c3aa835-8fb6-4f18-a5db-adb37765d13b" />

## License

[MIT](LICENSE) © mark1688288

---

<sup id="fn-oisd">1</sup> [OISD](https://oisd.nl/) ([Small](https://small.oisd.nl/)) — community DNS blocklist, mainly ads. By [sjhgvr](https://github.com/sjhgvr/oisd).

<sup id="fn-hagezi">2</sup> [HaGeZi](https://github.com/hagezi/dns-blocklists) (Light) — DNS blocklist for ads, trackers, telemetry, and some malware. By [hagezi](https://github.com/hagezi).

<sup id="fn-maxmind">3</sup> [MaxMind GeoLite2-ASN](https://dev.maxmind.com/geoip/docs/databases/asn/) — IP prefixes for each autonomous system. This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).
