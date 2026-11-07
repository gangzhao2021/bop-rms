import type { ProductPublicationManagementViewV2 } from "./product-publication-management-client-v2.js";
import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogCode,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";

export const productPublicationValidationReportMaximumResponseBytes = 2 * 1024 * 1024;
export const productPublicationValidationCheckCodes = Object.freeze([
  "ApprovalPolicy",
  "ChangeImpact",
  "DefaultLocaleName",
  "EffectivePeriod",
  "HardErrorsCleared",
  "InternalCode",
  "MediaReady",
  "OptionSelection",
  "PublishableSku",
  "TaxResolution",
  "UniqueScope",
  "VariantMapping",
] as const);
export interface ProductPublicationValidationReportRequestV2 {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly expectedPublicationVersion: number;
}
export class ProductPublicationValidationReportClientError extends Error {
  constructor(
    readonly code:
      "Invalid" | "Denied" | "FeatureDisabled" | "Unavailable" | "Stale" | "ScopeChanged",
  ) {
    super("Product validation report could not be loaded");
    this.name = "ProductPublicationValidationReportClientError";
  }
}
const fail = (
  code: ProductPublicationValidationReportClientError["code"] = "Unavailable",
): never => {
  throw new ProductPublicationValidationReportClientError(code);
};
function integer(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 2147483647)
    return fail();
  return value as number;
}
function hash(value: unknown): string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : fail();
}
function code(value: unknown): string {
  const parsed = parseCatalogCode(value);
  return parsed === value ? parsed : fail();
}
function one<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : fail();
}
function array(value: unknown, maximum: number): readonly unknown[] {
  return Array.isArray(value) && value.length <= maximum ? value : fail();
}
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function sorted<T>(value: unknown, parse: (item: unknown) => T, maximum: number): readonly T[] {
  const result = array(value, maximum)
    .map(parse)
    .sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
  if (new Set(result.map(canonical)).size !== result.length) return fail();
  return Object.freeze(result);
}
/** Descriptor-safe detached copy before any asynchronous digest work. */
function copy(value: unknown): unknown {
  let budget = 100000;
  const active = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))
      return v;
    if (typeof v === "string") return v.length <= 4096 ? v : fail();
    if (!v || typeof v !== "object" || active.has(v)) return fail();
    active.add(v);
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
      active.delete(v);
    }
  };
  return visit(value, 0);
}
function persistedBytes(value: unknown): number {
  if (Array.isArray(value))
    return 2 + Math.max(0, value.length - 1) * 2 + value.reduce((n, v) => n + persistedBytes(v), 0);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      2 +
      Math.max(0, entries.length - 1) * 2 +
      entries.reduce((n, [key, v]) => n + persistedBytes(key) + 2 + persistedBytes(v), 0)
    );
  }
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function parseProductPublicationValidationReportRequestV2(
  value: unknown,
): ProductPublicationValidationReportRequestV2 {
  try {
    const r = record(copy(value), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
      "versionReference",
      "expectedAggregateVersion",
      "expectedPublicationVersion",
    ]);
    return Object.freeze({
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      productReference: ref(r.productReference),
      versionReference: ref(r.versionReference),
      expectedAggregateVersion: integer(r.expectedAggregateVersion),
      expectedPublicationVersion: integer(r.expectedPublicationVersion, 0),
    });
  } catch {
    return fail("Invalid");
  }
}
function binding(value: unknown) {
  const r = record(value, [
    "tenantReference",
    "brandReference",
    "productReference",
    "versionReference",
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "replacementIntentDigest",
    "policyReference",
    "policyVersion",
  ]);
  return Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    productReference: ref(r.productReference),
    versionReference: ref(r.versionReference),
    contentDigest: hash(r.contentDigest),
    configurationDigest: hash(r.configurationDigest),
    scopeDigest: hash(r.scopeDigest),
    periodDigest: hash(r.periodDigest),
    replacementIntentDigest: hash(r.replacementIntentDigest),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
  });
}
function validation(value: unknown) {
  const r = record(value, [
    "profile",
    "replacementIntentDigest",
    "evidenceReference",
    "productAggregateVersion",
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "policyReference",
    "policyVersion",
    "approvalPolicy",
    "checks",
    "warningAcknowledgement",
    "checkedAt",
    "validUntil",
  ]);
  if (r.profile !== "CatalogProductPublicationValidationV2") return fail();
  const approvalPolicy = one(r.approvalPolicy, ["Required", "NotRequired"] as const),
    checks = array(r.checks, 12)
      .map((value) => {
        const c = record(value, ["code", "outcome"]);
        return Object.freeze({
          code: one(c.code, productPublicationValidationCheckCodes),
          outcome: one(c.outcome, ["Pass", "HardError", "Warning", "Pending"] as const),
        });
      })
      .sort((a, b) => a.code.localeCompare(b.code, "en"));
  if (
    checks.length !== 12 ||
    new Set(checks.map((c) => c.code)).size !== 12 ||
    checks.some(
      (c) =>
        c.outcome === "Pending" && (c.code !== "ApprovalPolicy" || approvalPolicy !== "Required"),
    )
  )
    return fail();
  if (
    checks.find((c) => c.code === "HardErrorsCleared")?.outcome !==
    (checks.some((c) => c.code !== "HardErrorsCleared" && c.outcome === "HardError")
      ? "HardError"
      : "Pass")
  )
    return fail();
  const rawAck =
      r.warningAcknowledgement === null
        ? null
        : record(r.warningAcknowledgement, ["actorReference", "reasonCode", "warningCodes"]),
    warningAcknowledgement =
      rawAck === null
        ? null
        : Object.freeze({
            actorReference: ref(rawAck.actorReference),
            reasonCode: code(rawAck.reasonCode),
            warningCodes: Object.freeze(
              array(rawAck.warningCodes, 12)
                .map((v) => one(v, productPublicationValidationCheckCodes))
                .sort(),
            ),
          }),
    warnings = checks.filter((c) => c.outcome === "Warning").map((c) => c.code),
    checkedAt = instant(r.checkedAt),
    validUntil = instant(r.validUntil);
  if (
    validUntil <= checkedAt ||
    (warningAcknowledgement !== null &&
      (warnings.length === 0 || !equal(warnings, warningAcknowledgement.warningCodes)))
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductPublicationValidationV2" as const,
    replacementIntentDigest: hash(r.replacementIntentDigest),
    evidenceReference: ref(r.evidenceReference),
    productAggregateVersion: integer(r.productAggregateVersion),
    contentDigest: hash(r.contentDigest),
    configurationDigest: hash(r.configurationDigest),
    scopeDigest: hash(r.scopeDigest),
    periodDigest: hash(r.periodDigest),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
    approvalPolicy,
    checks: Object.freeze(checks),
    warningAcknowledgement,
    checkedAt,
    validUntil,
  });
}
function details(value: unknown) {
  const object = record(value, ["coverage", "impact"], ["findings", "sources"]);
  if (object.coverage === "ChecksOnly") {
    const r = record(value, ["coverage", "impact"]);
    if (r.impact !== "NotRecorded") return fail();
    return Object.freeze({ coverage: "ChecksOnly" as const, impact: "NotRecorded" as const });
  }
  const r = record(value, ["coverage", "impact", "findings", "sources"]);
  if (r.coverage !== "Complete" || r.impact !== "Recorded") return fail();
  const findings = sorted(
      r.findings,
      (value) => {
        const f = record(value, [
          "checkCode",
          "ruleCode",
          "outcome",
          "subjectReference",
          "reasonCode",
          "references",
        ]);
        return Object.freeze({
          checkCode: one(f.checkCode, productPublicationValidationCheckCodes),
          ruleCode: code(f.ruleCode),
          outcome: one(f.outcome, ["Warning", "HardError"] as const),
          subjectReference: f.subjectReference === null ? null : ref(f.subjectReference),
          reasonCode: code(f.reasonCode),
          references: sorted(
            f.references,
            (value) => {
              const r = record(value, [
                "sourceCode",
                "resourceReference",
                "versionReference",
                "referenceDigest",
              ]);
              return Object.freeze({
                sourceCode: code(r.sourceCode),
                resourceReference: ref(r.resourceReference),
                versionReference: r.versionReference === null ? null : ref(r.versionReference),
                referenceDigest: hash(r.referenceDigest),
              });
            },
            1000,
          ),
        });
      },
      1000,
    ),
    sources = sorted(
      r.sources,
      (value) => {
        const s = record(value, [
            "sourceCode",
            "sourceDigest",
            "generation",
            "relevantReferenceDigest",
            "observedAt",
            "validUntil",
          ]),
          observedAt = instant(s.observedAt),
          validUntil = instant(s.validUntil);
        if (
          validUntil <= observedAt ||
          Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
          (s.generation !== null &&
            (typeof s.generation !== "string" ||
              !/^(0|[1-9][0-9]{0,18})$/u.test(s.generation) ||
              BigInt(s.generation) > 9223372036854775807n))
        )
          return fail();
        return Object.freeze({
          sourceCode: code(s.sourceCode),
          sourceDigest: hash(s.sourceDigest),
          generation: s.generation as string | null,
          relevantReferenceDigest: hash(s.relevantReferenceDigest),
          observedAt,
          validUntil,
        });
      },
      100,
    );
  if (
    !sources.length ||
    new Set(sources.map((s) => s.sourceCode)).size !== sources.length ||
    findings.some((f) =>
      f.references.some((r) => !sources.some((s) => s.sourceCode === r.sourceCode)),
    )
  )
    return fail();
  return Object.freeze({
    coverage: "Complete" as const,
    impact: "Recorded" as const,
    findings,
    sources,
  });
}
async function report(value: unknown) {
  const r = record(value, [
      "profile",
      "operationReference",
      "publicationAction",
      "originalIntentDigest",
      "publicationSnapshotDigest",
      "sourceAggregateVersion",
      "resultAggregateVersion",
      "publicationVersion",
      "validationEvidenceReference",
      "recordedAt",
      "binding",
      "validation",
      "details",
      "warningBindingDigest",
      "digest",
    ]),
    b = binding(r.binding),
    v = validation(r.validation),
    d = details(r.details),
    recordedAt = instant(r.recordedAt),
    sourceAggregateVersion = integer(r.sourceAggregateVersion),
    resultAggregateVersion = integer(r.resultAggregateVersion);
  if (
    r.profile !== "CatalogProductPublicationValidationReportV1" ||
    resultAggregateVersion !== sourceAggregateVersion + 1 ||
    v.productAggregateVersion !== sourceAggregateVersion ||
    r.validationEvidenceReference !== v.evidenceReference ||
    v.checkedAt > recordedAt ||
    v.validUntil <= recordedAt
  )
    return fail();
  for (const key of [
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "replacementIntentDigest",
    "policyReference",
    "policyVersion",
  ] as const)
    if (b[key] !== v[key]) return fail();
  let warningBindingDigest: string | null = null;
  if (d.coverage === "Complete") {
    if (d.sources.some((s) => s.observedAt > recordedAt || s.validUntil < v.validUntil))
      return fail();
    for (const check of v.checks) {
      const found = d.findings.filter((f) => f.checkCode === check.code);
      if (check.code === "HardErrorsCleared") {
        if (found.length) return fail();
        continue;
      }
      const outcome = found.some((f) => f.outcome === "HardError")
        ? "HardError"
        : found.length
          ? "Warning"
          : null;
      if (
        outcome !== null
          ? check.outcome !== outcome
          : check.outcome === "HardError" || check.outcome === "Warning"
      )
        return fail();
    }
    warningBindingDigest = await publicationValueDigest({
      binding: b,
      warningCodes: v.checks.filter((c) => c.outcome === "Warning").map((c) => c.code),
      findings: d.findings,
      references: d.sources
        .map((s) => ({
          sourceCode: s.sourceCode,
          relevantReferenceDigest: s.relevantReferenceDigest,
        }))
        .sort((a, b) => a.sourceCode.localeCompare(b.sourceCode, "en")),
    });
  }
  if (r.warningBindingDigest !== warningBindingDigest) return fail();
  const body = {
      profile: "CatalogProductPublicationValidationReportV1" as const,
      operationReference: ref(r.operationReference),
      publicationAction: one(r.publicationAction, [
        "Validate",
        "SubmitReview",
        "Approve",
        "Reject",
        "Publish",
        "SchedulePublish",
        "ReschedulePublish",
        "CancelScheduledPublish",
        "ActivateScheduled",
      ] as const),
      originalIntentDigest: hash(r.originalIntentDigest),
      publicationSnapshotDigest: hash(r.publicationSnapshotDigest),
      sourceAggregateVersion,
      resultAggregateVersion,
      publicationVersion: integer(r.publicationVersion),
      validationEvidenceReference: v.evidenceReference,
      recordedAt,
      binding: b,
      validation: v,
      details: d,
      warningBindingDigest,
    },
    digest = hash(r.digest);
  if (
    digest !== (await publicationValueDigest(body)) ||
    persistedBytes({ ...body, digest }) > 1048576
  )
    return fail();
  return Object.freeze({ ...body, digest });
}
export async function parseProductPublicationValidationReportViewV2(
  value: unknown,
  requestValue: ProductPublicationValidationReportRequestV2,
  now: () => number,
) {
  try {
    const request = parseProductPublicationValidationReportRequestV2(requestValue),
      safe = copy(value),
      r = record(safe, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "productReference",
        "versionReference",
        "aggregateVersion",
        "publicationVersion",
        "selectedPublicationOperationReference",
        "selectedPublicationDigest",
        "currentDraft",
        "status",
        "applicability",
        "report",
        "observedAt",
        "validUntil",
        "eligibility",
        "digest",
      ]);
    if (
      new TextEncoder().encode(canonical(safe)).length >
        productPublicationValidationReportMaximumResponseBytes ||
      r.profile !== "CatalogProductPublicationValidationReportViewV1" ||
      r.eligibility !== "NotEvaluated"
    )
      return fail();
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
      "versionReference",
    ] as const)
      if (ref(r[key]) !== request[key]) return fail("ScopeChanged");
    const aggregateVersion = integer(r.aggregateVersion),
      publicationVersion = integer(r.publicationVersion, 0);
    if (
      aggregateVersion !== request.expectedAggregateVersion ||
      publicationVersion !== request.expectedPublicationVersion
    )
      return fail("Stale");
    const observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil),
      initial = now(),
      fresh = () => {
        const at = now();
        if (
          !Number.isFinite(at) ||
          !Number.isFinite(initial) ||
          at < initial ||
          at < Date.parse(observedAt) ||
          at >= Date.parse(validUntil) ||
          validUntil <= observedAt ||
          Date.parse(validUntil) - Date.parse(observedAt) > 5000
        )
          return fail("Stale");
      };
    fresh();
    const rawDraft = record(r.currentDraft, [
        "versionReference",
        "contentDigest",
        "configurationDigest",
        "contentStatus",
      ]),
      currentDraft = Object.freeze({
        versionReference: ref(rawDraft.versionReference),
        contentDigest: hash(rawDraft.contentDigest),
        configurationDigest: hash(rawDraft.configurationDigest),
        contentStatus: one(rawDraft.contentStatus, ["Present", "Unavailable"] as const),
      }),
      status = one(r.status, ["Recorded", "NotValidated", "NotRecorded"] as const),
      applicability = one(r.applicability, [
        "CurrentDraftContent",
        "ChangedDraftContent",
        "HistoricalVersion",
        "NotValidated",
      ] as const),
      selectedPublicationOperationReference =
        r.selectedPublicationOperationReference === null
          ? null
          : ref(r.selectedPublicationOperationReference),
      selectedPublicationDigest =
        r.selectedPublicationDigest === null ? null : hash(r.selectedPublicationDigest),
      parsedReport = r.report === null ? null : await report(r.report);
    if (status === "NotValidated") {
      if (
        publicationVersion !== 0 ||
        selectedPublicationOperationReference !== null ||
        selectedPublicationDigest !== null ||
        parsedReport !== null ||
        applicability !== "NotValidated" ||
        currentDraft.versionReference !== request.versionReference
      )
        return fail();
    } else {
      if (
        publicationVersion < 1 ||
        selectedPublicationOperationReference === null ||
        selectedPublicationDigest === null ||
        applicability === "NotValidated" ||
        (currentDraft.versionReference === request.versionReference &&
          currentDraft.contentStatus !== "Present")
      )
        return fail();
      if ((status === "Recorded") !== (parsedReport !== null)) return fail();
      if (parsedReport) {
        if (
          parsedReport.operationReference !== selectedPublicationOperationReference ||
          parsedReport.publicationSnapshotDigest !== selectedPublicationDigest ||
          parsedReport.publicationVersion !== publicationVersion ||
          parsedReport.resultAggregateVersion > aggregateVersion ||
          parsedReport.recordedAt > observedAt
        )
          return fail();
        for (const key of [
          "tenantReference",
          "brandReference",
          "productReference",
          "versionReference",
        ] as const)
          if (parsedReport.binding[key] !== request[key]) return fail("ScopeChanged");
        const expected =
          currentDraft.versionReference !== request.versionReference
            ? "HistoricalVersion"
            : currentDraft.contentStatus === "Present" &&
                currentDraft.contentDigest === parsedReport.binding.contentDigest &&
                currentDraft.configurationDigest === parsedReport.binding.configurationDigest
              ? "CurrentDraftContent"
              : "ChangedDraftContent";
        if (applicability !== expected) return fail();
      } else if (
        (currentDraft.versionReference !== request.versionReference) !==
        (applicability === "HistoricalVersion")
      )
        return fail();
    }
    const body = {
        profile: "CatalogProductPublicationValidationReportViewV1" as const,
        tenantReference: request.tenantReference,
        brandReference: request.brandReference,
        storeReference: request.storeReference,
        productReference: request.productReference,
        versionReference: request.versionReference,
        aggregateVersion,
        publicationVersion,
        selectedPublicationOperationReference,
        selectedPublicationDigest,
        currentDraft,
        status,
        applicability,
        report: parsedReport,
        observedAt,
        validUntil,
        eligibility: "NotEvaluated" as const,
      },
      digest = hash(r.digest);
    if (digest !== (await publicationValueDigest(body))) return fail();
    fresh();
    return Object.freeze({ ...body, digest });
  } catch (error) {
    if (error instanceof ProductPublicationValidationReportClientError) throw error;
    return fail();
  }
}
export type ProductPublicationValidationReportViewV2 = Awaited<
  ReturnType<typeof parseProductPublicationValidationReportViewV2>
