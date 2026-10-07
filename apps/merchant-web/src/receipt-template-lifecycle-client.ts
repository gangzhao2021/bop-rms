import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
export { StoreSetupClientError as ReceiptTemplateLifecycleClientError };
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
interface LifecyclePins {
  readonly action: "Approve" | "Publish";
  readonly operationReference: string;
  readonly templateReference: string;
  readonly expectedVersionReference: string;
  readonly expectedRevision: number;
  readonly reviewLifecycleReference: string;
  readonly expectedReviewVersion: number;
  readonly expectedReviewOperationReference: string;
}
export interface ReceiptTemplateLifecycleOriginal extends StoreSetupScope, LifecyclePins {
  readonly profile: "DigitalReceiptTemplateLifecycleActionV1";
  readonly purposeCode: "RECEIPT_TEMPLATE_REVIEW";
}
export interface ReceiptTemplateLifecycleCursor extends LifecyclePins {
  readonly profile: "ReceiptTemplateLifecyclePendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly intentDigest: string;
}
export interface PreparedReceiptTemplateLifecycle {
  readonly command: ReceiptTemplateLifecycleOriginal;
  readonly cursor: ReceiptTemplateLifecycleCursor;
  readonly intentDigest: string;
}
export interface ReceiptTemplatePublishedVersion {
  readonly templateReference: string;
  readonly versionReference: string;
  readonly versionNumber: number;
  readonly versionCode: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly locale: string;
  readonly dataContractVersion: 1;
  readonly renderEngineVersion: 1;
  readonly outputProfile: "AccessibleDigitalReceipt";
  readonly layoutDefinitionReference: string;
  readonly complianceRuleReference: string;
  readonly requiredFields: readonly (typeof receiptTemplateArtifactRequiredFields)[number][];
  readonly publicationReference: string;
  readonly publishedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}
