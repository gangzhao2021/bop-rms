import {
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  productCommandRecord as record,
} from "./catalog-product-command-values.js";
import {
  parseOptionSetAuthoringScope,
  parseOptionSetEditorContent,
  contentDigests,
  type OptionSetAuthoringScope,
  type OptionSetEditorContent,
} from "./option-set-authoring-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as hash,
} from "./product-publication-command-client-v2.js";
export class OptionSetHistoryClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "FeatureDisabled"
      | "Conflict"
      | "Stale"
      | "Unavailable"
      | "ScopeChanged",
  ) {
    super("Option Set history could not be loaded");
    this.name = "OptionSetHistoryClientError";
  }
}
const fail = (code: OptionSetHistoryClientError["code"] = "Invalid"): never => {
  throw new OptionSetHistoryClientError(code);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const integer = (v: unknown, max = 2147483647): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) return fail();
  return v;
};
const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(v)) return fail();
  return v;
};
function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) return fail();
  return v as T;
}
function safe(value: unknown): unknown {
  let budget = 300000;
  function copy(v: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 16) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 4096) return fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return fail();
      return v;
    }
    if (!v || typeof v !== "object") return fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return fail();
          return copy(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
      return fail();
    return Object.freeze(
      Object.fromEntries(
        Reflect.ownKeys(v).map((k) => {
          if (typeof k !== "string") return fail();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d?.enumerable || !("value" in d)) return fail();
          return [k, copy(d.value, depth + 1)];
        }),
      ),
    );
  }
  return copy(value, 0);
}
function array<T>(v: unknown, max: number, parse: (v: unknown) => T): readonly T[] {
  if (!Array.isArray(v) || v.length > max) return fail();
  return Object.freeze(v.map(parse));
}
export interface OptionSetHistoryPosition {
  readonly resultAggregateVersion: number;
  readonly operationReference: string;
  readonly kind: "DraftSnapshot" | "FrozenSeal" | "OperationOnly";
}
export interface OptionSetHistoryEntry extends OptionSetHistoryPosition {
  readonly action: "Create" | "ReplaceDraft" | "Archive" | "Publish";
  readonly occurredAt: string;
  readonly availability: "Complete" | "UnavailableLegacy";
  readonly versionReference: string | null;
  readonly sourceAggregateVersion: number | null;
  readonly sourceDigest: string | null;
  readonly contentDigest: string | null;
  readonly configurationDigest: string | null;
  readonly recordDigest: string | null;
}
export interface OptionSetHistoryListView {
  readonly profile: "CatalogOptionSetHistoryV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly optionSetReference: string;
  readonly currentAggregateVersion: number;
  readonly entries: readonly OptionSetHistoryEntry[];
  readonly nextBefore: OptionSetHistoryPosition | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publicationStatus: "NotEvaluated";
}
export interface OptionSetHistorySelectedCommand {
  readonly optionSetReference: string;
  readonly operationReference: string;
  readonly versionReference: string;
  readonly resultAggregateVersion: number;
  readonly expectedSourceDigest: string;
  readonly expectedContentDigest: string;
  readonly expectedConfigurationDigest: string;
  readonly expectedRecordDigest?: string;
}
export type OptionSetHistorySelector = Readonly<{
  kind: "Draft" | "Frozen";
  command: OptionSetHistorySelectedCommand;
}>;
export type OptionSetHistoryPacket = Readonly<{
  action: "List" | "Draft" | "Frozen" | "Publishing" | "Compare";
  command: Readonly<Record<string, unknown>>;
}>;
export interface OptionSetHistorySelectedView {
  readonly profile: "CatalogOptionSetHistoricalDraftV1" | "CatalogOptionSetHistoricalFrozenV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly optionSetReference: string;
  readonly originalTuple: Readonly<{
    operationReference: string;
    versionReference: string;
    resultAggregateVersion: number;
    action: "Create" | "ReplaceDraft" | "Publish";
    intentDigest: string;
    occurredAt: string;
  }>;
  readonly content: OptionSetEditorContent | Readonly<Record<string, unknown>>;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly recordDigest?: string;
  readonly recordingStatus?: "RecordedFrozen";
  readonly referenceEligibility: "NotEvaluated";
  readonly observedAt: string;
  readonly validUntil: string;
}
export type OptionSetHistoryView =
  | OptionSetHistoryListView
  | OptionSetHistorySelectedView
  | OptionSetPublishingHistoryView
  | OptionSetHistoryComparisonView;
