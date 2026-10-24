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
export { StoreSetupClientError as ReceiptTemplateArtifactClientError };
export type ReceiptTemplateArtifactKind = "Layout" | "Compliance";
export const receiptTemplateArtifactRequiredFields = Object.freeze([
  "Issuer",
  "Store",
  "OrderNumber",
  "IssuedAt",
  "Items",
  "Subtotal",
  "Discount",
  "Fee",
  "Tax",
  "Tip",
  "Total",
  "PaymentStatus",
  "RefundedTotal",
] as const);
export type ReceiptTemplateArtifactContent =
  | Readonly<{
      profile: "AccessibleDigitalReceiptLayoutV1";
      dataContractVersion: 1;
      renderEngineVersion: 1;
      outputProfile: "AccessibleDigitalReceipt";
      requiredFields: readonly (typeof receiptTemplateArtifactRequiredFields)[number][];
    }>
  | Readonly<{
      profile: "DigitalReceiptRequiredFieldRuleV1";
      dataContractVersion: 1;
      requiredFields: readonly (typeof receiptTemplateArtifactRequiredFields)[number][];
      professionalReviewStatus: "NotEvaluated";
      legalConclusion: "NotEvaluated";
    }>;
export interface ReceiptTemplateArtifactSnapshot {
  readonly profile: "DigitalReceiptTemplateArtifactV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly artifactKind: ReceiptTemplateArtifactKind;
  readonly artifactReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousArtifactReference: string | null;
  readonly content: ReceiptTemplateArtifactContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
export interface ReceiptTemplateArtifactsCurrent extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateArtifactsCurrentV1";
  readonly layout: ReceiptTemplateArtifactSnapshot | null;
  readonly compliance: ReceiptTemplateArtifactSnapshot | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export interface ReceiptTemplateArtifactCursor {
  readonly profile: "ReceiptTemplateArtifactPendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly artifactKind: ReceiptTemplateArtifactKind;
  readonly operationReference: string;
  readonly expectedArtifactReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface ReceiptTemplateArtifactOriginal extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateArtifactSaveV1";
  readonly artifactKind: ReceiptTemplateArtifactKind;
  readonly operationReference: string;
  readonly expectedArtifactReference: string | null;
  readonly expectedRevision: number;
  readonly content: ReceiptTemplateArtifactContent;
  readonly purposeCode: "RECEIPT_TEMPLATE_ARTIFACT";
}
export interface PreparedReceiptTemplateArtifact {
  readonly command: ReceiptTemplateArtifactOriginal;
  readonly intentDigest: string;
  readonly cursor: ReceiptTemplateArtifactCursor;
}
export interface ReceiptTemplateArtifactReceipt extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateArtifactReceiptV1";
  readonly artifactKind: ReceiptTemplateArtifactKind;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly expectedArtifactReference: string | null;
  readonly expectedRevision: number;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: ReceiptTemplateArtifactSnapshot | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
}
const kind = (v: unknown): ReceiptTemplateArtifactKind =>
  v === "Layout" || v === "Compliance" ? v : fail();
