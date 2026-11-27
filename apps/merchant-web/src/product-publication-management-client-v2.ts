import {
  parseProductPublicationReplacementIntent,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  parseProductPublicationPeriod,
  parseProductPublicationScopes,
} from "./product-publication-command-client.js";
import {
  parseProductScopeJournalRequest,
  type ProductScopeJournalRequest,
} from "./product-scope-journal-client.js";
export interface ProductPublicationManagementRequest extends ProductScopeJournalRequest {
  readonly tenantReference: string;
}
export class ProductPublicationManagementClientErrorV2 extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Stale" | "ScopeChanged" | "Invalid") {
    super("Current Product publication management could not be loaded");
    this.name = "ProductPublicationManagementClientErrorV2";
  }
}
const fail = (code: ProductPublicationManagementClientErrorV2["code"] = "Unavailable"): never => {
  throw new ProductPublicationManagementClientErrorV2(code);
};
export const productPublicationManagementV2MaximumResponseBytes = 2 * 1024 * 1024;
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 2147483647)
    return fail();
  return value as number;
}
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : fail();
function parseManagementRequest(value: unknown): ProductPublicationManagementRequest {
  try {
    const r = record(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
      "expectedAggregateVersion",
    ]);
    const { tenantReference, ...request } = r;
    return Object.freeze({
      ...parseProductScopeJournalRequest(request),
      tenantReference: ref(tenantReference),
    });
  } catch {
    return fail("Invalid");
  }
}
function copy(value: unknown): unknown {
  let budget = 100000;
  const seen = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))
      return v;
    if (typeof v === "string") return v.length <= 4096 ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
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
            return visit(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
        return fail();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((key) => {
            const d = Object.getOwnPropertyDescriptor(v, key);
            if (typeof key !== "string" || !d?.enumerable || !("value" in d)) return fail();
            return [key, visit(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  };
  return visit(value, 0);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
const versionKeys = [
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "publicationVersion",
  "productAggregateVersion",
  "state",
  "contentDigest",
  "configurationDigest",
  "scopeSet",
  "scopeDigest",
  "effectivePeriod",
  "periodDigest",
  "validationEvidenceReference",
  "validationDecision",
  "policyReference",
  "policyVersion",
  "approvalPolicy",
  "reviewReference",
  "reviewVersion",
  "submittedByActorReference",
  "approvalEvidenceReference",
  "scheduleReference",
  "scheduleVersion",
  "publishedAt",
  "supersededAt",
  "supersededByVersionReference",
  "successorDraftVersionReference",
  "operationReference",
  "intentDigest",
  "actorReference",
  "actorKind",
  "occurredAt",
  "reasonCode",
] as const;
const actions = [
  "Validate",
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "CancelScheduledPublish",
  "ActivateScheduled",
  "Supersede",
] as const;
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function one<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) return fail();
  return value as T;
}
function array(value: unknown, maximum = 1000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  return value;
}
function revision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
}
async function sealed(r: Readonly<Record<string, unknown>>) {
  const { digest, ...body } = r;
  if (hash(digest) !== (await publicationValueDigest(body))) return fail();
}
async function publication(value: unknown) {
  const v2 = value !== null && typeof value === "object" && Object.hasOwn(value, "profile");
  const r = record(value, [
    ...versionKeys,
    ...(v2 ? ["profile", "replacementIntent", "replacementIntentDigest"] : []),
  ]);
  if (v2 && r.profile !== "CatalogProductPublicationVersionV2") return fail();
  for (const key of [
    "tenantReference",
    "brandReference",
    "productReference",
    "versionReference",
    "validationEvidenceReference",
    "policyReference",
    "operationReference",
    "actorReference",
  ])
    ref(r[key]);
  for (const key of [
    "reviewReference",
    "submittedByActorReference",
    "approvalEvidenceReference",
    "scheduleReference",
    "supersededByVersionReference",
    "successorDraftVersionReference",
  ])
    if (r[key] !== null) ref(r[key]);
  for (const key of [
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "intentDigest",
  ])
    hash(r[key]);
  for (const key of ["publicationVersion", "productAggregateVersion", "policyVersion"])
    integer(r[key], 1);
  integer(r.scheduleVersion);
  if (r.reviewVersion !== null) integer(r.reviewVersion, 1);
  for (const key of ["publishedAt", "supersededAt"]) if (r[key] !== null) instant(r[key]);
  if (typeof r.reasonCode !== "string" || !/^[A-Z][A-Z0-9_-]{0,63}$/u.test(r.reasonCode))
    return fail();
  one(r.actorKind, ["User", "System"]);
  const scopeSet = parseProductPublicationScopes(r.scopeSet),
    effectivePeriod = parseProductPublicationPeriod(r.effectivePeriod);
  if (
    !equal(scopeSet, r.scopeSet) ||
    !equal(effectivePeriod, r.effectivePeriod) ||
    (await publicationValueDigest(scopeSet)) !== r.scopeDigest ||
    (await publicationValueDigest(effectivePeriod)) !== r.periodDigest
  )
    return fail();
  const replacementIntent = v2
    ? await parseProductPublicationReplacementIntent(r.replacementIntent)
    : null;
  if (replacementIntent && r.replacementIntentDigest !== replacementIntent.digest) return fail();
  const state = one(r.state, [
      "Draft",
      "InReview",
      "Approved",
      "Scheduled",
      "Published",
      "Superseded",
    ] as const),
    validationDecision = one(r.validationDecision, [
      "Pass",
      "HardError",
      "WarningAcknowledgementRequired",
      ...(v2 ? ["ApprovalPending" as const] : []),
    ] as const);
  const approvalPolicy = one(r.approvalPolicy, ["Required", "NotRequired"] as const);
  if (
    (state === "Draft") !== (r.reviewReference === null) ||
    (r.reviewReference === null) !== (r.reviewVersion === null) ||
    (r.reviewReference === null) !== (r.submittedByActorReference === null)
  )
    return fail();
  if (
    (r.scheduleReference === null) !== (r.scheduleVersion === 0) ||
    (state === "Scheduled" && r.scheduleReference === null) ||
    (validationDecision === "ApprovalPending" &&
      (approvalPolicy !== "Required" || !["Draft", "InReview"].includes(state)))
  )
    return fail();
  return Object.freeze({
    ...r,
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    productReference: ref(r.productReference),
    intentDigest: hash(r.intentDigest),
    scopeDigest: hash(r.scopeDigest),
    periodDigest: hash(r.periodDigest),
    publishedAt: r.publishedAt === null ? null : instant(r.publishedAt),
    supersededAt: r.supersededAt === null ? null : instant(r.supersededAt),
    profile: v2 ? ("CatalogProductPublicationVersionV2" as const) : null,
    versionReference: ref(r.versionReference),
    publicationVersion: integer(r.publicationVersion, 1),
    productAggregateVersion: integer(r.productAggregateVersion, 1),
    operationReference: ref(r.operationReference),
    state,
    contentDigest: hash(r.contentDigest),
    configurationDigest: hash(r.configurationDigest),
    scopeSet,
    effectivePeriod,
    scheduleReference: r.scheduleReference === null ? null : ref(r.scheduleReference),
    scheduleVersion: integer(r.scheduleVersion),
    occurredAt: instant(r.occurredAt),
    approvalPolicy,
    validationDecision,
    replacementIntent,
    replacementIntentDigest: replacementIntent?.digest ?? null,
    original: value,
  });
}
/** Closed browser wire values; native owning admission remains required for every action. */
export async function parseProductPublicationManagementViewV2(
  value: unknown,
  expected: ProductPublicationManagementRequest,
  now: () => number = Date.now,
) {
  try {
    const request = parseManagementRequest(expected),
      safe = copy(value),
      raw = record(safe, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "productReference",
        "aggregateVersion",
        "observedAt",
        "validUntil",
        "editorObservedAt",
        "sourceObservedAt",
        "sourceRevision",
        "sourceDigest",
        "coverage",
        "eligibility",
        "publishValidation",
        "draft",
        "versions",
        "history",
        "scopeRetirementHeaders",
        "noReplacementIntent",
        "replacementTargets",
        "digest",
      ]);
    if (
      new TextEncoder().encode(JSON.stringify(safe)).byteLength >
        productPublicationManagementV2MaximumResponseBytes ||
      raw.profile !== "CatalogProductPublicationManagementV2" ||
      raw.coverage !== "CompleteRecordedPublicationManagement" ||
      raw.eligibility !== "NotEvaluated" ||
      raw.publishValidation !== "Incomplete"
    )
      return fail();
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
    ] as const) {
      ref(raw[key]);
      if (raw[key] !== request[key]) return fail("ScopeChanged");
    }
    if (integer(raw.aggregateVersion, 1) !== request.expectedAggregateVersion) return fail("Stale");
    const observedAt = instant(raw.observedAt),
      validUntil = instant(raw.validUntil),
      editorObservedAt = instant(raw.editorObservedAt),
      sourceObservedAt = instant(raw.sourceObservedAt),
      first = now();
    const freshness = () => {
      const at = now();
      if (
        !Number.isFinite(first) ||
        !Number.isFinite(at) ||
        at < first ||
        observedAt < editorObservedAt ||
        observedAt < sourceObservedAt ||
        Date.parse(validUntil) !==
          Math.min(Date.parse(editorObservedAt), Date.parse(sourceObservedAt)) + 5000 ||
        at < Date.parse(observedAt) ||
        at >= Date.parse(validUntil)
      )
        return fail("Stale");
    };
    freshness();
    await sealed(raw);
    const d = record(raw.draft, [
        "versionReference",
        "contentDigest",
        "configurationDigest",
        "contentStatus",
      ]),
      draft = Object.freeze({
        versionReference: ref(d.versionReference),
        contentDigest: hash(d.contentDigest),
        configurationDigest: hash(d.configurationDigest),
        contentStatus: one(d.contentStatus, ["Present", "Unavailable"] as const),
      });
    const versions = await Promise.all(array(raw.versions, 1000).map(publication));
    if (new Set(versions.map((v) => v.versionReference)).size !== versions.length) return fail();
    const history = await Promise.all(
      array(raw.history).map(async (entry) => {
        const r = record(entry, ["publicationAction", "publication"]);
        return {
          publicationAction: one(r.publicationAction, actions),
          publication: await publication(r.publication),
        };
      }),
    );
    const heads = new Map<string, (typeof versions)[number]>(),
      operations = new Map<string, (typeof history)[number]>();
    for (const entry of history) {
      const p = entry.publication,
        previous = heads.get(p.versionReference);
      if (
        p.tenantReference !== request.tenantReference ||
        p.brandReference !== request.brandReference ||
        p.productReference !== request.productReference ||
        p.occurredAt > sourceObservedAt ||
        p.productAggregateVersion >= request.expectedAggregateVersion ||
        p.publicationVersion !== (previous?.publicationVersion ?? 0) + 1 ||
        operations.has(p.operationReference)
      )
        return fail();
      heads.set(p.versionReference, p);
      operations.set(p.operationReference, entry);
    }
    if (
      !equal(
        [...heads.values()]
          .sort((a, b) => a.versionReference.localeCompare(b.versionReference))
          .map((v) => v.original),
        raw.versions,
      )
    )
      return fail();
    const headers = array(raw.scopeRetirementHeaders),
      retired = new Set<string>(),
      headerOps = new Set<string>();
    const retirements: {
      previousVersionReference: string;
      previousPublicationOperationReference: string;
      previousSelectorIndex: number;
      incomingVersionReference: string;
      retiredAt: string;
    }[] = [];
    for (const value of headers) {
      const h = record(value, [
        "profile",
        "tenantReference",
        "brandReference",
        "productReference",
        "operationReference",
        "versionReference",
        "publicationVersion",
        "publicationAction",
        "sourceAggregateVersion",
        "resultAggregateVersion",
        "publicationIntentDigest",
        "publicationSnapshotDigest",
        "observedSourceRevision",
        "observedSourceHeadDigest",
        "recordedAt",
        "retirements",
        "digest",
      ]);
      if (h.profile !== "CatalogProductScopeRetirementHeaderV1") return fail();
      await sealed(h);
      revision(h.observedSourceRevision);
      hash(h.observedSourceHeadDigest);
      const entry = operations.get(ref(h.operationReference)),
        p = entry?.publication;
      if (
        !entry ||
        !p?.replacementIntent ||
        headerOps.has(p.operationReference) ||
        h.tenantReference !== p.tenantReference ||
        h.brandReference !== p.brandReference ||
        h.productReference !== p.productReference ||
        h.versionReference !== p.versionReference ||
        h.publicationVersion !== p.publicationVersion ||
        h.publicationAction !== entry.publicationAction ||
        h.sourceAggregateVersion !== p.productAggregateVersion ||
        h.resultAggregateVersion !== p.productAggregateVersion + 1 ||
        h.publicationIntentDigest !== p.intentDigest ||
        h.publicationSnapshotDigest !== (await publicationValueDigest(p.original)) ||
        h.recordedAt !== p.occurredAt
      )
        return fail();
      headerOps.add(p.operationReference);
      const rows = array(h.retirements, 1),
        publishes =
          entry.publicationAction === "Publish" || entry.publicationAction === "ActivateScheduled";
      if (
        rows.length !==
        (publishes && p.replacementIntent.mode === "PermanentSelectorRetirement" ? 1 : 0)
      )
        return fail();
      for (const value of rows) {
        const row = record(value, [
          "profile",
          "replacementIntent",
          "previousPublicationDigest",
          "retiredAt",
          "digest",
        ]);
        await sealed(row);
        const intent = await parseProductPublicationReplacementIntent(row.replacementIntent);
        if (
          row.profile !== "CatalogProductExactStoreSelectorRetirementV1" ||
          intent.mode !== "PermanentSelectorRetirement" ||
          !equal(intent, p.replacementIntent) ||
          row.retiredAt !== p.occurredAt ||
          row.retiredAt !== p.publishedAt
        )
          return fail();
        const old = operations.get(intent.previousPublicationOperationReference)?.publication;
        if (
          !old ||
          old.state !== "Published" ||
          row.previousPublicationDigest !== (await publicationValueDigest(old.original)) ||
          intent.previousVersionReference !== old.versionReference ||
          intent.expectedPreviousPublicationVersion !== old.publicationVersion ||
          intent.previousIntentDigest !== old.intentDigest ||
          intent.previousScopeDigest !== old.scopeDigest ||
          intent.previousPeriodDigest !== old.periodDigest ||
          old.scopeSet[intent.previousSelectorIndex] === undefined ||
          old.scopeSet[intent.previousSelectorIndex]?.level !== "Store" ||
          intent.previousSelectorDigest !==
            (await publicationValueDigest(old.scopeSet[intent.previousSelectorIndex])) ||
          p.scopeSet.length !== 1 ||
          !equal(p.scopeSet[0], old.scopeSet[intent.previousSelectorIndex]) ||
          old.occurredAt > p.occurredAt ||
          old.effectivePeriod.effectiveFrom.instant > p.occurredAt ||
          (old.effectivePeriod.effectiveUntil !== null &&
            old.effectivePeriod.effectiveUntil.instant <= p.occurredAt) ||
          p.effectivePeriod.effectiveFrom.instant > p.occurredAt ||
          (p.effectivePeriod.effectiveUntil !== null &&
            p.effectivePeriod.effectiveUntil.instant <= p.occurredAt)
        )
          return fail();
        const prefix = new Map<string, typeof old>();
        for (const previous of history) {
          if (previous.publication.operationReference === p.operationReference) break;
          prefix.set(previous.publication.versionReference, previous.publication);
        }
        if (prefix.get(old.versionReference)?.operationReference !== old.operationReference)
          return fail();
        const key =
          intent.previousPublicationOperationReference + ":" + intent.previousSelectorIndex;
        if (retired.has(key)) return fail();
        retired.add(key);
        retirements.push(
          Object.freeze({
            previousVersionReference: intent.previousVersionReference,
            previousPublicationOperationReference: intent.previousPublicationOperationReference,
            previousSelectorIndex: intent.previousSelectorIndex,
            incomingVersionReference: p.versionReference,
            retiredAt: instant(row.retiredAt),
          }),
        );
      }
    }
    if (
      history.some(
        (e) =>
          e.publication.replacementIntent !== null &&
          !headerOps.has(e.publication.operationReference),
      )
    )
      return fail();
    const sourceRevision = revision(raw.sourceRevision),
      sourceDigest = hash(raw.sourceDigest);
    if (
      sourceDigest !==
      (await publicationValueDigest({
        profile: "CatalogProductRetirementCoverageV1",
        coverage: "CompleteRecordedPublicationRetirements",
        sourceAuthority: "NotEvaluated",
        eligibility: "NotEvaluated",
        tenantReference: request.tenantReference,
        brandReference: request.brandReference,
        productReference: request.productReference,
        aggregateVersion: request.expectedAggregateVersion,
        sourceRevision,
        observedAt: sourceObservedAt,
        history: raw.history,
        headers: raw.scopeRetirementHeaders,
        latest: raw.versions,
      }))
    )
      return fail();
    const noReplacementIntent = await parseProductPublicationReplacementIntent(
      raw.noReplacementIntent,
    );
    if (noReplacementIntent.mode !== "None") return fail();
    const replacementTargets = await Promise.all(
      array(raw.replacementTargets, 1000).map(async (value) => {
        const r = record(value, ["selector", "replacementIntent"]),
          intent = await parseProductPublicationReplacementIntent(r.replacementIntent);
        if (intent.mode !== "PermanentSelectorRetirement") return fail();
        const old = heads.get(intent.previousVersionReference),
          selector = parseProductPublicationScopes([r.selector])[0];
        if (
          !old ||
          !selector ||
          selector.level !== "Store" ||
          selector.reference !== request.storeReference ||
          old.state !== "Published" ||
          old.publishedAt === null ||
          String(old.publishedAt) > observedAt ||
          old.supersededAt !== null ||
          old.effectivePeriod.effectiveFrom.instant > observedAt ||
          (old.effectivePeriod.effectiveUntil !== null &&
            old.effectivePeriod.effectiveUntil.instant <= observedAt) ||
          old.scopeSet.some((s) => s.level !== "Store") ||
          new Set(old.scopeSet.map((s) => s.reference)).size !== old.scopeSet.length ||
          intent.previousPublicationOperationReference !== old.operationReference ||
          intent.expectedPreviousPublicationVersion !== old.publicationVersion ||
          intent.previousIntentDigest !== old.intentDigest ||
          intent.previousScopeDigest !== old.scopeDigest ||
          intent.previousPeriodDigest !== old.periodDigest ||
          !equal(old.scopeSet[intent.previousSelectorIndex], selector) ||
          (await publicationValueDigest(selector)) !== intent.previousSelectorDigest ||
          retired.has(old.operationReference + ":" + intent.previousSelectorIndex)
        )
          return fail();
        return Object.freeze({ selector, replacementIntent: intent });
      }),
    );
    if (
      new Set(replacementTargets.map((t) => t.replacementIntent.digest)).size !==
      replacementTargets.length
    )
      return fail();
    const expectedTargets = versions.flatMap((old) =>
      old.state === "Published" &&
      old.publishedAt !== null &&
      String(old.publishedAt) <= observedAt &&
      old.supersededAt === null &&
      old.effectivePeriod.effectiveFrom.instant <= observedAt &&
      (old.effectivePeriod.effectiveUntil === null ||
        old.effectivePeriod.effectiveUntil.instant > observedAt) &&
      old.scopeSet.every((s) => s.level === "Store") &&
      new Set(old.scopeSet.map((s) => s.reference)).size === old.scopeSet.length
        ? old.scopeSet.flatMap((selector, index) =>
            selector.reference === request.storeReference &&
            !retired.has(old.operationReference + ":" + index)
              ? [old.operationReference + ":" + index]
              : [],
          )
        : [],
    );
    if (
      !equal(
        [...expectedTargets].sort(),
        replacementTargets
          .map(
            (t) =>
              t.replacementIntent.previousPublicationOperationReference +
              ":" +
              t.replacementIntent.previousSelectorIndex,
          )
          .sort(),
      )
    )
      return fail();
    freshness();
    return Object.freeze({
      tenantReference: request.tenantReference,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
      productReference: request.productReference,
      revision: request.expectedAggregateVersion,
      observedAt,
      validUntil,
      coverage: "CompleteRecordedPublicationManagement" as const,
      eligibility: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      draft,
      versions: Object.freeze(versions),
      sourceRevision,
      sourceDigest,
      history: Object.freeze(history.map((entry) => Object.freeze(entry))),
      retirements: Object.freeze(retirements),
      noReplacementIntent,
      replacementTargets: Object.freeze(replacementTargets),
    });
  } catch (error) {
    if (error instanceof ProductPublicationManagementClientErrorV2) throw error;
    return fail();
  }
}
export type ProductPublicationManagementViewV2 = Awaited<
  ReturnType<typeof parseProductPublicationManagementViewV2>