export interface OptionSetHistoryQueryResult {
  readonly profile: "CatalogOptionSetHistoryQueryResultV1";
  readonly action: OptionSetHistoryPacket["action"];
  readonly storeReference: string;
  readonly actorReference: string;
  readonly view: OptionSetHistoryView;
}
function position(value: unknown): OptionSetHistoryPosition {
  const r = record(value, ["resultAggregateVersion", "operationReference", "kind"]);
  return Object.freeze({
    resultAggregateVersion: integer(r.resultAggregateVersion),
    operationReference: ref(r.operationReference),
    kind: choice(r.kind, ["DraftSnapshot", "FrozenSeal", "OperationOnly"]),
  });
}
const order = (a: OptionSetHistoryPosition, b: OptionSetHistoryPosition) =>
  b.resultAggregateVersion - a.resultAggregateVersion ||
  (a.operationReference < b.operationReference
    ? 1
    : a.operationReference > b.operationReference
      ? -1
      : 0) ||
  (a.kind < b.kind ? 1 : a.kind > b.kind ? -1 : 0);
const selectedKeys = [
  "optionSetReference",
  "operationReference",
  "versionReference",
  "resultAggregateVersion",
  "expectedSourceDigest",
  "expectedContentDigest",
  "expectedConfigurationDigest",
];
function selected(value: unknown, kind: "Draft" | "Frozen"): OptionSetHistorySelectedCommand {
  const r = record(value, [
    ...selectedKeys,
    ...(kind === "Frozen" ? ["expectedRecordDigest"] : []),
  ]);
  return Object.freeze({
    optionSetReference: ref(r.optionSetReference),
    operationReference: ref(r.operationReference),
    versionReference: ref(r.versionReference),
    resultAggregateVersion: integer(r.resultAggregateVersion),
    expectedSourceDigest: digest(r.expectedSourceDigest),
    expectedContentDigest: digest(r.expectedContentDigest),
    expectedConfigurationDigest: digest(r.expectedConfigurationDigest),
    ...(kind === "Frozen" ? { expectedRecordDigest: digest(r.expectedRecordDigest) } : {}),
  });
}
function selector(value: unknown): OptionSetHistorySelector {
  const r = record(value, ["kind", "command"]),
    kind = choice(r.kind, ["Draft", "Frozen"]);
  return Object.freeze({ kind, command: selected(r.command, kind) });
}
export function optionSetHistorySelectorFromEntry(
  optionSetReference: string,
  entry: OptionSetHistoryEntry,
): OptionSetHistorySelector {
  if (
    entry.availability !== "Complete" ||
    entry.kind === "OperationOnly" ||
    entry.versionReference === null ||
    entry.sourceDigest === null ||
    entry.contentDigest === null ||
    entry.configurationDigest === null
  )
    return fail();
  const kind = entry.kind === "FrozenSeal" ? "Frozen" : "Draft";
  return Object.freeze({
    kind,
    command: selected(
      {
        optionSetReference,
        operationReference: entry.operationReference,
        versionReference: entry.versionReference,
        resultAggregateVersion: entry.resultAggregateVersion,
        expectedSourceDigest: entry.sourceDigest,
        expectedContentDigest: entry.contentDigest,
        expectedConfigurationDigest: entry.configurationDigest,
        ...(kind === "Frozen" ? { expectedRecordDigest: entry.recordDigest } : {}),
      },
      kind,
    ),
  });
}
function before(value: unknown) {
  if (value === null) return null;
  const r = record(value, ["occurredAt", "operationReference"]);
  return Object.freeze({
    occurredAt: instant(r.occurredAt),
    operationReference: ref(r.operationReference),
  });
}
export function parseOptionSetHistoryPacket(value: unknown): OptionSetHistoryPacket {
  const r = record(safe(value), ["action", "command"]),
    action = choice(r.action, ["List", "Draft", "Frozen", "Publishing", "Compare"]);
  if (action === "Draft" || action === "Frozen")
    return Object.freeze({ action, command: { ...selected(r.command, action) } });
  if (action === "Compare") {
    const c = record(r.command, ["left", "right"]),
      left = selector(c.left),
      right = selector(c.right);
    if (left.command.optionSetReference !== right.command.optionSetReference) return fail();
    return Object.freeze({ action, command: Object.freeze({ left, right }) });
  }
  if (action === "Publishing") {
    const c = record(r.command, ["optionSetReference", "before", "limit"]);
    return Object.freeze({
      action,
      command: Object.freeze({
        optionSetReference: ref(c.optionSetReference),
        before: before(c.before),
        limit: integer(c.limit, 50),
      }),
    });
  }
  const c = record(r.command, [
      "optionSetReference",
      "expectedAggregateVersion",
      "before",
      "limit",
    ]),
    revision = c.expectedAggregateVersion === null ? null : integer(c.expectedAggregateVersion),
    anchor = c.before === null ? null : position(c.before);
  if (anchor && (revision === null || anchor.resultAggregateVersion > revision)) return fail();
  return Object.freeze({
    action,
    command: Object.freeze({
      optionSetReference: ref(c.optionSetReference),
      expectedAggregateVersion: revision,
      before: anchor,
      limit: integer(c.limit, 50),
    }),
  });
}
function lease(r: Record<string, unknown>, now: string) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (
    observedAt > now ||
    validUntil <= now ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail("Stale");
  return { observedAt, validUntil };
}
function scope(r: Record<string, unknown>, expected: OptionSetAuthoringScope) {
  if (
    r.tenantReference !== expected.tenantReference ||
    r.brandReference !== expected.brandReference
  )
    return fail("ScopeChanged");
}
function parseList(
  value: unknown,
  command: Record<string, unknown>,
  expected: OptionSetAuthoringScope,
  now: string,
): OptionSetHistoryListView {
  const r = record(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "currentAggregateVersion",
    "entries",
    "nextBefore",
    "observedAt",
    "validUntil",
    "publicationStatus",
  ]);
  scope(r, expected);
  const currentAggregateVersion = integer(r.currentAggregateVersion);
  if (
    r.profile !== "CatalogOptionSetHistoryV1" ||
    r.publicationStatus !== "NotEvaluated" ||
    r.optionSetReference !== command.optionSetReference ||
    (command.expectedAggregateVersion !== null &&
      command.expectedAggregateVersion !== currentAggregateVersion)
  )
    return fail();
  const entries = array(r.entries, integer(command.limit, 50), (value) => {
    const e = record(value, [
        "resultAggregateVersion",
        "operationReference",
        "kind",
        "action",
        "occurredAt",
        "availability",
        "versionReference",
        "sourceAggregateVersion",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "recordDigest",
      ]),
      p = position({
        resultAggregateVersion: e.resultAggregateVersion,
        operationReference: e.operationReference,
        kind: e.kind,
      }),
      action = choice(e.action, ["Create", "ReplaceDraft", "Archive", "Publish"]),
      availability = choice(e.availability, ["Complete", "UnavailableLegacy"]),
      occurredAt = instant(e.occurredAt),
      empty = p.kind === "OperationOnly";
    if (
      p.resultAggregateVersion > currentAggregateVersion ||
      occurredAt > instant(r.observedAt) ||
      availability !== (empty ? "UnavailableLegacy" : "Complete")
    )
      return fail();
    const versionReference = empty ? null : ref(e.versionReference),
      sourceAggregateVersion = empty ? null : integer(e.sourceAggregateVersion),
      sourceDigest = empty ? null : digest(e.sourceDigest),
      contentDigest = empty ? null : digest(e.contentDigest),
      configurationDigest = empty ? null : digest(e.configurationDigest),
      recordDigest = p.kind === "FrozenSeal" ? digest(e.recordDigest) : null;
    if (
      empty &&
      [
        e.versionReference,
        e.sourceAggregateVersion,
        e.sourceDigest,
        e.contentDigest,
        e.configurationDigest,
        e.recordDigest,
      ].some((v) => v !== null)
    )
      return fail();
    if (
      !empty &&
      (p.kind === "FrozenSeal"
        ? action !== "Publish" ||
          sourceAggregateVersion === null ||
          sourceAggregateVersion + 1 !== p.resultAggregateVersion
        : action === "Archive" ||
          sourceAggregateVersion !== p.resultAggregateVersion ||
          e.recordDigest !== null)
    )
      return fail();
    return Object.freeze({
      ...p,
      action,
      occurredAt,
      availability,
      versionReference,
      sourceAggregateVersion,
      sourceDigest,
      contentDigest,
      configurationDigest,
      recordDigest,
    });
  });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) return fail();
    const prev = entries[i - 1];
    if (prev && order(prev, e) >= 0) return fail();
    if (command.before !== null && order(position(command.before), e) >= 0) return fail();
  }
  const nextBefore = r.nextBefore === null ? null : position(r.nextBefore),
    last = entries.at(-1);
  if (
    nextBefore &&
    (!last ||
      entries.length !== command.limit ||
      !same(
        nextBefore,
        position({
          resultAggregateVersion: last.resultAggregateVersion,
          operationReference: last.operationReference,
          kind: last.kind,
        }),
      ))
  )
    return fail();
  return Object.freeze({
    profile: "CatalogOptionSetHistoryV1",
    tenantReference: expected.tenantReference,
    brandReference: expected.brandReference,
    optionSetReference: ref(r.optionSetReference),
    currentAggregateVersion,
    entries,
    nextBefore,
    ...lease(r, now),
    publicationStatus: "NotEvaluated",
  });
}
async function parseSelected(
  value: unknown,
  request: OptionSetHistorySelectedCommand,
  kind: "Draft" | "Frozen",
  expected: OptionSetAuthoringScope,
  now: string,
): Promise<OptionSetHistorySelectedView> {
  const frozen = kind === "Frozen",
    r = record(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "optionSetReference",
      "originalTuple",
      "content",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "observedAt",
      "validUntil",
      "referenceEligibility",
      ...(frozen ? ["recordDigest", "recordingStatus"] : []),
    ]);
  scope(r, expected);
  const t = record(r.originalTuple, [
      "operationReference",
      "versionReference",
      "resultAggregateVersion",
      "action",
      "intentDigest",
      "occurredAt",
    ]),
    action = choice(t.action, frozen ? ["Publish"] : ["Create", "ReplaceDraft", "Publish"]),
    occurredAt = instant(t.occurredAt);
  let full: OptionSetEditorContent,
    content: OptionSetEditorContent | Readonly<Record<string, unknown>>;
  if (frozen) {
    const envelope = record(r.content, [
        "profile",
        "supportedContent",
        "editorContent",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "eligibility",
        "digest",
      ]),
      supported = record(envelope.supportedContent, [
        "profile",
        "tenantReference",
        "brandReference",
        "optionSetReference",
        "versionReference",
        "sourceAggregateVersion",
        "publicationOperationReference",
        "publicationIntentDigest",
        "successorDraftVersionReference",
        "sealedAt",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "sourceAggregate",
        "eligibility",
        "digest",
      ]);
    full = parseOptionSetEditorContent(envelope.editorContent);
    const a = full.sourceAggregate;
    const { digest: recordDigest, ...base } = envelope,
      { digest: supportedDigest, ...supportedBase } = supported;
    if (
      envelope.profile !== "CatalogFullOptionSetDraftContentV2" ||
      envelope.eligibility !== "NotEvaluated" ||
      supported.profile !== "CatalogSupportedOptionSetDraftContentV1" ||
      supported.eligibility !== "NotEvaluated" ||
      !same(supported.sourceAggregate, a) ||
      supported.tenantReference !== expected.tenantReference ||
      supported.brandReference !== expected.brandReference ||
      supported.optionSetReference !== request.optionSetReference ||
      supported.versionReference !== request.versionReference ||
      supported.sourceAggregateVersion !== a.aggregateVersion ||
      supported.publicationOperationReference !== request.operationReference ||
      supported.publicationIntentDigest !== t.intentDigest ||
      supported.sealedAt !== occurredAt ||
      instant(supported.sealedAt) < a.updatedAt ||
      a.aggregateVersion + 1 !== request.resultAggregateVersion ||
      ref(supported.successorDraftVersionReference) === request.versionReference ||
      (await hash(supportedBase)) !== supportedDigest ||
      (await hash(base)) !== recordDigest ||
      recordDigest !== request.expectedRecordDigest ||
      r.recordDigest !== recordDigest ||
      r.recordingStatus !== "RecordedFrozen"
    )
      return fail();
    // Supported V1 has its own source/draft/configuration digests, independent
    // of the complete V2 editor digests.
    const d = a.draft,
      configuration = {
        versionReference: d.versionReference,
        displayStyle: d.displayStyle,
        minimumSelection: d.minimumSelection,
        maximumSelection: d.maximumSelection,
        allowRepeatedOption: d.allowRepeatedOption,
        perOptionMaximumQuantity: d.perOptionMaximumQuantity,
        maximumTotalQuantity: d.maximumTotalQuantity,
        options: d.options.map((o) => ({
          optionReference: o.optionReference,
          stableCode: o.stableCode,
          lifecycle: o.lifecycle,
          sortOrder: o.sortOrder,
          defaultEligible: o.defaultEligible,
          triggeredOptionSetReference: o.triggeredOptionSetReference,
          conflictOptionReferences: o.conflictOptionReferences,
        })),
      };
    if (
      supported.sourceDigest !== (await hash(a)) ||
      supported.contentDigest !== (await hash(d)) ||
      supported.configurationDigest !== (await hash(configuration))
    )
      return fail();
    content = Object.freeze(envelope);
  } else {
    full = parseOptionSetEditorContent(r.content);
    content = full;
    if (
      full.sourceAggregate.aggregateVersion !== request.resultAggregateVersion ||
      full.sourceAggregate.updatedAt !== occurredAt
    )
      return fail();
  }
  const hashes = await contentDigests(full),
    a = full.sourceAggregate;
  if (
    r.profile !==
      (frozen ? "CatalogOptionSetHistoricalFrozenV1" : "CatalogOptionSetHistoricalDraftV1") ||
    r.referenceEligibility !== "NotEvaluated" ||
    r.optionSetReference !== request.optionSetReference ||
    a.optionSetReference !== request.optionSetReference ||
    a.brandReference !== expected.brandReference ||
    a.draft.versionReference !== request.versionReference ||
    t.operationReference !== request.operationReference ||
    t.versionReference !== request.versionReference ||
    t.resultAggregateVersion !== request.resultAggregateVersion ||
    occurredAt > instant(r.observedAt) ||
    r.sourceDigest !== hashes.sourceDigest ||
    r.contentDigest !== hashes.contentDigest ||
    r.configurationDigest !== hashes.configurationDigest ||
    hashes.sourceDigest !== request.expectedSourceDigest ||
    hashes.contentDigest !== request.expectedContentDigest ||
    hashes.configurationDigest !== request.expectedConfigurationDigest
  )
    return fail();
  if (frozen) {
    const e = content as Readonly<Record<string, unknown>>;
    if (
      e.sourceDigest !== hashes.sourceDigest ||
      e.contentDigest !== hashes.contentDigest ||
      e.configurationDigest !== hashes.configurationDigest
    )
      return fail();
  }
  return Object.freeze({
    profile: frozen ? "CatalogOptionSetHistoricalFrozenV1" : "CatalogOptionSetHistoricalDraftV1",
    tenantReference: expected.tenantReference,
    brandReference: expected.brandReference,
    optionSetReference: request.optionSetReference,
    originalTuple: Object.freeze({
      operationReference: ref(t.operationReference),
      versionReference: ref(t.versionReference),
      resultAggregateVersion: integer(t.resultAggregateVersion),
      action,
      intentDigest: digest(t.intentDigest),
      occurredAt,
    }),
    content,
    ...hashes,
    ...lease(r, now),
    referenceEligibility: "NotEvaluated",
    ...(frozen
      ? { recordDigest: digest(r.recordDigest), recordingStatus: "RecordedFrozen" as const }
      : {}),
  });
}
const states = ["Draft", "InReview", "Approved", "Published", "Archived", "Superseded"] as const;
export interface OptionSetPublishingHistoryEntry {
  readonly operationReference: string;
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly operation: string;
  readonly actorKind: "User" | "Service" | "System";
  readonly actorReference: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly reasonCode: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly releaseReference: string | null;
  readonly releaseSequence: number | null;
  readonly supersededReleaseReference: string | null;
  readonly rollbackTargetReleaseReference: string | null;
}
export interface OptionSetPublishingHistoryView {
  readonly profile: "PublishingOptionSetHistoryV1";
  readonly scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    selectedStoreReference: string;
    actorReference: string;
  }>;
  readonly familyReference: string;
  readonly entries: readonly OptionSetPublishingHistoryEntry[];
  readonly nextBefore: Readonly<{ occurredAt: string; operationReference: string }> | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
