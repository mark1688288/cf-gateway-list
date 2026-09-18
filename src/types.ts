export type SourceFormat = "hosts" | "domains" | "adblock" | "mmdb";

export type SourceConfig = {
  id: string;
  path?: string;
  url?: string;
  format?: SourceFormat;
  priority: number;
  required: boolean;
};

export type Config = {
  plan: {
    maxItems: number;
    itemsPerList: number;
    listNamePrefix: string;
    /** Account list-slot cap. Omitted = do not enforce. */
    maxLists?: number;
  };
  sources: {
    allow: SourceConfig[];
    block: SourceConfig[];
    asn: SourceConfig[];
  };
  safety: {
    abortIfSourceShrinksPct: number;
    abortIfAllowlistShrinks: number;
    abortIfAddsOver: number;
    requireReviewIfRemovesOver: number;
  };
  policies: {
    allow: { name: string; precedence: number };
    security: { name: string; precedence: number; enabled: boolean };
    block: { name: string; precedence: number };
    network: {
      enabled: boolean;
      allow: { name: string; precedence: number };
      security: { name: string; precedence: number };
      block: { name: string; precedence: number };
    };
  };
};

export type ParsedLine = {
  raw: string;
  domain: string | null;
  sourceId: string;
  kind: "domain" | "comment" | "blank" | "skipped";
};

export type CompiledDomain = {
  domain: string;
  sourceId: string;
};

export type FoldedDomain = {
  domain: string;
  sourceId: string;
  parent: string;
};

export type DroppedDomain = {
  domain: string;
  sourceId: string;
  reason: "budget";
};

export const DESIRED_SNAPSHOT_VERSION = 2;
export const DESIRED_SNAPSHOT_PHASE = 3;

/** Compiled apply contract. Phase 0 parse dumps (version 1 / phase 0) are stale. */
export type DesiredSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: typeof DESIRED_SNAPSHOT_PHASE;
  generatedAt: string;
  note: string;
  configPath: string;
  allow: CompiledDomain[];
  block: CompiledDomain[];
  folded: FoldedDomain[];
  remote: { fetched: string[] };
  counts: {
    allow: number;
    block: number;
    folded: number;
    dropped: number;
  };
};

export type DroppedSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: typeof DESIRED_SNAPSHOT_PHASE;
  generatedAt: string;
  dropped: DroppedDomain[];
};

export type SourceContent = "new" | "unchanged" | "updated";

export type SourceRecord = {
  id: string;
  origin: "path" | "url";
  path?: string;
  url?: string;
  etag: string | null;
  sha256: string | null;
  lineCount: number;
  parsedDomains: number;
  fetchedAt: string | null;
  status: "ok" | "optional-failed";
  /** Set on ok rows after Phase 11. Absent on optional-failed / pre-11 snapshots. */
  content?: SourceContent;
  error?: string;
};

export type SourcesSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: typeof DESIRED_SNAPSHOT_PHASE;
  generatedAt: string;
  sources: SourceRecord[];
};

export type SideDiff = {
  toAdd: string[];
  toRemove: string[];
  unchanged: string[];
  counts: {
    toAdd: number;
    toRemove: number;
    unchanged: number;
  };
};

export type DiffSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: 5;
  generatedAt: string;
  desiredGeneratedAt: string;
  drift: boolean;
  allow: SideDiff;
  block: SideDiff;
  counts: {
    toAdd: number;
    toRemove: number;
    unchanged: number;
  };
};

export type LastAppliedSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: 6;
  generatedAt: string;
  desiredGeneratedAt: string;
  lists: { id: string; name: string; count: number }[];
  rules: { id: string; name: string; precedence: number; action: string }[];
  counts: { allow: number; block: number };
};

export const ACCOUNT_QUOTA_SNAPSHOT_PHASE = 10;

/** One Gateway list as counted toward account quota. `count` is null when unknown. */
export type AccountQuotaListRow = {
  id: string;
  name: string;
  type?: string;
  count: number | null;
};

/**
 * Live (or last-known) account Gateway-list usage.
 * `otherItems` / `ownedItems` are null when any list in that group has no count.
 */
export type AccountQuotaSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: typeof ACCOUNT_QUOTA_SNAPSHOT_PHASE;
  fetchedAt: string;
  prefix: string;
  ownedLists: number;
  otherLists: number;
  ownedItems: number | null;
  otherItems: number | null;
  accountItems: number | null;
  unknownCounts: string[];
  owned: AccountQuotaListRow[];
  other: AccountQuotaListRow[];
};

export const SUGGESTED_SNAPSHOT_PHASE = 9;

export type SuggestedSkipReason = "already-allow" | "personal-block" | "invalid";

export type SuggestedDomainRow = {
  domain: string;
  count: number;
  decisions: string[];
};

export type SuggestedSkippedRow = SuggestedDomainRow & {
  reason: SuggestedSkipReason;
};

export type SuggestedSnapshotStatus = "ok" | "empty" | "unavailable";

/** Last Gateway DNS blocked-query ranking. Not an apply contract. */
export type SuggestedSnapshot = {
  version: typeof DESIRED_SNAPSHOT_VERSION;
  phase: typeof SUGGESTED_SNAPSHOT_PHASE;
  generatedAt: string;
  dataset: "gatewayResolverQueriesAdaptiveGroups";
  window: { start: string; end: string };
  status: SuggestedSnapshotStatus;
  warning?: string;
  blocked: SuggestedDomainRow[];
  suggested: SuggestedDomainRow[];
  skipped: SuggestedSkippedRow[];
};