>;

/** Bind the separately read historical report to the selected, already parsed management head. */
export async function assertProductPublicationValidationReportSelection(
  view: ProductPublicationValidationReportViewV2,
  publication: ProductPublicationManagementViewV2["versions"][number] | null,
): Promise<void> {
  if (publication === null) {
    if (view.status !== "NotValidated") return fail("ScopeChanged");
    return;
  }
  if (
    view.selectedPublicationOperationReference !== publication.operationReference ||
    view.selectedPublicationDigest !== (await publicationValueDigest(publication.original))
  )
    return fail("ScopeChanged");
  const report = view.report;
  if (!report) return;
  for (const [key, value] of Object.entries(report.binding)) {
    if (Object.getOwnPropertyDescriptor(publication.original, key)?.value !== value)
      return fail("ScopeChanged");
  }
  const validation = report.validation,
    decision = validation.checks.some((c) => c.outcome === "HardError")
      ? "HardError"
      : validation.checks.some((c) => c.outcome === "Warning") &&
          validation.warningAcknowledgement === null
        ? "WarningAcknowledgementRequired"
        : validation.checks.some((c) => c.outcome === "Pending")
          ? "ApprovalPending"
          : "Pass";
  if (
    report.originalIntentDigest !== publication.intentDigest ||
    report.sourceAggregateVersion !== publication.productAggregateVersion ||
    report.publicationVersion !== publication.publicationVersion ||
    report.validationEvidenceReference !==
      Object.getOwnPropertyDescriptor(publication.original, "validationEvidenceReference")?.value ||
    report.recordedAt < publication.occurredAt ||
    validation.approvalPolicy !== publication.approvalPolicy ||
    decision !== publication.validationDecision
  )
    return fail("ScopeChanged");
}