const int = (v: unknown, min = 0): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= 2147483647 ? v : fail();
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const nullable = (v: unknown): string | null => (v === null ? null : ref(v));
const sameScope = (a: StoreSetupScope, b: StoreSetupScope) => canonical(a) === canonical(b);
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
function pins(r: Record<string, unknown>) {
  const expectedRevision = int(r.expectedRevision),
    expectedArtifactReference = nullable(r.expectedArtifactReference);
  if ((expectedArtifactReference === null) !== (expectedRevision === 0)) return fail();
  return { expectedRevision, expectedArtifactReference };
}
export function parseReceiptTemplateArtifactContent(
  k: ReceiptTemplateArtifactKind,
  v: unknown,
): ReceiptTemplateArtifactContent {
  return safe(() => {
    const selected = kind(k),
      r = record(
        v,
        selected === "Layout"
          ? [
              "profile",
              "dataContractVersion",
              "renderEngineVersion",
              "outputProfile",
              "requiredFields",
            ]
          : [
              "profile",
              "dataContractVersion",
              "requiredFields",
              "professionalReviewStatus",
              "legalConclusion",
            ],
      );
    if (
      r.dataContractVersion !== 1 ||
      !Array.isArray(r.requiredFields) ||
      Object.getPrototypeOf(r.requiredFields) !== Array.prototype ||
      r.requiredFields.length !== receiptTemplateArtifactRequiredFields.length ||
      Reflect.ownKeys(r.requiredFields).length !== r.requiredFields.length + 1
    )
      return fail();
    for (let i = 0; i < receiptTemplateArtifactRequiredFields.length; i++) {
      const d = Object.getOwnPropertyDescriptor(r.requiredFields, String(i));
      if (!d?.enumerable || !("value" in d) || d.value !== receiptTemplateArtifactRequiredFields[i])
        return fail();
    }
    const requiredFields = Object.freeze([...receiptTemplateArtifactRequiredFields]);
    if (selected === "Layout") {
      if (
        r.profile !== "AccessibleDigitalReceiptLayoutV1" ||
        r.renderEngineVersion !== 1 ||
        r.outputProfile !== "AccessibleDigitalReceipt"
      )
        return fail();
      return Object.freeze({
        profile: "AccessibleDigitalReceiptLayoutV1",
        dataContractVersion: 1,
        renderEngineVersion: 1,
        outputProfile: "AccessibleDigitalReceipt",
        requiredFields,
      });
    }
    if (
      r.profile !== "DigitalReceiptRequiredFieldRuleV1" ||
      r.professionalReviewStatus !== "NotEvaluated" ||
      r.legalConclusion !== "NotEvaluated"
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptRequiredFieldRuleV1",
      dataContractVersion: 1,
      requiredFields,
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    });
  });
}
export function parseReceiptTemplateArtifactSnapshot(v: unknown): ReceiptTemplateArtifactSnapshot {
  return safe(() => {
    const r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "artifactKind",
        "artifactReference",
        "revision",
        "authoredByReference",
        "previousArtifactReference",
        "content",
        "createdAt",
        "updatedAt",
        "dataClassification",
      ]),
      k = kind(r.artifactKind),
      revision = int(r.revision, 1),
      artifactReference = ref(r.artifactReference),
      previousArtifactReference = nullable(r.previousArtifactReference),
      createdAt = instant(r.createdAt),
      updatedAt = instant(r.updatedAt);
    if (
      r.profile !== "DigitalReceiptTemplateArtifactV1" ||
      r.dataClassification !== "Internal" ||
      (revision === 1) !== (previousArtifactReference === null) ||
      artifactReference === previousArtifactReference ||
      updatedAt < createdAt ||
      (revision === 1 && updatedAt !== createdAt)
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactV1",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      artifactKind: k,
      artifactReference,
      revision,
      authoredByReference: ref(r.authoredByReference),
      previousArtifactReference,
      content: parseReceiptTemplateArtifactContent(k, r.content),
      createdAt,
      updatedAt,
      dataClassification: "Internal",
    });
  });
}
export function parseReceiptTemplateArtifactsCurrent(
  v: unknown,
  expectedStore: string,
  expectedScope?: StoreSetupScope,
): ReceiptTemplateArtifactsCurrent {
  return safe(() => {
    const r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "layout",
        "compliance",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      scope = scopeFrom(r),
      observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil);
    if (
      scope.storeReference !== ref(expectedStore) ||
      (expectedScope && !sameScope(scope, parseStoreSetupScope(expectedScope)))
    )
      return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateArtifactsCurrentV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const layout = r.layout === null ? null : parseReceiptTemplateArtifactSnapshot(r.layout),
      compliance =
        r.compliance === null ? null : parseReceiptTemplateArtifactSnapshot(r.compliance);
    for (const [s, k] of [
      [layout, "Layout"],
      [compliance, "Compliance"],
    ] as const)
      if (
        s &&
        (s.artifactKind !== k ||
          s.tenantReference !== scope.tenantReference ||
          s.brandReference !== scope.brandReference ||
          s.storeReference !== scope.storeReference ||
          s.updatedAt > observedAt)
      )
        return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactsCurrentV1",
      ...scope,
      layout,
      compliance,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}
export function parseReceiptTemplateArtifactCursor(v: unknown): ReceiptTemplateArtifactCursor {
  return safe(() => {
    const r = record(v, [
      "profile",
      "scope",
      "artifactKind",
      "operationReference",
      "expectedArtifactReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "ReceiptTemplateArtifactPendingOriginalV1") return fail();
    return Object.freeze({
      profile: "ReceiptTemplateArtifactPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      artifactKind: kind(r.artifactKind),
      operationReference: ref(r.operationReference),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
function original(v: unknown): ReceiptTemplateArtifactOriginal {
  const r = record(v, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "artifactKind",
      "operationReference",
      "expectedArtifactReference",
      "expectedRevision",
      "content",
      "purposeCode",
    ]),
    k = kind(r.artifactKind),
    p = pins(r);
  if (
    r.profile !== "DigitalReceiptTemplateArtifactSaveV1" ||
    r.purposeCode !== "RECEIPT_TEMPLATE_ARTIFACT" ||
    p.expectedRevision === 2147483647
  )
    return fail();
  return Object.freeze({
    profile: "DigitalReceiptTemplateArtifactSaveV1",
    ...scopeFrom(r),
    artifactKind: k,
    operationReference: ref(r.operationReference),
    ...p,
    content: parseReceiptTemplateArtifactContent(k, r.content),
    purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
  });
}
export async function validateReceiptTemplateArtifactReceipt(
  v: unknown,
  input: ReceiptTemplateArtifactCursor,
): Promise<ReceiptTemplateArtifactReceipt> {
  const receipt = safe(() => {
    const c = parseReceiptTemplateArtifactCursor(input),
      r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "artifactKind",
        "operationReference",
        "intentDigest",
        "expectedArtifactReference",
        "expectedRevision",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r);
    if (!sameScope(scope, c.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateArtifactReceiptV1" ||
      r.artifactKind !== c.artifactKind ||
      r.operationReference !== c.operationReference ||
      r.intentDigest !== c.intentDigest ||
      r.expectedArtifactReference !== c.expectedArtifactReference ||
      r.expectedRevision !== c.expectedRevision ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const snapshot = r.snapshot === null ? null : parseReceiptTemplateArtifactSnapshot(r.snapshot),
      occurredAt = instant(r.occurredAt);
    if ((r.outcome === "Abandoned") !== (snapshot === null)) return fail();
    if (
      snapshot &&
      (snapshot.artifactKind !== c.artifactKind ||
        snapshot.tenantReference !== scope.tenantReference ||
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.authoredByReference !== scope.actorReference ||
        snapshot.previousArtifactReference !== c.expectedArtifactReference ||
        snapshot.artifactReference === c.expectedArtifactReference ||
        snapshot.revision !== c.expectedRevision + 1 ||
        snapshot.updatedAt !== occurredAt)
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactReceiptV1",
      ...scope,
      artifactKind: c.artifactKind,
      operationReference: c.operationReference,
      intentDigest: c.intentDigest,
      expectedArtifactReference: c.expectedArtifactReference,
      expectedRevision: c.expectedRevision,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
  if (receipt.snapshot) {
    const command = {
      profile: "DigitalReceiptTemplateArtifactSaveV1",
      tenantReference: receipt.tenantReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      actorReference: receipt.actorReference,
      artifactKind: receipt.artifactKind,
      operationReference: receipt.operationReference,
      expectedArtifactReference: receipt.expectedArtifactReference,
      expectedRevision: receipt.expectedRevision,
      content: receipt.snapshot.content,
      purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
    };
    if ((await publicationValueDigest(command)) !== receipt.intentDigest) return fail();
  }
  return receipt;
}
interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}

export function createReceiptTemplateArtifactClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
    selectedKind?: ReceiptTemplateArtifactKind,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    const current = canonical({ store, scope: scope ?? null, csrf: options.csrf });
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
      const response = await fetcher(
        `/merchant/store-setup/receipt-artifacts${body === undefined ? `?storeReference=${ref(store)}` : `/${selectedKind === "Layout" ? "layout" : "compliance"}`}`,
        {
          method: body === undefined ? "GET" : "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(options.csrf ? { "X-BOP-CSRF": options.csrf } : {}),
            ...(body !== undefined && scope
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
        },
      );
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
          if (bytes > 65536) return fail(body ? "OutcomeUnknown" : "Unavailable");
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
  return Object.freeze({
    async load(
      input: RequestOptions & { storeReference: string; expectedScope?: StoreSetupScope },
    ) {
      const store = safe(() => ref(input.storeReference)),
        scope = input.expectedScope ? parseStoreSetupScope(input.expectedScope) : undefined;
      const current = parseReceiptTemplateArtifactsCurrent(
        await request(store, scope, input),
        store,
        scope,
      );
      if (
        Date.now() < Date.parse(current.observedAt) ||
        Date.now() >= Date.parse(current.validUntil)
      )
        return fail("Stale");
      return current;
    },
    async prepare(input: {
      expectedScope: StoreSetupScope;
      artifactKind: ReceiptTemplateArtifactKind;
      operationReference: string;
      expectedArtifactReference: string | null;
      expectedRevision: number;
      content: unknown;
    }): Promise<PreparedReceiptTemplateArtifact> {
      const r = safe(() =>
          record(input, [
            "expectedScope",
            "artifactKind",
            "operationReference",
            "expectedArtifactReference",
            "expectedRevision",
            "content",
          ]),
        ),
        scope = parseStoreSetupScope(r.expectedScope),
        command = safe(() =>
          original({
            profile: "DigitalReceiptTemplateArtifactSaveV1",
            ...scope,
            artifactKind: r.artifactKind,
            operationReference: r.operationReference,
            expectedArtifactReference: r.expectedArtifactReference,
            expectedRevision: r.expectedRevision,
            content: r.content,
            purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
          }),
        ),
        intentDigest = await publicationValueDigest(command),
        cursor = parseReceiptTemplateArtifactCursor({
          profile: "ReceiptTemplateArtifactPendingOriginalV1",
          scope,
          artifactKind: command.artifactKind,
          operationReference: command.operationReference,
          expectedArtifactReference: command.expectedArtifactReference,
          expectedRevision: command.expectedRevision,
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(
      input: PreparedReceiptTemplateArtifact,
      options: RequestOptions & { csrf: string },
    ) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const r = safe(() => record(input, ["command", "cursor", "intentDigest"])),
        command = safe(() => original(r.command)),
        cursor = parseReceiptTemplateArtifactCursor(r.cursor);
      if (
        !sameScope(scopeFrom({ ...command }), cursor.scope) ||
        command.artifactKind !== cursor.artifactKind ||
        command.operationReference !== cursor.operationReference ||
        command.expectedArtifactReference !== cursor.expectedArtifactReference ||
        command.expectedRevision !== cursor.expectedRevision ||
        r.intentDigest !== cursor.intentDigest ||
        (await publicationValueDigest(command)) !== cursor.intentDigest
      )
        return fail();
      if (options.csrf !== attemptCsrf || options.signal !== attemptSignal)
        return fail("ScopeChanged");
      const raw = await request(
          cursor.scope.storeReference,
          cursor.scope,
          { csrf: attemptCsrf, ...(attemptSignal ? { signal: attemptSignal } : {}) },
          {
            command: "SaveArtifact",
            operationReference: cursor.operationReference,
            expectedArtifactReference: cursor.expectedArtifactReference,
            expectedRevision: cursor.expectedRevision,
            content: command.content,
          },
          cursor.artifactKind,
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateReceiptTemplateArtifactReceipt(raw, cursor);
        if (
          epoch !== receivedEpoch ||
          options.csrf !== attemptCsrf ||
          options.signal !== attemptSignal
        )
          return fail("ScopeChanged");
        if (attemptSignal?.aborted) return fail("OutcomeUnknown");
        return result;
      } catch (error) {
        if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
        return fail("OutcomeUnknown");
      }
    },
    async resolve(
      input: ReceiptTemplateArtifactCursor,
      options: RequestOptions & { csrf: string },
    ) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const cursor = parseReceiptTemplateArtifactCursor(input),
        raw = await request(
          cursor.scope.storeReference,
          cursor.scope,
          { csrf: attemptCsrf, ...(attemptSignal ? { signal: attemptSignal } : {}) },
          {
            command: "ResolveOriginal",
            operationReference: cursor.operationReference,
            expectedArtifactReference: cursor.expectedArtifactReference,
            expectedRevision: cursor.expectedRevision,
            intentDigest: cursor.intentDigest,
          },
          cursor.artifactKind,
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateReceiptTemplateArtifactReceipt(raw, cursor);
        if (
          epoch !== receivedEpoch ||
          options.csrf !== attemptCsrf ||
          options.signal !== attemptSignal
        )
          return fail("ScopeChanged");
        if (attemptSignal?.aborted) return fail("OutcomeUnknown");
        return result;
      } catch (error) {
        if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
        return fail("OutcomeUnknown");
      }
    },
  });
}
