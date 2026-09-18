import { foldableParents, normalizeDomain } from "./compiler.ts";
import type { Config, DesiredSnapshot, DroppedDomain } from "./types.ts";

export type WhyInput = {
  query: string;
  desired: DesiredSnapshot;
  dropped?: DroppedDomain[];
  policies: Config["policies"];
};

function byDomain<T extends { domain: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.domain.toLowerCase(), row]));
}

export function renderWhy(input: WhyInput): string {
  const raw = input.query.trim();
  const normalized = normalizeDomain(raw) ?? raw.toLowerCase();
  const allowBy = byDomain(input.desired.allow);
  const blockBy = byDomain(input.desired.block);
  const foldedBy = byDomain(input.desired.folded);
  const droppedBy = byDomain(input.dropped ?? []);

  const exactAllow = allowBy.get(normalized);
  const exactBlock = blockBy.get(normalized);
  const folded = foldedBy.get(normalized);
  const dropped = droppedBy.get(normalized);

  const ancestors = foldableParents(normalized);
  const suffixAllow = ancestors.map((parent) => allowBy.get(parent)).find((row) => row);
  const suffixBlock = ancestors.map((parent) => blockBy.get(parent)).find((row) => row);

  const sourceNotes: string[] = [];
  if (exactAllow) sourceNotes.push(`${exactAllow.sourceId} (allow)`);
  if (suffixAllow && suffixAllow.domain !== normalized) {
    sourceNotes.push(`${suffixAllow.sourceId} (allow ${suffixAllow.domain})`);
  }
  if (exactBlock) sourceNotes.push(`${exactBlock.sourceId} (block)`);
  if (folded) sourceNotes.push(`${folded.sourceId} (block, folded)`);
  if (suffixBlock && !exactBlock && !folded) {
    sourceNotes.push(`${suffixBlock.sourceId} (block ${suffixBlock.domain})`);
  }
  if (dropped) sourceNotes.push(`${dropped.sourceId} (dropped:${dropped.reason})`);
  sourceNotes.sort();

  const allowHit = Boolean(exactAllow || suffixAllow);
  const blockHit = Boolean(exactBlock || folded || suffixBlock);

  let allow = "no";
  if (exactAllow) allow = "yes (exact)";
  else if (suffixAllow) allow = `yes (suffix of ${suffixAllow.domain})`;

  const allowDomain = exactAllow?.domain ?? suffixAllow?.domain;
  let policy: string;
  let networkPolicy: string | undefined;
  if (allowHit && input.policies.allow.name) {
    policy = input.policies.allow.name;
    if (input.policies.network.enabled) networkPolicy = input.policies.network.allow.name;
  } else if (blockHit) {
    policy = input.policies.block.name;
    if (input.policies.network.enabled) networkPolicy = input.policies.network.block.name;
  } else if (input.policies.security.enabled) {
    policy = `${input.policies.security.name} (possible; categories not in snapshot)`;
    if (input.policies.network.enabled) {
      networkPolicy = `${input.policies.network.security.name} (possible; categories not in snapshot)`;
    }
  } else {
    policy = "none";
    if (input.policies.network.enabled) networkPolicy = "none";
  }

  const lines = [
    `why ${raw}`,
    `  normalized:     ${normalized}`,
    `  sources:        ${sourceNotes.length > 0 ? sourceNotes.join("; ") : "(none)"}`,
    `  folded:         ${folded ? `yes (parent ${folded.parent})` : "no"}`,
    `  dropped:        ${dropped ? `yes (${dropped.reason})` : "no"}`,
    `  allow:          ${allow}`,
    `  allow-wins:     ${allowHit ? "yes" : "no"}`,
  ];
  if (allowHit && allowDomain) {
    lines.push(
      `  allow-children: yes - dns.domains suffix match also covers children of ${allowDomain}`,
    );
  }
  lines.push(`  policy:         ${policy}`);
  if (networkPolicy !== undefined) {
    lines.push(`  network-policy: ${networkPolicy}`);
  }
  return `${lines.join("\n")}\n`;
}