export function createProductPublicationValidationReportClientV2(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const capabilities = createStoreCapabilityClient(fetcher, now);
  return Object.freeze({
    async load(
      input: { request: ProductPublicationValidationReportRequestV2; csrf: string },
      signal: AbortSignal,
    ): Promise<{
      readonly view: ProductPublicationValidationReportViewV2;
      readonly validUntil: string;
    }> {
      const selected = parseProductPublicationValidationReportRequestV2(input.request),
        controller = new AbortController();
      let floor = now();
      const clock = () => {
        const at = now();
        if (!Number.isFinite(at) || !Number.isFinite(floor) || at < floor) return fail("Stale");
        floor = at;
        return at;
      };
      if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf))
        return fail("Invalid");
      const cancelled = () =>
        new DOMException("Product validation report read cancelled", "AbortError");
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
                : new ProductPublicationValidationReportClientError("Unavailable"),
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
        const capability = await guard(
          capabilities.load(
            {
              scope: {
                brandReference: selected.brandReference,
                storeReference: selected.storeReference,
              },
              capabilityKey: "catalog.cat_product_edit",
              csrf: input.csrf,
            },
            controller.signal,
          ),
        );
        const capabilityUntil = Date.parse(capability.observedAt) + 5000;
        if (
          capability.brandReference !== selected.brandReference ||
          capability.storeReference !== selected.storeReference ||
          capability.capabilityKey !== "catalog.cat_product_edit" ||
          capability.controlKey !== "catalog.product.edit"
        )
          return fail("ScopeChanged");
        if (
          capability.backendExecution !== "Allow" ||
          capability.frontendVisibility !== "Show" ||
          capability.reason !== "Enabled"
        )
          return fail("FeatureDisabled");
        if (clock() < Date.parse(capability.observedAt) || clock() >= capabilityUntil)
          return fail("Stale");
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
          fetcher("/merchant/catalog/products/publication/validation-report/v2", {
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
              versionReference: selected.versionReference,
              expectedAggregateVersion: selected.expectedAggregateVersion,
              expectedPublicationVersion: selected.expectedPublicationVersion,
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
            Number(length) > productPublicationValidationReportMaximumResponseBytes)
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
          if (total > productPublicationValidationReportMaximumResponseBytes) return fail();
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
          if (response.status === 400 && error === "product_publication_validation_report_invalid")
            return fail("Invalid");
          return fail();
        }
        if (response.status !== 200) return fail();
        const parsed = await guard(
          parseProductPublicationValidationReportViewV2(raw, selected, clock),
        );
        if (controller.signal.aborted) throw cancelled();
        const deadline = Math.min(capabilityUntil, Date.parse(parsed.validUntil));
        if (clock() >= deadline) return fail("Stale");
        return Object.freeze({ view: parsed, validUntil: new Date(deadline).toISOString() });
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductPublicationValidationReportClientError) throw error;
        if (error instanceof StoreCapabilityClientError) return fail(error.code);

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
