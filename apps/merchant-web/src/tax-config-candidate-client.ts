import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as hashValue,
} from "./product-publication-command-client-v2.js";
import { parseStoreSetupScope, type StoreSetupScope } from "./store-setup-client.js";
import { TaxConfigAuthoringClientError } from "./tax-config-authoring-client.js";
export { TaxConfigAuthoringClientError as TaxConfigCandidateClientError } from "./tax-config-authoring-client.js";
const fail = (code: TaxConfigAuthoringClientError["code"] = "Invalid"): never => {
  throw new TaxConfigAuthoringClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof TaxConfigAuthoringClientError) throw e;
    return fail();
  }
}
async function digest(value: unknown): Promise<string> {
  try {
    return await hashValue(value);
  } catch {
    return fail("Unavailable");
  }
}
const scopeKeys = ["tenantReference", "brandReference", "storeReference", "actorReference"];
const optionalRef = (value: unknown) => (value === null ? null : ref(value));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const integer = (v: unknown, min = 1, max = 2147483647) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
function copy(value: unknown, maximumBytes = 65536): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 300000 || depth > 16) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 16384 ? v : fail();
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 4096 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return fail();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return fail();
            return visit(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
        return fail();
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (typeof key !== "string" || key === "__proto__" || !d?.enumerable || !("value" in d))
          return fail();
        result[key] = visit(d.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(v);
    }
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(canonical(result)).length > maximumBytes) return fail();
  return result;
}
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope(Object.fromEntries(scopeKeys.map((key) => [key, r[key]])));
import {
  parseTaxConfigAuthoringContent,
  type TaxConfigAuthoringContent,
  type TaxConfigDraftSnapshot,
} from "./tax-config-authoring-client.js";
export interface TaxConfigCandidateBase {
  versionReference: string;
  snapshotDigest: string;
  aggregateVersion: number;
  versionNumber: number;
}
export interface TaxConfigCandidateRegistration {
  materialReference: string;
  versionReference: string;
  contentDigest: string;
}
export interface TaxConfigCandidateCommand {
  action: "PrepareCandidate";
  operationReference: string;
  configurationReference: string;
  expectedDraft: TaxConfigCandidateBase;
  registrationMaterial: TaxConfigCandidateRegistration;
}
export interface TaxConfigCandidateCursor extends TaxConfigCandidateCommand {
  profile: "TaxConfigCandidatePendingOriginalV1";
  scope: StoreSetupScope;
  intentDigest: string;
}
export interface PreparedTaxConfigCandidateCommand {
  scope: StoreSetupScope;
  command: TaxConfigCandidateCommand;
  intentDigest: string;
  cursor: TaxConfigCandidateCursor;
}
export interface TaxConfigPublicationCandidateContent {
  profile: "TaxPublicationCandidateContentV1";
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  configurationReference: string;
  baseDraft: TaxConfigCandidateBase;
  targetVersionReference: string;
  targetAggregateVersion: number;
  targetVersionNumber: number;
  stableCode: string;
  jurisdictionCode: "CA-ON";
  currencyMetadata: TaxConfigDraftSnapshot["currencyMetadata"];
  effectivePeriod: TaxConfigAuthoringContent["effectivePeriod"];
  rules: TaxConfigDraftSnapshot["rules"];
  sourceRuleBindings: readonly { sourceRuleReference: string; targetRuleReference: string }[];
  registrationMaterial: TaxConfigCandidateRegistration;
}
export interface TaxConfigPublicationCandidate {
  profile: "TaxPublicationCandidateV1";
  content: TaxConfigPublicationCandidateContent;
  contentDigest: string;
}
export interface TaxConfigCandidateRecord {
  profile: "TaxConfigCandidateRecordV1";
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  preparedByActorReference: string;
  operationReference: string;
  candidate: TaxConfigPublicationCandidate;
  auditReference: string;
  eventReference: string;
  preparedAt: string;
  dataClassification: "Confidential";
  status: "Recorded";
  qualification: "NotEvaluated";
}
export interface TaxConfigCandidateReceipt extends StoreSetupScope, TaxConfigCandidateCommand {
  profile: "TaxConfigCandidateOperationV1";
  command: TaxConfigCandidateCommand | null;
  intentDigest: string;
  outcome: "Committed" | "Abandoned";
  result: TaxConfigCandidateRecord | null;
  auditReference: string;
  eventReference: string | null;
  occurredAt: string;
}
export interface TaxConfigCandidateCurrent extends StoreSetupScope {
  profile: "TaxConfigCandidateCurrentV1";
  configurationReference: string;
  targetVersionReference: string | null;
  record: TaxConfigCandidateRecord | null;
  observedAt: string;
  validUntil: string;
  qualification: "NotEvaluated";
}
export interface TaxConfigCandidateSummary {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  configurationReference: string;
  targetVersionReference: string;
  targetAggregateVersion: number;
  targetVersionNumber: number;
  contentDigest: string;
  baseDraft: TaxConfigCandidateBase;
  registrationMaterial: TaxConfigCandidateRegistration;
  preparedByActorReference: string;
  operationReference: string;
  preparedAt: string;
  status: "Recorded";
  qualification: "NotEvaluated";
}
export interface TaxConfigCandidateRoster extends StoreSetupScope {
  profile: "TaxConfigCandidateRosterV1";
  configurationReference: string;
  afterCandidate: string | null;
  entries: readonly TaxConfigCandidateSummary[];
  nextAfterCandidate: string | null;
  observedAt: string;
  validUntil: string;
  qualification: "NotEvaluated";
}
const commandKeys = [
  "action",
  "operationReference",
  "configurationReference",
  "expectedDraft",
  "registrationMaterial",
];
function base(v: unknown): TaxConfigCandidateBase {
  const r = record(v, ["versionReference", "snapshotDigest", "aggregateVersion", "versionNumber"]);
  return Object.freeze({
    versionReference: ref(r.versionReference),
    snapshotDigest: hash(r.snapshotDigest),
    aggregateVersion: integer(r.aggregateVersion),
    versionNumber: integer(r.versionNumber),
  });
}
function registration(v: unknown): TaxConfigCandidateRegistration {
  const r = record(v, ["materialReference", "versionReference", "contentDigest"]);
  return Object.freeze({
    materialReference: ref(r.materialReference),
    versionReference: ref(r.versionReference),
    contentDigest: hash(r.contentDigest),
  });
}
function pins(r: Record<string, unknown>): TaxConfigCandidateCommand {
  if (r.action !== "PrepareCandidate") return fail();
  return Object.freeze({
    action: "PrepareCandidate",
    operationReference: ref(r.operationReference),
    configurationReference: ref(r.configurationReference),
    expectedDraft: base(r.expectedDraft),
    registrationMaterial: registration(r.registrationMaterial),
  });
}
export function parseTaxConfigCandidateCommand(v: unknown) {
  return safe(() => pins(record(copy(v, 4096), commandKeys)));
}
export function parseTaxConfigCandidateCursor(v: unknown): TaxConfigCandidateCursor {
  return safe(() => {
    const r = record(copy(v, 8192), ["profile", "scope", ...commandKeys, "intentDigest"]);
    if (r.profile !== "TaxConfigCandidatePendingOriginalV1") return fail();
    return Object.freeze({
      profile: "TaxConfigCandidatePendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
const scope3 = ["tenantReference", "brandReference", "storeReference"];
function matches(
  v: { tenantReference: string; brandReference: string; storeReference: string },
  s: { tenantReference: string; brandReference: string; storeReference: string },
) {
  if (scope3.some((k) => Reflect.get(v, k) !== Reflect.get(s, k))) return fail("ScopeChanged");
}
function scoped(r: Record<string, unknown>, s: StoreSetupScope) {
  const actual = scopeFrom(r);
  if (!same(actual, s)) return fail("ScopeChanged");
  return actual;
}
function window(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  return { observedAt, validUntil };
}
function successor(
  b: TaxConfigCandidateBase,
  target: string,
  aggregate: number,
  number: number,
  reg: TaxConfigCandidateRegistration,
) {
  if (
    aggregate !== b.aggregateVersion + 1 ||
    number !== b.versionNumber + 1 ||
    [b.versionReference, reg.versionReference, reg.materialReference].includes(target)
  )
    return fail();
}
function candidate(value: unknown): TaxConfigPublicationCandidate {
  const r = record(value, ["profile", "content", "contentDigest"]);
  if (r.profile !== "TaxPublicationCandidateV1") return fail();
  const c = record(r.content, [
    "profile",
    ...scope3,
    "configurationReference",
    "baseDraft",
    "targetVersionReference",
    "targetAggregateVersion",
    "targetVersionNumber",
    "stableCode",
    "jurisdictionCode",
    "currencyMetadata",
    "effectivePeriod",
    "rules",
    "sourceRuleBindings",
    "registrationMaterial",
  ]);
  if (
    c.profile !== "TaxPublicationCandidateContentV1" ||
    c.jurisdictionCode !== "CA-ON" ||
    !Array.isArray(c.rules) ||
    c.rules.length > 256 ||
    !Array.isArray(c.sourceRuleBindings) ||
    c.sourceRuleBindings.length !== c.rules.length
  )
    return fail();
  const ruleRefs: string[] = [];
  const rawRules = c.rules.map((v) => {
    const rr = record(v, [
      "ruleReference",
      "taxClassificationReference",
      "orderType",
      "chargeType",
      "taxComponentCode",
      "treatment",
      "rate",
      "priceInclusion",
      "roundingMode",
      "calculationOrder",
      "compoundOnPriorTax",
      "exceptionEvidenceReference",
      "receiptPresentationCode",
    ]);
    ruleRefs.push(ref(rr.ruleReference));
    const { ruleReference, ...rule } = rr;
    void ruleReference;
    return rule;
  });
  const parsed = parseTaxConfigAuthoringContent({
      stableCode: c.stableCode,
      effectivePeriod: c.effectivePeriod,
      rules: rawRules,
    }),
    rules = Object.freeze(
      parsed.rules.map((v, i) => Object.freeze({ ...v, ruleReference: ruleRefs[i] ?? fail() })),
    );
  const m = record(c.currencyMetadata, [
    "currencyCode",
    "minorUnitExponent",
    "metadataVersion",
    "metadataVersionReference",
    "metadataDigest",
  ]);
  if (m.currencyCode !== "CAD") return fail();
  const currencyMetadata = Object.freeze({
    currencyCode: "CAD" as const,
    minorUnitExponent: integer(m.minorUnitExponent, 0, 6),
    metadataVersion: integer(m.metadataVersion, 1, Number.MAX_SAFE_INTEGER),
    metadataVersionReference: ref(m.metadataVersionReference),
    metadataDigest: hash(m.metadataDigest),
  });
  const b = base(c.baseDraft),
    reg = registration(c.registrationMaterial),
    target = ref(c.targetVersionReference),
    aggregate = integer(c.targetAggregateVersion),
    number = integer(c.targetVersionNumber),
    bindings = Object.freeze(
      c.sourceRuleBindings.map((v) => {
        const x = record(v, ["sourceRuleReference", "targetRuleReference"]);
        return Object.freeze({
          sourceRuleReference: ref(x.sourceRuleReference),
          targetRuleReference: ref(x.targetRuleReference),
        });
      }),
    );
  successor(b, target, aggregate, number, reg);
  const tenantReference = ref(c.tenantReference),
    brandReference = ref(c.brandReference),
    storeReference = ref(c.storeReference),
    configurationReference = ref(c.configurationReference);
  const reserved = [
    tenantReference,
    brandReference,
    storeReference,
    configurationReference,
    b.versionReference,
    reg.materialReference,
    reg.versionReference,
    currencyMetadata.metadataVersionReference,
    ...bindings.map((v) => v.sourceRuleReference),
    ...rules.map((v) => v.taxClassificationReference),
    ...rules.flatMap((v) =>
      v.exceptionEvidenceReference === null ? [] : [v.exceptionEvidenceReference],
    ),
  ];
  if (
    reserved.includes(target) ||
    bindings.some(
      (v, i) =>
        v.targetRuleReference !== rules[i]?.ruleReference ||
        reserved.includes(v.targetRuleReference),
    ) ||
    new Set(bindings.map((v) => v.targetRuleReference)).size !== bindings.length ||
    new Set(bindings.map((v) => v.sourceRuleReference)).size !== bindings.length
  )
    return fail();
  return Object.freeze({
    profile: "TaxPublicationCandidateV1",
    content: Object.freeze({
      profile: "TaxPublicationCandidateContentV1",
      tenantReference,
      brandReference,
      storeReference,
      configurationReference,
      baseDraft: b,
      targetVersionReference: target,
      targetAggregateVersion: aggregate,
      targetVersionNumber: number,
      stableCode: parsed.stableCode,
      jurisdictionCode: "CA-ON",
      currencyMetadata,
      effectivePeriod: parsed.effectivePeriod,
      rules,
      sourceRuleBindings: bindings,
      registrationMaterial: reg,
    }),
    contentDigest: hash(r.contentDigest),
  });
}
export function parseTaxConfigCandidateRecord(v: unknown): TaxConfigCandidateRecord {
  return safe(() => {
    const r = record(copy(v, 204800), [
      "profile",
      ...scope3,
      "preparedByActorReference",
      "operationReference",
      "candidate",
      "auditReference",
      "eventReference",
      "preparedAt",
      "dataClassification",
      "status",
      "qualification",
    ]);
    if (
      r.profile !== "TaxConfigCandidateRecordV1" ||
      r.dataClassification !== "Confidential" ||
      r.status !== "Recorded" ||
      r.qualification !== "NotEvaluated"
    )
      return fail();
    const s = {
        tenantReference: ref(r.tenantReference),
        brandReference: ref(r.brandReference),
        storeReference: ref(r.storeReference),
      },
      p = candidate(r.candidate);
    matches(p.content, s);
    return Object.freeze({
      profile: "TaxConfigCandidateRecordV1",
      ...s,
      preparedByActorReference: ref(r.preparedByActorReference),
      operationReference: ref(r.operationReference),
      candidate: p,
      auditReference: ref(r.auditReference),
      eventReference: ref(r.eventReference),
      preparedAt: instant(r.preparedAt),
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
  });
}
export async function validateTaxConfigCandidateRecord(v: unknown) {
  const p = parseTaxConfigCandidateRecord(v);
  if ((await digest(p.candidate.content)) !== p.candidate.contentDigest) return fail();
  return p;
}
export function parseTaxConfigCandidateCurrent(
  v: unknown,
  s: StoreSetupScope,
  selector: { configurationReference: string; targetVersionReference: string | null },
): TaxConfigCandidateCurrent {
  return safe(() => {
    const r = record(copy(v, 212992), [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "targetVersionReference",
      "record",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (r.profile !== "TaxConfigCandidateCurrentV1" || r.qualification !== "NotEvaluated")
      return fail();
    const actual = scoped(r, s),
      w = window(r),
      config = ref(r.configurationReference),
      target = optionalRef(r.targetVersionReference),
      p = r.record === null ? null : parseTaxConfigCandidateRecord(r.record);
    if (
      config !== selector.configurationReference ||
      (selector.targetVersionReference !== null && target !== selector.targetVersionReference) ||
      (p === null) !== (target === null)
    )
      return fail();
    if (p) {
      matches(p, actual);
      if (
        p.candidate.content.configurationReference !== config ||
        p.candidate.content.targetVersionReference !== target ||
        p.preparedAt > w.observedAt
      )
        return fail();
    }
    return Object.freeze({
      profile: "TaxConfigCandidateCurrentV1",
      ...actual,
      configurationReference: config,
      targetVersionReference: target,
      record: p,
      ...w,
      qualification: "NotEvaluated",
    });
  });
}
export function parseTaxConfigCandidateRoster(
  v: unknown,
  s: StoreSetupScope,
  selector: { configurationReference: string; afterCandidate: string | null },
): TaxConfigCandidateRoster {
  return safe(() => {
    const r = record(copy(v, 131072), [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "afterCandidate",
      "entries",
      "nextAfterCandidate",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (
      r.profile !== "TaxConfigCandidateRosterV1" ||
      r.qualification !== "NotEvaluated" ||
      !Array.isArray(r.entries) ||
      r.entries.length > 20
    )
      return fail();
    const actual = scoped(r, s),
      w = window(r),
      config = ref(r.configurationReference),
      after = optionalRef(r.afterCandidate),
      next = optionalRef(r.nextAfterCandidate);
    if (config !== selector.configurationReference || after !== selector.afterCandidate)
      return fail();
    let previous = after;
    const entries = Object.freeze(
      r.entries.map((v) => {
        const x = record(v, [
          ...scope3,
          "configurationReference",
          "targetVersionReference",
          "targetAggregateVersion",
          "targetVersionNumber",
          "contentDigest",
          "baseDraft",
          "registrationMaterial",
          "preparedByActorReference",
          "operationReference",
          "preparedAt",
          "status",
          "qualification",
        ]);
        if (x.status !== "Recorded" || x.qualification !== "NotEvaluated") return fail();
        const item = Object.freeze({
          tenantReference: ref(x.tenantReference),
          brandReference: ref(x.brandReference),
          storeReference: ref(x.storeReference),
          configurationReference: ref(x.configurationReference),
          targetVersionReference: ref(x.targetVersionReference),
          targetAggregateVersion: integer(x.targetAggregateVersion),
          targetVersionNumber: integer(x.targetVersionNumber),
          contentDigest: hash(x.contentDigest),
          baseDraft: base(x.baseDraft),
          registrationMaterial: registration(x.registrationMaterial),
          preparedByActorReference: ref(x.preparedByActorReference),
          operationReference: ref(x.operationReference),
          preparedAt: instant(x.preparedAt),
          status: "Recorded" as const,
          qualification: "NotEvaluated" as const,
        });
        matches(item, actual);
        successor(
          item.baseDraft,
          item.targetVersionReference,
          item.targetAggregateVersion,
          item.targetVersionNumber,
          item.registrationMaterial,
        );
        if (
          item.configurationReference !== config ||
          item.preparedAt > w.observedAt ||
          (previous !== null && item.targetVersionReference <= previous)
        )
          return fail();
        previous = item.targetVersionReference;
        return item;
      }),
    );
    if (next !== null && (entries.length !== 20 || next !== previous)) return fail();
    return Object.freeze({
      profile: "TaxConfigCandidateRosterV1",
      ...actual,
      configurationReference: config,
      afterCandidate: after,
      entries,
      nextAfterCandidate: next,
      ...w,
      qualification: "NotEvaluated",
    });
  });
}
export async function validateTaxConfigCandidateReceipt(
  v: unknown,
  expected: TaxConfigCandidateCursor,
): Promise<TaxConfigCandidateReceipt> {
  const r = record(copy(v, 221184), [
      "profile",
      ...scopeKeys,
      ...commandKeys,
      "command",
      "intentDigest",
      "outcome",
      "result",
      "auditReference",
      "eventReference",
      "occurredAt",
    ]),
    cursor = parseTaxConfigCandidateCursor(expected);
  if (
    r.profile !== "TaxConfigCandidateOperationV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned")
  )
    return fail();
  const s = scoped(r, cursor.scope),
    p = pins(r),
    intentDigest = hash(r.intentDigest),
    occurredAt = instant(r.occurredAt),
    auditReference = ref(r.auditReference),
    eventReference = optionalRef(r.eventReference);
  if (
    !same(p, parseTaxConfigCandidateCommand(cursorCommand(cursor))) ||
    intentDigest !== cursor.intentDigest ||
    (await digest({ scope: s, command: p })) !== intentDigest
  )
    return fail();
  let command: TaxConfigCandidateCommand | null = null,
    result: TaxConfigCandidateRecord | null = null;
  if (r.outcome === "Abandoned") {
    if (r.command !== null || r.result !== null || eventReference !== null) return fail();
  } else {
    command = parseTaxConfigCandidateCommand(r.command);
    result = await validateTaxConfigCandidateRecord(r.result);
    matches(result, s);
    if (
      !same(command, p) ||
      result.preparedByActorReference !== s.actorReference ||
      result.operationReference !== p.operationReference ||
      result.auditReference !== auditReference ||
      result.eventReference !== eventReference ||
      result.preparedAt !== occurredAt ||
      result.candidate.content.configurationReference !== p.configurationReference ||
      !same(result.candidate.content.baseDraft, p.expectedDraft) ||
      !same(result.candidate.content.registrationMaterial, p.registrationMaterial)
    )
      return fail();
  }
  return Object.freeze({
    profile: "TaxConfigCandidateOperationV1",
    ...s,
    ...p,
    command,
    intentDigest,
    outcome: r.outcome,
    result,
    auditReference,
    eventReference,
    occurredAt,
  });
}
function cursorCommand(c: TaxConfigCandidateCursor) {
  return {
    action: c.action,
    operationReference: c.operationReference,
    configurationReference: c.configurationReference,
    expectedDraft: c.expectedDraft,
    registrationMaterial: c.registrationMaterial,
  };
}
export interface TaxConfigCandidateRequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}
export function createTaxConfigCandidateClient(fetcher: typeof fetch = fetch) {
  let epoch = 0;
  const begin = () => ++epoch;
  const active = (e: number, signal: AbortSignal | undefined, write = false) => {
    if (e !== epoch) return fail("ScopeChanged");
    if (signal?.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
  };
  const request = async (
    path: string,
    scope: StoreSetupScope | undefined,
    options: TaxConfigCandidateRequestOptions,
    body: unknown | undefined,
    e: number,
    maximumBytes: number,
  ) => {
    const csrf = options.csrf,
      signal = options.signal,
      write = body !== undefined;
    active(e, signal);
    if (write && (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf))) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false,
      definitive = false;
    try {
      const encoded = write ? canonical(body) : undefined;
      if (encoded !== undefined && new TextEncoder().encode(encoded).length > 8192) return fail();
      sent = true;
      const response = await fetcher(`/merchant/tax-config/authoring/${path}`, {
        method: write ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(scope
            ? {
                "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                  .replace(/\+/gu, "-")
                  .replace(/\//gu, "_")
                  .replace(/=+$/u, ""),
              }
            : {}),
          ...(write ? { "Content-Type": "application/json", "X-BOP-CSRF": csrf ?? "" } : {}),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
      active(e, signal, write);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(write ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (response.ok ? maximumBytes : 4096))
            return fail(write ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      active(e, signal, write);
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      if (
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const error = safe(() => record(value, ["error"])).error;
        if (response.status === 403 && error === "request_denied") {
          definitive = true;
          return fail("Denied");
        }
        if (response.status === 400 && error === "tax_config_authoring_invalid") {
          definitive = true;
          return fail("Invalid");
        }
        if (response.status === 409 && error === "tax_config_authoring_conflict") {
          definitive = true;
          return fail("Conflict");
        }
        if (response.status === 503 && error === "tax_config_authoring_feature_disabled") {
          definitive = true;
          return fail("FeatureDisabled");
        }
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      }
      return value;
    } catch (error) {
      if (error instanceof TaxConfigAuthoringClientError) {
        if (write && sent && !definitive && error.code === "Invalid") return fail("OutcomeUnknown");
        throw error;
      }
      return fail(write && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const live = (value: { observedAt: string; validUntil: string }) => {
    if (Date.now() < Date.parse(value.observedAt) || Date.now() >= Date.parse(value.validUntil))
      return fail("Stale");
  };
  const checkInput = (
    rawScope: StoreSetupScope,
    s: StoreSetupScope,
    options: TaxConfigCandidateRequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
    e: number,
    write = false,
  ) => {
    active(e, signal, write);
    if (
      !same(
        s,
        safe(() => parseStoreSetupScope(rawScope)),
      ) ||
      options.csrf !== csrf ||
      options.signal !== signal
    )
      return fail("ScopeChanged");
  };
  const finish = async (
    raw: unknown,
    c: TaxConfigCandidateCursor,
    e: number,
    o: TaxConfigCandidateRequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
  ) => {
    try {
      const r = await validateTaxConfigCandidateReceipt(raw, c);
      active(e, signal, true);
      if (o.csrf !== csrf || o.signal !== signal) return fail("ScopeChanged");
      return r;
    } catch (error) {
      if (
        error instanceof TaxConfigAuthoringClientError &&
        ["ScopeChanged", "OutcomeUnknown"].includes(error.code)
      )
        throw error;
      return fail("OutcomeUnknown");
    }
  };
  return Object.freeze({
    invalidate() {
      epoch++;
    },
    async prepare(
      rawScope: StoreSetupScope,
      value: unknown,
      options: Pick<TaxConfigCandidateRequestOptions, "signal"> = {},
    ): Promise<PreparedTaxConfigCandidateCommand> {
      const scope = parseStoreSetupScope(rawScope),
        command = parseTaxConfigCandidateCommand(value),
        e = begin(),
        signal = options.signal;
      active(e, signal);
      const intentDigest = await digest({ scope, command });
      checkInput(rawScope, scope, options, undefined, signal, e);
      const cursor = parseTaxConfigCandidateCursor({
        profile: "TaxConfigCandidatePendingOriginalV1",
        scope,
        ...command,
        intentDigest,
      });
      return Object.freeze({ scope, command, intentDigest, cursor });
    },
    async execute(
      value: PreparedTaxConfigCandidateCommand,
      options: TaxConfigCandidateRequestOptions,
    ) {
      const r = record(value, ["scope", "command", "intentDigest", "cursor"]),
        scope = parseStoreSetupScope(r.scope),
        command = parseTaxConfigCandidateCommand(r.command),
        cursor = parseTaxConfigCandidateCursor(r.cursor),
        intentDigest = hash(r.intentDigest),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      active(e, signal);
      if (
        !same(cursor, {
          profile: "TaxConfigCandidatePendingOriginalV1",
          scope,
          ...command,
          intentDigest,
        }) ||
        (await digest({ scope, command })) !== intentDigest
      )
        return fail();
      checkInput(value.scope, scope, options, csrf, signal, e);
      const raw = await request("candidates/commands", scope, options, command, e, 221184);
      checkInput(value.scope, scope, options, csrf, signal, e, true);
      return finish(raw, cursor, e, options, csrf, signal);
    },
    async resolve(value: TaxConfigCandidateCursor, options: TaxConfigCandidateRequestOptions) {
      const c = parseTaxConfigCandidateCursor(value),
        body = { ...cursorCommand(c), intentDigest: c.intentDigest },
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request("candidates/resolve-original", c.scope, options, body, e, 221184);
      checkInput(value.scope, c.scope, options, csrf, signal, e, true);
      return finish(raw, c, e, options, csrf, signal);
    },
    async current(
      rawScope: StoreSetupScope,
      selector: { configurationReference: string; targetVersionReference: string | null },
      options: TaxConfigCandidateRequestOptions = {},
    ) {
      const scope = parseStoreSetupScope(rawScope),
        r = record(selector, ["configurationReference", "targetVersionReference"]),
        selected = {
          configurationReference: ref(r.configurationReference),
          targetVersionReference: optionalRef(r.targetVersionReference),
        },
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request(
          `candidates/current?storeReference=${scope.storeReference}&configurationReference=${selected.configurationReference}${selected.targetVersionReference === null ? "" : "&targetVersionReference=" + selected.targetVersionReference}`,
          scope,
          options,
          undefined,
          e,
          212992,
        ),
        result = parseTaxConfigCandidateCurrent(raw, scope, selected);
      if (result.record) await validateTaxConfigCandidateRecord(result.record);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (!same(selector, selected)) return fail("ScopeChanged");
      live(result);
      return result;
    },
    async roster(
      rawScope: StoreSetupScope,
      selector: { configurationReference: string; afterCandidate: string | null },
      options: TaxConfigCandidateRequestOptions = {},
    ) {
      const scope = parseStoreSetupScope(rawScope),
        r = record(selector, ["configurationReference", "afterCandidate"]),
        selected = {
          configurationReference: ref(r.configurationReference),
          afterCandidate: optionalRef(r.afterCandidate),
        },
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request(
          `candidates/roster?storeReference=${scope.storeReference}&configurationReference=${selected.configurationReference}${selected.afterCandidate === null ? "" : "&afterCandidate=" + selected.afterCandidate}`,
          scope,
          options,
          undefined,
          e,
          131072,
        ),
        result = parseTaxConfigCandidateRoster(raw, scope, selected);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (!same(selector, selected)) return fail("ScopeChanged");
      live(result);
      return result;
    },
  });
}