export interface ReceiptTemplateLifecycleResult {
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly state: "Approved" | "Published";
  readonly mutationOperationReference: string;
  readonly changedAt: string;
  readonly approvalEvidenceReference: string;
  readonly approvedByReference: string;
  readonly approvedAt: string;
  readonly approvalValidUntil: string;
  readonly publishedVersion: ReceiptTemplatePublishedVersion | null;
}
export interface ReceiptTemplateLifecycleReceipt extends StoreSetupScope, LifecyclePins {
  readonly profile: "DigitalReceiptTemplateLifecycleReceiptV1";
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly result: ReceiptTemplateLifecycleResult | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof StoreSetupClientError) throw e;
    return fail();
  }
}
const positive = (v: unknown, min = 1): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= 2147483647 ? v : fail();
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const scopeKeys = ["tenantReference", "brandReference", "storeReference", "actorReference"];
const pinKeys = [
  "action",
  "operationReference",
  "templateReference",
  "expectedVersionReference",
  "expectedRevision",
  "reviewLifecycleReference",
  "expectedReviewVersion",
  "expectedReviewOperationReference",
];
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
const sameScope = (a: StoreSetupScope, b: StoreSetupScope) => canonical(a) === canonical(b);
function pins(r: Record<string, unknown>): LifecyclePins {
  if (r.action !== "Approve" && r.action !== "Publish") return fail();
  const operationReference = ref(r.operationReference),
    expectedReviewOperationReference = ref(r.expectedReviewOperationReference),
    expectedReviewVersion = positive(r.expectedReviewVersion, 2);
  if (
    operationReference === expectedReviewOperationReference ||
    expectedReviewVersion === 2147483647
  )
    return fail();
  return {
    action: r.action,
    operationReference,
    templateReference: ref(r.templateReference),
    expectedVersionReference: ref(r.expectedVersionReference),
    expectedRevision: positive(r.expectedRevision),
    reviewLifecycleReference: ref(r.reviewLifecycleReference),
    expectedReviewVersion,
    expectedReviewOperationReference,
  };
}
function bodyPins(c: LifecyclePins) {
  const { action: _action, ...remaining } = pins({ ...c });
  void _action;
  return remaining;
}
function original(value: unknown): ReceiptTemplateLifecycleOriginal {
  return safe(() => {
    const r = record(value, ["profile", ...scopeKeys, ...pinKeys, "purposeCode"]);
    if (
      r.profile !== "DigitalReceiptTemplateLifecycleActionV1" ||
      r.purposeCode !== "RECEIPT_TEMPLATE_REVIEW"
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateLifecycleActionV1",
      ...scopeFrom(r),
      ...pins(r),
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    });
  });
}
export function parseReceiptTemplateLifecycleCursor(
  value: unknown,
): ReceiptTemplateLifecycleCursor {
  return safe(() => {
    const r = record(value, ["profile", "scope", ...pinKeys, "intentDigest"]);
    if (r.profile !== "ReceiptTemplateLifecyclePendingOriginalV1") return fail();
    return Object.freeze({
      profile: "ReceiptTemplateLifecyclePendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
export function parseReceiptTemplatePublishedVersion(
  value: unknown,
): ReceiptTemplatePublishedVersion {
  const r = record(value, [
    "templateReference",
    "versionReference",
    "versionNumber",
    "versionCode",
    "brandReference",
    "storeReference",
    "locale",
    "dataContractVersion",
    "renderEngineVersion",
    "outputProfile",
    "layoutDefinitionReference",
    "complianceRuleReference",
    "requiredFields",
    "publicationReference",
    "publishedAt",
    "effectiveFrom",
    "effectiveUntil",
  ]);
  const fields = r.requiredFields;
  if (
    !Array.isArray(fields) ||
    Object.getPrototypeOf(fields) !== Array.prototype ||
    fields.length !== receiptTemplateArtifactRequiredFields.length ||
    Reflect.ownKeys(fields).length !== fields.length + 1
  )
    return fail();
  const requiredFields = Array.from({ length: fields.length }, (_v, i) => {
    const d = Object.getOwnPropertyDescriptor(fields, String(i));
    if (
      !d?.enumerable ||
      !("value" in d) ||
      !receiptTemplateArtifactRequiredFields.includes(d.value)
    )
      return fail();
    return d.value as (typeof receiptTemplateArtifactRequiredFields)[number];
  });
  if (
    new Set(requiredFields).size !== receiptTemplateArtifactRequiredFields.length ||
    typeof r.versionNumber !== "number" ||
    !Number.isSafeInteger(r.versionNumber) ||
    r.versionNumber < 1 ||
    typeof r.versionCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(r.versionCode) ||
    typeof r.locale !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(r.locale) ||
    r.dataContractVersion !== 1 ||
    r.renderEngineVersion !== 1 ||
    r.outputProfile !== "AccessibleDigitalReceipt"
  )
    return fail();
  const publishedAt = instant(r.publishedAt),
    effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
  if (publishedAt > effectiveFrom || (effectiveUntil !== null && effectiveUntil <= effectiveFrom))
    return fail();
  return Object.freeze({
    templateReference: ref(r.templateReference),
    versionReference: ref(r.versionReference),
    versionNumber: r.versionNumber,
    versionCode: r.versionCode,
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
    locale: r.locale,
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: ref(r.layoutDefinitionReference),
    complianceRuleReference: ref(r.complianceRuleReference),
    requiredFields: Object.freeze(requiredFields),
    publicationReference: ref(r.publicationReference),
    publishedAt,
    effectiveFrom,
    effectiveUntil,
  });
}
export async function validateReceiptTemplateLifecycleReceipt(
  value: unknown,
  input: ReceiptTemplateLifecycleCursor,
): Promise<ReceiptTemplateLifecycleReceipt> {
  const c = parseReceiptTemplateLifecycleCursor(input);
  if (
    (await publicationValueDigest(
      original({
        profile: "DigitalReceiptTemplateLifecycleActionV1",
        ...c.scope,
        ...pins({ ...c }),
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      }),
    )) !== c.intentDigest
  )
    return fail();
  return safe(() => {
    const r = record(value, [
        "profile",
        ...scopeKeys,
        ...pinKeys,
        "intentDigest",
        "outcome",
        "result",
        "auditReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r);
    if (!sameScope(scope, c.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateLifecycleReceiptV1" ||
      canonical(pins(r)) !== canonical(pins({ ...c })) ||
      r.intentDigest !== c.intentDigest ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const occurredAt = instant(r.occurredAt);
    let result: ReceiptTemplateLifecycleResult | null = null;
    if (r.outcome === "Abandoned") {
      if (r.result !== null) return fail();
    } else {
      const p = record(r.result, [
        "lifecycleReference",
        "lifecycleVersion",
        "state",
        "mutationOperationReference",
        "changedAt",
        "approvalEvidenceReference",
        "approvedByReference",
        "approvedAt",
        "approvalValidUntil",
        "publishedVersion",
      ]);
      if (p.state !== "Approved" && p.state !== "Published") return fail();
      result = Object.freeze({
        lifecycleReference: ref(p.lifecycleReference),
        lifecycleVersion: positive(p.lifecycleVersion),
        state: p.state,
        mutationOperationReference: ref(p.mutationOperationReference),
        changedAt: instant(p.changedAt),
        approvalEvidenceReference: ref(p.approvalEvidenceReference),
        approvedByReference: ref(p.approvedByReference),
        approvedAt: instant(p.approvedAt),
        approvalValidUntil: instant(p.approvalValidUntil),
        publishedVersion:
          p.publishedVersion === null
            ? null
            : parseReceiptTemplatePublishedVersion(p.publishedVersion),
      });
      if (
        result.lifecycleReference !== c.reviewLifecycleReference ||
        result.lifecycleVersion !== c.expectedReviewVersion + 1 ||
        result.mutationOperationReference !== c.operationReference ||
        result.changedAt !== occurredAt ||
        result.approvedAt > result.changedAt ||
        result.changedAt >= result.approvalValidUntil
      )
        return fail();
      if (c.action === "Approve") {
        if (
          result.state !== "Approved" ||
          result.publishedVersion !== null ||
          result.approvedByReference !== scope.actorReference ||
          result.approvedAt !== occurredAt
        )
          return fail();
      } else {
        const version = result.publishedVersion;
        if (
          result.state !== "Published" ||
          version === null ||
          version.brandReference !== scope.brandReference ||
          version.storeReference !== scope.storeReference ||
          version.templateReference !== c.templateReference ||
          version.versionReference !== c.expectedVersionReference ||
          version.publishedAt !== occurredAt
        )
          return fail();
      }
    }
    return Object.freeze({
      profile: "DigitalReceiptTemplateLifecycleReceiptV1",
      ...scope,
      ...pins(r),
      intentDigest: c.intentDigest,
      outcome: r.outcome,
      result,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
}
interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}

export function createReceiptTemplateLifecycleClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
    subject?: string | null,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    const current = canonical({
      store,
      subject: subject ?? null,
      scope: scope ?? null,
      csrf: options.csrf,
    });
    if (current !== key) {
      key = current;
      epoch++;
    }
    const captured = epoch;
    if (
      body !== undefined &&
      (typeof options.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(options.csrf))
    )
      return fail();
    if (options.signal?.aborted) return fail("Unavailable");
    const controller = new AbortController(),
      abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false;
    try {
      const encoded = body === undefined ? undefined : canonical(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).length > 16384) return fail();
      sent = true;
      const response = await fetcher("/merchant/store-setup/receipt-template-lifecycle", {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.csrf ? { "X-BOP-CSRF": options.csrf } : {}),
          ...(scope
            ? {
                "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                  .replace(/\+/gu, "-")
                  .replace(/\//gu, "_")
                  .replace(/=+$/u, ""),
              }
            : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
      if (captured !== epoch || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (response.status === 403) return fail("Denied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 400) return fail("Invalid");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(body ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      let bytes = 0,
        text = "";
      try {
        if (controller.signal.aborted) cancel();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32768) return fail(body ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (controller.signal.aborted) return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (captured !== epoch || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof StoreSetupClientError) throw error;
      return fail(body && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  const active = (
    e: number,
    options: RequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
    mutated = false,
  ) => {
    if (e !== epoch || options.csrf !== csrf || options.signal !== signal)
      return fail("ScopeChanged");
    if (signal?.aborted) return fail(mutated ? "OutcomeUnknown" : "Unavailable");
  };
  const checkDigest = async (c: ReceiptTemplateLifecycleCursor) => {
    if (
      (await publicationValueDigest(
        original({
          profile: "DigitalReceiptTemplateLifecycleActionV1",
          ...c.scope,
          ...pins({ ...c }),
          purposeCode: "RECEIPT_TEMPLATE_REVIEW",
        }),
      )) !== c.intentDigest
    )
      return fail();
  };
  const terminal = async (
    raw: unknown,
    c: ReceiptTemplateLifecycleCursor,
    e: number,
    options: RequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
  ) => {
    try {
      active(e, options, csrf, signal, true);
      const receipt = await validateReceiptTemplateLifecycleReceipt(raw, c);
      active(e, options, csrf, signal, true);
      return receipt;
    } catch (error) {
      if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
      return fail("OutcomeUnknown");
    }
  };
  return Object.freeze({
    async prepare(input: {
      expectedScope: StoreSetupScope;
      action: "Approve" | "Publish";
      reviewLifecycleReference: string;
      expectedReviewVersion: number;
      expectedReviewOperationReference: string;
      operationReference: string;
      templateReference: string;
      expectedVersionReference: string;
      expectedRevision: number;
    }): Promise<PreparedReceiptTemplateLifecycle> {
      const r = safe(() =>
          record(input, [
            "expectedScope",
            "action",
            "reviewLifecycleReference",
            "expectedReviewVersion",
            "expectedReviewOperationReference",
            "operationReference",
            "templateReference",
            "expectedVersionReference",
            "expectedRevision",
          ]),
        ),
        scope = parseStoreSetupScope(r.expectedScope),
        command = safe(() =>
          original({
            profile: "DigitalReceiptTemplateLifecycleActionV1",
            ...scope,
            ...pins(r),
            purposeCode: "RECEIPT_TEMPLATE_REVIEW",
          }),
        );
      const intentDigest = await publicationValueDigest(command),
        cursor = parseReceiptTemplateLifecycleCursor({
          profile: "ReceiptTemplateLifecyclePendingOriginalV1",
          scope,
          ...pins({ ...command }),
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(
      input: PreparedReceiptTemplateLifecycle,
      options: RequestOptions & { csrf: string },
    ) {
      const csrf = options.csrf,
        signal = options.signal,
        e = epoch;
      active(e, options, csrf, signal);
      const r = safe(() => record(input, ["command", "cursor", "intentDigest"])),
        command = original(r.command),
        cursor = parseReceiptTemplateLifecycleCursor(r.cursor);
      if (
        !sameScope(scopeFrom({ ...command }), cursor.scope) ||
        canonical(pins({ ...command })) !== canonical(pins({ ...cursor })) ||
        r.intentDigest !== cursor.intentDigest
      )
        return fail();
      await checkDigest(cursor);
      active(e, options, csrf, signal);
      const raw = await request(
        cursor.scope.storeReference,
        cursor.scope,
        options,
        { command: cursor.action, ...bodyPins(cursor) },
        cursor.templateReference,
      );
      return terminal(raw, cursor, epoch, options, csrf, signal);
    },
    async resolve(
      input: ReceiptTemplateLifecycleCursor,
      options: RequestOptions & { csrf: string },
    ) {
      const csrf = options.csrf,
        signal = options.signal,
        e = epoch,
        cursor = parseReceiptTemplateLifecycleCursor(input);
      active(e, options, csrf, signal);
      await checkDigest(cursor);
      active(e, options, csrf, signal);
      const raw = await request(
        cursor.scope.storeReference,
        cursor.scope,
        options,
        { command: "ResolveOriginal", ...pins({ ...cursor }), intentDigest: cursor.intentDigest },
        cursor.templateReference,
      );
      return terminal(raw, cursor, epoch, options, csrf, signal);
    },
  });
}
