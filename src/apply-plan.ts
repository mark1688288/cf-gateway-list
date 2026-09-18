import {
  allowListName,
  blockListName,
  desiredDomains,
  diffDomainSets,
  ownedListIndex,
  sortOwnedLists,
} from "./domain-diff.ts";
import type { Config, DesiredSnapshot } from "./types.ts";

export class ApplyAbortError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "ApplyAbortError";
  }
}

export type LiveOwnedList = {
  id: string;
  name: string;
  items: string[];
};

export type RuleFilter = "dns" | "l4";

export type LiveOwnedRule = {
  id: string;
  name: string;
  precedence?: number;
  action?: string;
  enabled?: boolean;
  traffic?: string;
  filters?: RuleFilter;
};

export type ListPatchPlan = {
  id: string;
  name: string;
  append: string[];
  remove: string[];
};

export type ListCreatePlan = {
  name: string;
  items: string[];
};

export type RulePlan = {
  name: string;
  precedence: number;
  action: "allow" | "block";
  enabled: boolean;
  traffic: string;
  filters: RuleFilter;
  existingId?: string;
  unchanged: boolean;
};

/** Core security-risk categories (not content). IDs from Cloudflare Gateway. */
export const SECURITY_CATEGORY_IDS = [80, 83, 131, 151, 187, 191] as const;

export const MAX_TRAFFIC_CHARS = 4096;

export type ApplyPlan = {
  allowPatches: ListPatchPlan[];
  blockPatches: ListPatchPlan[];
  allowCreates: ListCreatePlan[];
  blockCreates: ListCreatePlan[];
  rules: RulePlan[];
  disableRules: { id: string; name: string }[];
  firstApply: boolean;
  allowDesired: string[];
  blockDesired: string[];
  allowLive: string[];
  blockLive: string[];
};

export type TrafficBuilder = (listIds: string[]) => string;

export function listTraffic(listIds: string[]): string {
  return listIds
    .map((id) => `any(dns.domains[*] in $${id}) or dns.fqdn in $${id}`)
    .join(" or ");
}

export function listSniTraffic(listIds: string[]): string {
  return listIds
    .map((id) => `any(net.sni.domains[*] in $${id}) or net.sni.host in $${id}`)
    .join(" or ");
}

export function securityTraffic(): string {
  return `any(dns.security_category[*] in {${SECURITY_CATEGORY_IDS.join(" ")}})`;
}

export function securitySniTraffic(): string {
  return `any(net.fqdn.security_category[*] in {${SECURITY_CATEGORY_IDS.join(" ")}})`;
}