>;
export function createProductPublicationManagementClientV2(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      input: { request: ProductPublicationManagementRequest; csrf: string },
      signal: AbortSignal,
    ): Promise<ProductPublicationManagementViewV2> {
      const selected = parseManagementRequest(input.request),
        controller = new AbortController();
      if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf))
        return fail("Invalid");
      const cancelled = () =>
        new DOMException("Product publication management read cancelled", "AbortError");
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const guard = <T>(promise: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const interrupted = () =>
            reject(
              signal.aborted
                ? cancelled()
                : new ProductPublicationManagementClientErrorV2("Unavailable"),
            );
          if (controller.signal.aborted) {
            void promise.catch(() => undefined);
            interrupted();
            return;
          }
          controller.signal.addEventListener("abort", interrupted, { once: true });
          promise
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener("abort", interrupted))
            .catch(() => undefined);
        });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        finished = false;
      try {
        if (controller.signal.aborted) throw cancelled();
        const bytes = new TextEncoder().encode(
            JSON.stringify({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
            }),
          ),
          encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/u, "");
        const response = await guard(
          fetcher("/merchant/catalog/products/publication/management/v2", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "x-bop-csrf": input.csrf,
              "x-bop-catalog-scope": encoded,
            },
            body: JSON.stringify({
              productReference: selected.productReference,
              expectedAggregateVersion: selected.expectedAggregateVersion,
            }),
          }),
        );
        if (
          response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !response.body ||
          response.redirected
        )
          return fail();
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > productPublicationManagementV2MaximumResponseBytes)
        )
          return fail();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let total = 0,
          body = "";
        while (true) {
          const chunk = await guard(reader.read());
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) return fail();
          total += chunk.value.byteLength;
          if (total > productPublicationManagementV2MaximumResponseBytes) return fail();
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        finished = true;
        if (length !== null && Number(length) !== total) return fail();
        if (controller.signal.aborted) {
          if (signal.aborted) throw cancelled();
          return fail();
        }
        const raw: unknown = JSON.parse(body);
        if (!response.ok) {
          const error = record(raw, ["error"]).error;
          if ((response.status === 401 || response.status === 403) && error === "request_denied")
            return fail("Denied");
          if (response.status === 400 && error === "product_publication_management_invalid")
            return fail("Invalid");
          return fail();
        }
        if (response.status !== 200) return fail();
        const parsed = await guard(parseProductPublicationManagementViewV2(raw, selected, now));
        if (controller.signal.aborted) throw cancelled();
        return parsed;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductPublicationManagementClientErrorV2) throw error;

        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (reader) {
          try {
            if (!finished) void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          } catch {
            // Cleanup must not replace the bounded transport error.
          }
        }
        controller.abort();
      }
    },
  });
}

export type ProductPublicationManagementClientV2 = ReturnType<
  typeof createProductPublicationManagementClientV2
>;