function parsePublishing(
  value: unknown,
  command: Record<string, unknown>,
  expected: OptionSetAuthoringScope,
  now: string,
): OptionSetPublishingHistoryView {
  const r = record(value, [
      "profile",
      "scope",
      "familyReference",
      "entries",
      "nextBefore",
      "observedAt",
      "validUntil",
    ]),
    s = record(r.scope, [
      "tenantReference",
      "brandReference",
      "selectedStoreReference",
      "actorReference",
    ]);
  if (
    r.profile !== "PublishingOptionSetHistoryV1" ||
    r.familyReference !== command.optionSetReference ||
    s.tenantReference !== expected.tenantReference ||
    s.brandReference !== expected.brandReference ||
    s.selectedStoreReference !== expected.storeReference ||
    s.actorReference !== expected.actorReference
  )
    return fail("ScopeChanged");
  const entries = array(r.entries, integer(command.limit, 50), (value) => {
    const e = record(value, [
        "operationReference",
        "lifecycleReference",
        "lifecycleVersion",
        "operation",
        "actorKind",
        "actorReference",
        "occurredAt",
        "recordedAt",
        "reasonCode",
        "fromState",
        "toState",
        "snapshotReference",
        "snapshotDigest",
        "releaseReference",
        "releaseSequence",
        "supersededReleaseReference",
        "rollbackTargetReleaseReference",
      ]),
      actorKind = choice(e.actorKind, ["User", "Service", "System"]),
      occurredAt = instant(e.occurredAt),
      recordedAt = instant(e.recordedAt),
      operation = choice(e.operation, [
        "CreateDraft",
        "SubmitReview",
        "Approve",
        "Publish",
        "Archive",
        "Rollback",
      ]),
      fromState = e.fromState === null ? null : choice(e.fromState, states),
      toState = choice(e.toState, states),
      releaseReference = e.releaseReference === null ? null : ref(e.releaseReference),
      releaseSequence = e.releaseSequence === null ? null : integer(e.releaseSequence),
      lifecycleVersion = integer(e.lifecycleVersion);
    if (
      (actorKind === "System") !== (e.actorReference === null) ||
      recordedAt < occurredAt ||
      recordedAt > instant(r.observedAt) ||
      typeof e.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(e.reasonCode) ||
      (releaseReference === null) !== (releaseSequence === null) ||
      (operation === "Publish" || operation === "Rollback") !== (releaseReference !== null)
    )
      return fail();
    if (
      operation === "CreateDraft"
        ? toState !== "Draft" ||
          (fromState === null ? lifecycleVersion !== 1 : fromState !== "Draft")
        : operation === "SubmitReview"
          ? fromState !== "Draft" || toState !== "InReview"
          : operation === "Approve"
            ? fromState !== "InReview" || toState !== "Approved"
            : operation === "Publish"
              ? !["Approved", "InReview"].includes(fromState ?? "") || toState !== "Published"
              : operation === "Archive"
                ? fromState !== "Published" || toState !== "Archived"
                : fromState !== "Approved" || toState !== "Published"
    )
      return fail();
    return Object.freeze({
      operationReference: ref(e.operationReference),
      lifecycleReference: ref(e.lifecycleReference),
      lifecycleVersion,
      operation,
      actorKind,
      actorReference: e.actorReference === null ? null : ref(e.actorReference),
      occurredAt,
      recordedAt,
      reasonCode: e.reasonCode,
      fromState,
      toState,
      snapshotReference: ref(e.snapshotReference),
      snapshotDigest: digest(e.snapshotDigest),
      releaseReference,
      releaseSequence,
      supersededReleaseReference:
        e.supersededReleaseReference === null ? null : ref(e.supersededReleaseReference),
      rollbackTargetReleaseReference:
        e.rollbackTargetReleaseReference === null ? null : ref(e.rollbackTargetReleaseReference),
    });
  });
  if (new Set(entries.map((entry) => entry.operationReference)).size !== entries.length)
    return fail();
  const anchor = before(command.before),
    nextBefore = before(r.nextBefore);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i],
      previous = entries[i - 1];
    if (!e) return fail();
    if (
      previous &&
      (e.occurredAt > previous.occurredAt ||
        (e.occurredAt === previous.occurredAt &&
          e.operationReference >= previous.operationReference))
    )
      return fail();
    if (
      anchor &&
      (e.occurredAt > anchor.occurredAt ||
        (e.occurredAt === anchor.occurredAt && e.operationReference >= anchor.operationReference))
    )
      return fail();
  }
  const last = entries.at(-1);
  if (
    nextBefore &&
    (!last ||
      entries.length !== command.limit ||
      !same(nextBefore, {
        occurredAt: last.occurredAt,
        operationReference: last.operationReference,
      }))
  )
    return fail();
  return Object.freeze({
    profile: "PublishingOptionSetHistoryV1",
    scope: Object.freeze({
      tenantReference: expected.tenantReference,
      brandReference: expected.brandReference,
      selectedStoreReference: expected.storeReference,
      actorReference: expected.actorReference,
    }),
    familyReference: ref(r.familyReference),
    entries,
    nextBefore,
    ...lease(r, now),
  });
}
export interface OptionSetHistoryComparisonView {
  readonly profile: "CatalogOptionSetHistoryComparisonV1";
  readonly left: Readonly<{ kind: "Draft" | "Frozen"; view: OptionSetHistorySelectedView }>;
  readonly right: Readonly<{ kind: "Draft" | "Frozen"; view: OptionSetHistorySelectedView }>;
  readonly comparison: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  readonly validUntil: string;
}
function editor(view: OptionSetHistorySelectedView): OptionSetEditorContent {
  return view.profile === "CatalogOptionSetHistoricalDraftV1"
    ? parseOptionSetEditorContent(view.content)
    : parseOptionSetEditorContent(
        (view.content as Readonly<Record<string, unknown>>).editorContent,
      );
}
async function compare(left: OptionSetEditorContent, right: OptionSetEditorContent) {
  const a = left.sourceAggregate,
    b = right.sourceAggregate;
  if (
    a.brandReference !== b.brandReference ||
    a.optionSetReference !== b.optionSetReference ||
    a.internalCode !== b.internalCode ||
    a.createdAt !== b.createdAt ||
    a.createdByActorReference !== b.createdByActorReference
  )
    return fail();
  const draftFields = [
      "defaultLocale",
      "localizedNames",
      "localizedDescriptions",
      "displayStyle",
      "minimumSelection",
      "maximumSelection",
      "allowRepeatedOption",
      "perOptionMaximumQuantity",
      "maximumTotalQuantity",
    ] as const,
    additionalFields = [
      "optionDetails",
      "conditionalRules",
      "conflictRules",
      "scopeSet",
      "effectivePeriod",
    ] as const;
  const fields = [
    ...draftFields.map((field) => ({ field, left: a.draft[field], right: b.draft[field] })),
    ...additionalFields.map((field) => ({ field, left: left[field], right: right[field] })),
  ].filter((field) => !same(field.left, field.right));
  const oldOptions = new Map(a.draft.options.map((o) => [o.optionReference, o])),
    newOptions = new Map(b.draft.options.map((o) => [o.optionReference, o]));
  const options = [...new Set([...oldOptions.keys(), ...newOptions.keys()])]
    .sort()
    .flatMap((optionReference) => {
      const before = oldOptions.get(optionReference) ?? null,
        after = newOptions.get(optionReference) ?? null;
      if (
        before &&
        after &&
        (before.stableCode !== after.stableCode ||
          before.createdAt !== after.createdAt ||
          before.createdByActorReference !== after.createdByActorReference)
      )
        return fail();
      return same(before, after)
        ? []
        : [
            {
              optionReference,
              change: before === null ? "Added" : after === null ? "Removed" : "Changed",
              left: before,
              right: after,
            },
          ];
    });
  const identity = async (c: OptionSetEditorContent) => ({
    versionReference: c.sourceAggregate.draft.versionReference,
    aggregateVersion: c.sourceAggregate.aggregateVersion,
    ...(await contentDigests(c)),
  });
  return {
    profile: "CatalogOptionSetContentComparisonV1",
    brandReference: a.brandReference,
    optionSetReference: a.optionSetReference,
    left: await identity(left),
    right: await identity(right),
    fields,
    options,
    businessContentChanged: fields.length > 0 || options.length > 0,
    referenceEligibility: "NotEvaluated",
    publicationStatus: "NotEvaluated",
  };
}
async function parseComparison(
  value: unknown,
  command: Record<string, unknown>,
  expected: OptionSetAuthoringScope,
  now: string,
): Promise<OptionSetHistoryComparisonView> {
  const r = record(value, ["profile", "left", "right", "comparison", "observedAt", "validUntil"]),
    leftRequest = selector(command.left),
    rightRequest = selector(command.right),
    l = record(r.left, ["kind", "view"]),
    rr = record(r.right, ["kind", "view"]);
  if (
    r.profile !== "CatalogOptionSetHistoryComparisonV1" ||
    l.kind !== leftRequest.kind ||
    rr.kind !== rightRequest.kind
  )
    return fail();
  const left = await parseSelected(l.view, leftRequest.command, leftRequest.kind, expected, now),
    right = await parseSelected(rr.view, rightRequest.command, rightRequest.kind, expected, now),
    comparison = await compare(editor(left), editor(right)),
    held = lease(r, now);
  if (
    !same(r.comparison, comparison) ||
    held.validUntil > left.validUntil ||
    held.validUntil > right.validUntil
  )
    return fail();
  return Object.freeze({
    profile: "CatalogOptionSetHistoryComparisonV1",
    left: Object.freeze({ kind: leftRequest.kind, view: left }),
    right: Object.freeze({ kind: rightRequest.kind, view: right }),
    comparison: Object.freeze(comparison),
    ...held,
  });
}
export function createOptionSetHistoryClient(fetcher: typeof fetch = globalThis.fetch) {
  if (typeof fetcher !== "function") return fail();
  const transport = fetcher.bind(globalThis),
    rosterScopes = new WeakMap<OptionSetHistoryListView, string>();
  function pinned(
    s: OptionSetHistorySelector,
    rosters: readonly OptionSetHistoryListView[],
    expected: OptionSetAuthoringScope,
  ) {
    if (
      !rosters.some(
        (roster) =>
          rosterScopes.get(roster) === canonical(expected) &&
          roster.optionSetReference === s.command.optionSetReference &&
          roster.entries.some(
            (entry) =>
              entry.availability === "Complete" &&
              entry.kind !== "OperationOnly" &&
              same(optionSetHistorySelectorFromEntry(roster.optionSetReference, entry), s),
          ),
      )
    )
      return fail();
  }
  return Object.freeze({
    async load(input: {
      readonly packet: unknown;
      readonly expectedScope: unknown;
      readonly csrf: string;
      readonly signal?: AbortSignal;
      readonly rosters?: readonly OptionSetHistoryListView[];
    }): Promise<OptionSetHistoryQueryResult> {
      let packet: OptionSetHistoryPacket, expected: OptionSetAuthoringScope;
      try {
        packet = parseOptionSetHistoryPacket(input.packet);
        expected = parseOptionSetAuthoringScope(input.expectedScope);
        if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf))
          return fail();
        if (packet.action === "Draft" || packet.action === "Frozen")
          pinned(
            { kind: packet.action, command: selected(packet.command, packet.action) },
            input.rosters ?? [],
            expected,
          );
        if (packet.action === "Compare") {
          pinned(selector(packet.command.left), input.rosters ?? [], expected);
          pinned(selector(packet.command.right), input.rosters ?? [], expected);
        }
      } catch (error) {
        if (error instanceof OptionSetHistoryClientError) throw error;
        return fail();
      }
      const body = JSON.stringify(packet);
      if (new TextEncoder().encode(body).byteLength > 8192) return fail();
      if (input.signal?.aborted) return fail("Unavailable");
      const controller = new AbortController();
      let rejectAbort: ((error: unknown) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        }),
        abort = () => {
          controller.abort();
          rejectAbort?.(new OptionSetHistoryClientError("Unavailable"));
        };
      input.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 15000);
      try {
        const response = await Promise.race([
          transport("/merchant/catalog/option-sets/history", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            body,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": input.csrf,
              "X-BOP-Catalog-Scope": btoa(
                JSON.stringify({
                  brandReference: expected.brandReference,
                  storeReference: expected.storeReference,
                }),
              )
                .replace(/\+/gu, "-")
                .replace(/\//gu, "_")
                .replace(/=+$/u, ""),
            },
          }),
          aborted,
        ]);
        if (
          controller.signal.aborted ||
          response.headers.get("cache-control") !== "no-store" ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
          !response.body
        )
          return fail("Unavailable");
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          bytes = 0;
        try {
          while (true) {
            const chunk = await Promise.race([reader.read(), aborted]);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (
              bytes >
              (packet.action === "Compare"
                ? 16_777_216
                : packet.action === "Frozen"
                  ? 4_194_304
                  : packet.action === "Draft"
                    ? 2_097_152
                    : 524_288)
            )
              return fail("Unavailable");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (controller.signal.aborted) return fail("Unavailable");
        const value = safe(JSON.parse(text));
        if (response.status !== 200) {
          const error = record(value, ["error"]).error;
          if ((response.status === 401 || response.status === 403) && error === "request_denied")
            return fail("Denied");
          if (
            (response.status === 400 || response.status === 413) &&
            error === "option_set_history_invalid"
          )
            return fail("Invalid");
          if (response.status === 409 && error === "option_set_history_feature_disabled")
            return fail("FeatureDisabled");
          if (response.status === 409 && error === "option_set_history_conflict")
            return fail("Conflict");
          return fail("Unavailable");
        }
        const r = record(value, ["profile", "action", "storeReference", "actorReference", "view"]);
        if (r.profile !== "CatalogOptionSetHistoryQueryResultV1" || r.action !== packet.action)
          return fail();
        if (
          r.storeReference !== expected.storeReference ||
          r.actorReference !== expected.actorReference
        )
          return fail("ScopeChanged");
        const now = new Date().toISOString();
        let view: OptionSetHistoryView;
        if (packet.action === "List") {
          const roster = parseList(r.view, packet.command, expected, now);
          rosterScopes.set(roster, canonical(expected));
          view = roster;
        } else if (packet.action === "Draft" || packet.action === "Frozen")
          view = await parseSelected(
            r.view,
            selected(packet.command, packet.action),
            packet.action,
            expected,
            now,
          );
        else if (packet.action === "Publishing")
          view = parsePublishing(r.view, packet.command, expected, now);
        else view = await parseComparison(r.view, packet.command, expected, now);
        if (controller.signal.aborted) return fail("Unavailable");
        const held = record(view, [...Object.keys(view)]);
        lease(held, new Date().toISOString());
        return Object.freeze({
          profile: "CatalogOptionSetHistoryQueryResultV1",
          action: packet.action,
          storeReference: expected.storeReference,
          actorReference: expected.actorReference,
          view,
        });
      } catch (error) {
        if (error instanceof OptionSetHistoryClientError) throw error;
        return fail("Unavailable");
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
      }
    },
  });
}

/** Type guards apply to already validated client results, never raw transport. */
export const isOptionSetHistoryListResult = (
  result: OptionSetHistoryQueryResult,
): result is OptionSetHistoryQueryResult & {
  readonly action: "List";
  readonly view: OptionSetHistoryListView;
} => result.action === "List";
export const isOptionSetHistorySelectedResult = (
  result: OptionSetHistoryQueryResult,
): result is OptionSetHistoryQueryResult & {
  readonly action: "Draft" | "Frozen";
  readonly view: OptionSetHistorySelectedView;
} => result.action === "Draft" || result.action === "Frozen";
export const isOptionSetHistoryPublishingResult = (
  result: OptionSetHistoryQueryResult,
): result is OptionSetHistoryQueryResult & {
  readonly action: "Publishing";
  readonly view: OptionSetPublishingHistoryView;
} => result.action === "Publishing";
export const isOptionSetHistoryComparisonResult = (
  result: OptionSetHistoryQueryResult,
): result is OptionSetHistoryQueryResult & {
  readonly action: "Compare";
  readonly view: OptionSetHistoryComparisonView;
} => result.action === "Compare";