export function chunkListIdsByTraffic(
  listIds: string[],
  maxChars = MAX_TRAFFIC_CHARS,
  traffic: TrafficBuilder = listTraffic,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const id of listIds) {
    const trial = traffic([...current, id]);
    if (current.length > 0 && trial.length > maxChars) {
      chunks.push(current);
      current = [id];
    } else {
      current.push(id);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function normalizeTraffic(traffic: string): string {
  return traffic.replace(/\s+/g, " ").trim();
}

export function planListUpdates(
  desired: string[],
  existing: LiveOwnedList[],
  prefix: string,
  role: "allow" | "block",
  itemsPerList: number,
): { patches: ListPatchPlan[]; creates: ListCreatePlan[] } {
  const desiredSet = new Set(desired);
  const sorted = sortOwnedLists(existing, prefix, role);
  const assigned = new Set<string>();
  const patches: ListPatchPlan[] = [];
  const leftover = [...desired];

  for (const list of sorted) {
    const current = [...new Set(list.items.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    const keep: string[] = [];
    for (const item of current) {
      if (desiredSet.has(item) && !assigned.has(item)) {
        keep.push(item);
        assigned.add(item);
      }
    }
    const remove = current.filter((item) => !keep.includes(item));
    const slots = Math.max(0, itemsPerList - keep.length);
    const append: string[] = [];
    for (const domain of leftover) {
      if (append.length >= slots) break;
      if (assigned.has(domain)) continue;
      append.push(domain);
      assigned.add(domain);
    }
    if (append.length > 0 || remove.length > 0) {
      patches.push({ id: list.id, name: list.name, append, remove });
    }
  }

  const remaining = leftover.filter((domain) => !assigned.has(domain));
  const indices = sorted
    .map((list) => ownedListIndex(list.name, prefix, role))
    .filter((index): index is number => index !== null);
  let nextIndex = indices.length === 0 ? 0 : Math.max(...indices) + 1;
  const nameFor = (index: number): string =>
    role === "allow" ? allowListName(prefix, index) : blockListName(prefix, index);

  const creates: ListCreatePlan[] = [];
  for (let offset = 0; offset < remaining.length; offset += itemsPerList) {
    creates.push({
      name: nameFor(nextIndex),
      items: remaining.slice(offset, offset + itemsPerList),
    });
    nextIndex += 1;
  }

  return { patches, creates };
}

function plannedNonEmptyNames(
  existing: LiveOwnedList[],
  patches: ListPatchPlan[],
  creates: ListCreatePlan[],
): { name: string; id?: string; count: number }[] {
  const patchById = new Map(patches.map((row) => [row.id, row]));
  const out: { name: string; id?: string; count: number }[] = [];
  for (const list of existing) {
    const patch = patchById.get(list.id);
    const current = new Set(list.items.map((item) => item.trim().toLowerCase()).filter(Boolean));
    if (patch) {
      for (const domain of patch.remove) current.delete(domain);
      for (const domain of patch.append) current.add(domain);
    }
    out.push({ name: list.name, id: list.id, count: current.size });
  }
  for (const created of creates) {
    out.push({ name: created.name, count: created.items.length });
  }
  return out.filter((row) => row.count > 0);
}

type PolicyLayer = {
  filters: RuleFilter;
  allowName: string;
  allowPrecedence: number;
  securityName: string;
  securityPrecedence: number;
  securityEnabled: boolean;
  blockName: string;
  blockPrecedence: number;
  listTraffic: TrafficBuilder;
  securityTraffic: () => string;
  disabledTraffic: string;
};

function existingFilter(rule: LiveOwnedRule | undefined): RuleFilter {
  return rule?.filters ?? "dns";
}

function ruleUnchanged(
  existing: LiveOwnedRule | undefined,
  options: {
    action: "allow" | "block";
    precedence: number;
    filters: RuleFilter;
    traffic: string;
    enabled: boolean;
  },
): boolean {
  if (!existing) return false;
  if (options.enabled) {
    return Boolean(
      existing.enabled !== false &&
        existing.action === options.action &&
        existing.precedence === options.precedence &&
        existingFilter(existing) === options.filters &&
        normalizeTraffic(existing.traffic ?? "") === normalizeTraffic(options.traffic),
    );
  }
  return existing.enabled === false;
}

export function planRules(options: {
  config: Config;
  allowLists: { name: string; id?: string; count: number }[];
  blockLists: { name: string; id?: string; count: number }[];
  existingRules: LiveOwnedRule[];
}): { rules: RulePlan[]; disableRules: { id: string; name: string }[] } {
  const { config, existingRules } = options;
  const prefix = config.plan.listNamePrefix;
  const byName = new Map(existingRules.map((rule) => [rule.name, rule]));
  const usedNames = new Set<string>();
  const rules: RulePlan[] = [];

  const layers: PolicyLayer[] = [
    {
      filters: "dns",
      allowName: config.policies.allow.name,
      allowPrecedence: config.policies.allow.precedence,
      securityName: config.policies.security.name,
      securityPrecedence: config.policies.security.precedence,
      securityEnabled: config.policies.security.enabled,
      blockName: config.policies.block.name,
      blockPrecedence: config.policies.block.precedence,
      listTraffic,
      securityTraffic,
      disabledTraffic: 'dns.fqdn == "__gateway-list-disabled.invalid"',
    },
  ];
  if (config.policies.network.enabled) {
    layers.push({
      filters: "l4",
      allowName: config.policies.network.allow.name,
      allowPrecedence: config.policies.network.allow.precedence,
      securityName: config.policies.network.security.name,
      securityPrecedence: config.policies.network.security.precedence,
      securityEnabled: config.policies.security.enabled,
      blockName: config.policies.network.block.name,
      blockPrecedence: config.policies.network.block.precedence,
      listTraffic: listSniTraffic,
      securityTraffic: securitySniTraffic,
      disabledTraffic: 'net.sni.host == "__gateway-list-disabled.invalid"',
    });
  }

  const pushListRules = (
    lists: { name: string; id?: string; count: number }[],
    baseName: string,
    basePrecedence: number,
    action: "allow" | "block",
    layer: PolicyLayer,
  ): void => {
    const usable = lists.filter((list) => list.count > 0 && list.id);
    const chunks = chunkListIdsByTraffic(
      usable.map((list) => list.id as string),
      MAX_TRAFFIC_CHARS,
      layer.listTraffic,
    );
    chunks.forEach((ids, index) => {
      const name = index === 0 ? baseName : `${baseName}-${index}`;
      const precedence = basePrecedence + index;
      const traffic = layer.listTraffic(ids);
      const existing = byName.get(name);
      usedNames.add(name);
      rules.push({
        name,
        precedence,
        action,
        enabled: true,
        traffic,
        filters: layer.filters,
        existingId: existing?.id,
        unchanged: ruleUnchanged(existing, {
          action,
          precedence,
          filters: layer.filters,
          traffic,
          enabled: true,
        }),
      });
    });
  };

  const allowNonEmpty = options.allowLists.filter((list) => list.count > 0);
  const blockNonEmpty = options.blockLists.filter((list) => list.count > 0 && list.id);

  for (const layer of layers) {
    if (allowNonEmpty.some((list) => list.id)) {
      pushListRules(
        options.allowLists,
        layer.allowName,
        layer.allowPrecedence,
        "allow",
        layer,
      );
    } else if (allowNonEmpty.length === 0) {
      const existing = byName.get(layer.allowName);
      if (existing) {
        usedNames.add(existing.name);
        const traffic = existing.traffic ?? layer.disabledTraffic;
        rules.push({
          name: existing.name,
          precedence: layer.allowPrecedence,
          action: "allow",
          enabled: false,
          traffic,
          filters: layer.filters,
          existingId: existing.id,
          unchanged: ruleUnchanged(existing, {
            action: "allow",
            precedence: layer.allowPrecedence,
            filters: layer.filters,
            traffic,
            enabled: false,
          }),
        });
      }
    }

    if (layer.securityEnabled) {
      const name = layer.securityName;
      const traffic = layer.securityTraffic();
      const existing = byName.get(name);
      usedNames.add(name);
      rules.push({
        name,
        precedence: layer.securityPrecedence,
        action: "block",
        enabled: true,
        traffic,
        filters: layer.filters,
        existingId: existing?.id,
        unchanged: ruleUnchanged(existing, {
          action: "block",
          precedence: layer.securityPrecedence,
          filters: layer.filters,
          traffic,
          enabled: true,
        }),
      });
    }

    if (blockNonEmpty.length > 0) {
      pushListRules(
        options.blockLists,
        layer.blockName,
        layer.blockPrecedence,
        "block",
        layer,
      );
    }
  }

  const disableRules = existingRules
    .filter((rule) => rule.name.startsWith(prefix) && !usedNames.has(rule.name) && rule.enabled !== false)
    .map((rule) => ({ id: rule.id, name: rule.name }));

  return { rules, disableRules };
}

export function checkApplySafety(
  plan: ApplyPlan,
  config: Config,
): void {
  const allowDiff = diffDomainSets(plan.allowDesired, plan.allowLive);
  const blockDiff = diffDomainSets(plan.blockDesired, plan.blockLive);
  const allowRemoves = allowDiff.counts.toRemove;
  const totalAdds = allowDiff.counts.toAdd + blockDiff.counts.toAdd;
  const totalRemoves = allowDiff.counts.toRemove + blockDiff.counts.toRemove;

  if (allowRemoves >= config.safety.abortIfAllowlistShrinks && allowRemoves > 0) {
    throw new ApplyAbortError(
      `safety: allow list would lose ${allowRemoves} domain(s); abort_if_allowlist_shrinks is ${config.safety.abortIfAllowlistShrinks}`,
    );
  }

  if (!plan.firstApply && totalAdds > config.safety.abortIfAddsOver) {
    throw new ApplyAbortError(
      `safety: apply would add ${totalAdds} domain(s); abort_if_adds_over is ${config.safety.abortIfAddsOver}`,
    );
  }

  if (!plan.firstApply && totalRemoves > config.safety.requireReviewIfRemovesOver) {
    throw new ApplyAbortError(
      `safety: apply would remove ${totalRemoves} domain(s); require_review_if_removes_over is ${config.safety.requireReviewIfRemovesOver}`,
    );
  }
}

export function buildApplyPlan(options: {
  config: Config;
  desired: DesiredSnapshot;
  allowLiveLists: LiveOwnedList[];
  blockLiveLists: LiveOwnedList[];
  existingRules: LiveOwnedRule[];
}): ApplyPlan {
  const allowDesired = desiredDomains(options.desired.allow);
  const blockDesired = desiredDomains(options.desired.block);
  const allowLive = [...new Set(options.allowLiveLists.flatMap((list) => list.items))].map((d) =>
    d.trim().toLowerCase(),
  );
  const blockLive = [...new Set(options.blockLiveLists.flatMap((list) => list.items))].map((d) =>
    d.trim().toLowerCase(),
  );
  const firstApply = allowLive.length === 0 && blockLive.length === 0;

  const allowUpdates = planListUpdates(
    allowDesired,
    options.allowLiveLists,
    options.config.plan.listNamePrefix,
    "allow",
    options.config.plan.itemsPerList,
  );
  const blockUpdates = planListUpdates(
    blockDesired,
    options.blockLiveLists,
    options.config.plan.listNamePrefix,
    "block",
    options.config.plan.itemsPerList,
  );

  const allowPlanned = plannedNonEmptyNames(
    options.allowLiveLists,
    allowUpdates.patches,
    allowUpdates.creates,
  );
  const blockPlanned = plannedNonEmptyNames(
    options.blockLiveLists,
    blockUpdates.patches,
    blockUpdates.creates,
  );

  // Creates do not have IDs yet; rule traffic for those is filled after execute.
  const { rules, disableRules } = planRules({
    config: options.config,
    allowLists: allowPlanned,
    blockLists: blockPlanned,
    existingRules: options.existingRules,
  });

  return {
    allowPatches: allowUpdates.patches,
    blockPatches: blockUpdates.patches,
    allowCreates: allowUpdates.creates,
    blockCreates: blockUpdates.creates,
    rules,
    disableRules,
    firstApply,
    allowDesired,
    blockDesired,
    allowLive,
    blockLive,
  };
}

export function planIsNoop(plan: ApplyPlan): boolean {
  const listOps =
    plan.allowPatches.length +
    plan.blockPatches.length +
    plan.allowCreates.length +
    plan.blockCreates.length;
  const ruleOps = plan.rules.filter((rule) => !rule.unchanged).length + plan.disableRules.length;
  return listOps === 0 && ruleOps === 0;
}
