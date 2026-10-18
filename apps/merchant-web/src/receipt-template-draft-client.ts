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
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
export { StoreSetupClientError as ReceiptTemplateDraftClientError };
export interface ReceiptTemplateDraftFields {
  readonly locale: string;
  readonly layoutDefinitionReference: string;
  readonly complianceRuleReference: string;
  readonly activation:
    Readonly<{ mode: "Immediate" }> | Readonly<{ mode: "Scheduled"; effectiveFrom: string }>;
  readonly effectiveUntil: string | null;
}
export interface ReceiptTemplateDraftContent extends ReceiptTemplateDraftFields {
  readonly profile: "DigitalReceiptTemplateContentV2";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly templateReference: string;
  readonly versionReference: string;
  readonly versionNumber: number;
  readonly versionCode: string;
  readonly dataContractVersion: 1;
  readonly renderEngineVersion: 1;
  readonly outputProfile: "AccessibleDigitalReceipt";
  readonly requiredFields: readonly string[];
  readonly dataClassification: "Internal";
}
export interface ReceiptTemplateDraftSnapshot {
  readonly profile: "DigitalReceiptTemplateDraftV2";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly familyReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousVersionReference: string | null;
  readonly content: ReceiptTemplateDraftContent;
  readonly contentDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
export interface ReceiptTemplateDraftCurrent extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateDraftCurrentV1";
  readonly templateReference: string | null;
  readonly snapshot: ReceiptTemplateDraftSnapshot | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export interface ReceiptTemplateDraftCursor {
  readonly profile: "ReceiptTemplateDraftPendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly templateReference: string | null;
  readonly operationReference: string;
  readonly expectedVersionReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface ReceiptTemplateDraftOriginal extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateDraftSaveV1";
  readonly operationReference: string;
  readonly templateReference: string | null;
  readonly expectedVersionReference: string | null;
  readonly expectedRevision: number;
  readonly fields: ReceiptTemplateDraftFields;
  readonly purposeCode: "RECEIPT_TEMPLATE_AUTHORING";
}
export interface PreparedReceiptTemplateDraft {
  readonly command: ReceiptTemplateDraftOriginal;
  readonly intentDigest: string;
  readonly cursor: ReceiptTemplateDraftCursor;
}
export interface ReceiptTemplateDraftReceipt extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateDraftReceiptV1";
  readonly operationReference: string;
  readonly templateReference: string | null;
  readonly expectedVersionReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: ReceiptTemplateDraftSnapshot | null;
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
const int = (v: unknown, min = 0, max = 2147483647): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const nullable = (v: unknown) => (v === null ? null : ref(v));
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const sameScope = (a: StoreSetupScope, b: StoreSetupScope) => canonical(a) === canonical(b);
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
const scopeKeys = ["tenantReference", "brandReference", "storeReference"];
function pins(r: Record<string, unknown>) {
  const templateReference = nullable(r.templateReference),
    expectedVersionReference = nullable(r.expectedVersionReference),
    expectedRevision = int(r.expectedRevision);
  if (
    expectedRevision === 0
      ? templateReference !== null || expectedVersionReference !== null
      : templateReference === null || expectedVersionReference === null
  )
    return fail();
  return { templateReference, expectedVersionReference, expectedRevision };
}
export function parseReceiptTemplateDraftFields(v: unknown): ReceiptTemplateDraftFields {
  return safe(() => {
    const r = record(v, [
      "locale",
      "layoutDefinitionReference",
      "complianceRuleReference",
      "activation",
      "effectiveUntil",
    ]);
    if (typeof r.locale !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(r.locale))
      return fail();
    const mode =
      r.activation && typeof r.activation === "object"
        ? Object.getOwnPropertyDescriptor(r.activation, "mode")
        : undefined;
    if (!mode?.enumerable || !("value" in mode)) return fail();
    let activation: ReceiptTemplateDraftFields["activation"];
    if (mode.value === "Immediate") {
      record(r.activation, ["mode"]);
      activation = Object.freeze({ mode: "Immediate" });
    } else if (mode.value === "Scheduled") {
      const a = record(r.activation, ["mode", "effectiveFrom"]);
      activation = Object.freeze({ mode: "Scheduled", effectiveFrom: instant(a.effectiveFrom) });
    } else return fail();
    const effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
    if (
      activation.mode === "Scheduled" &&
      effectiveUntil !== null &&
      effectiveUntil <= activation.effectiveFrom
    )
      return fail();
    return Object.freeze({
      locale: r.locale,
      layoutDefinitionReference: ref(r.layoutDefinitionReference),
      complianceRuleReference: ref(r.complianceRuleReference),
      activation,
      effectiveUntil,
    });
  });
}
export function parseReceiptTemplateDraftContent(v: unknown): ReceiptTemplateDraftContent {
  return safe(() => {
    const r = record(v, [
        "profile",
        ...scopeKeys,
        "templateReference",
        "versionReference",
        "versionNumber",
        "versionCode",
        "locale",
        "dataContractVersion",
        "renderEngineVersion",
        "outputProfile",
        "layoutDefinitionReference",
        "complianceRuleReference",
        "requiredFields",
        "activation",
        "effectiveUntil",
        "dataClassification",
      ]),
      fields = parseReceiptTemplateDraftFields({
        locale: r.locale,
        layoutDefinitionReference: r.layoutDefinitionReference,
        complianceRuleReference: r.complianceRuleReference,
        activation: r.activation,
        effectiveUntil: r.effectiveUntil,
      }),
      versionNumber = int(r.versionNumber, 1, Number.MAX_SAFE_INTEGER);
    if (
      r.profile !== "DigitalReceiptTemplateContentV2" ||
      r.versionCode !== `RECEIPT_${versionNumber}` ||
      r.dataContractVersion !== 1 ||
      r.renderEngineVersion !== 1 ||
      r.outputProfile !== "AccessibleDigitalReceipt" ||
      r.dataClassification !== "Internal" ||
      !Array.isArray(r.requiredFields) ||
      Object.getPrototypeOf(r.requiredFields) !== Array.prototype ||
      r.requiredFields.length !== 13 ||
      Reflect.ownKeys(r.requiredFields).length !== 14
    )
      return fail();
    for (let i = 0; i < 13; i++) {
      const d = Object.getOwnPropertyDescriptor(r.requiredFields, String(i));
      if (!d?.enumerable || !("value" in d) || d.value !== receiptTemplateArtifactRequiredFields[i])
        return fail();
    }
    return Object.freeze({
      profile: "DigitalReceiptTemplateContentV2",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      templateReference: ref(r.templateReference),
      versionReference: ref(r.versionReference),
      versionNumber,
      versionCode: `RECEIPT_${versionNumber}`,
      ...fields,
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      requiredFields: Object.freeze([...receiptTemplateArtifactRequiredFields]),
      dataClassification: "Internal",
    });
  });
}
export function parseReceiptTemplateDraftSnapshot(v: unknown): ReceiptTemplateDraftSnapshot {
  return safe(() => {
    const r = record(v, [
        "profile",
        ...scopeKeys,
        "familyReference",
        "revision",
        "authoredByReference",
        "previousVersionReference",
        "content",
        "contentDigest",
        "createdAt",
        "updatedAt",
        "dataClassification",
      ]),
      content = parseReceiptTemplateDraftContent(r.content),
      revision = int(r.revision, 1),
      previousVersionReference = nullable(r.previousVersionReference),
      createdAt = instant(r.createdAt),
      updatedAt = instant(r.updatedAt);
    if (
      r.profile !== "DigitalReceiptTemplateDraftV2" ||
      r.dataClassification !== "Internal" ||
      (revision === 1) !== (previousVersionReference === null) ||
      previousVersionReference === content.versionReference ||
      updatedAt < createdAt ||
      (revision === 1 && updatedAt !== createdAt) ||
      scopeKeys.some((k) => Object.getOwnPropertyDescriptor(content, k)?.value !== r[k])
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftV2",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      familyReference: ref(r.familyReference),
      revision,
      authoredByReference: ref(r.authoredByReference),
      previousVersionReference,
      content,
      contentDigest: hash(r.contentDigest),
      createdAt,
      updatedAt,
      dataClassification: "Internal",
    });
  });
}
export async function validateReceiptTemplateDraftContentDigest(
  snapshot: ReceiptTemplateDraftSnapshot | null,
) {
  if (snapshot && (await publicationValueDigest(snapshot.content)) !== snapshot.contentDigest)
    return fail();
}
export function parseReceiptTemplateDraftCurrent(
  v: unknown,
  store: string,
  template: string | null,
  expectedScope?: StoreSetupScope,
): ReceiptTemplateDraftCurrent {
  return safe(() => {
    const r = record(v, [
        "profile",
        ...scopeKeys,
        "actorReference",
        "templateReference",
        "snapshot",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      scope = scopeFrom(r),
      subject = nullable(r.templateReference),
      snapshot = r.snapshot === null ? null : parseReceiptTemplateDraftSnapshot(r.snapshot),
      observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil);
    if (
      scope.storeReference !== ref(store) ||
      (expectedScope && !sameScope(scope, parseStoreSetupScope(expectedScope)))
    )
      return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateDraftCurrentV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      subject !== (template === null ? null : ref(template)) ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    if (
      snapshot &&
      (snapshot.content.templateReference !== subject ||
        snapshot.updatedAt > observedAt ||
        scopeKeys.some(
          (k) =>
            Object.getOwnPropertyDescriptor(snapshot, k)?.value !==
            Object.getOwnPropertyDescriptor(scope, k)?.value,
        ))
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftCurrentV1",
      ...scope,
      templateReference: subject,
      snapshot,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}
export function parseReceiptTemplateDraftCursor(v: unknown): ReceiptTemplateDraftCursor {
  return safe(() => {
    const r = record(v, [
      "profile",
      "scope",
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "ReceiptTemplateDraftPendingOriginalV1") return fail();
    return Object.freeze({
      profile: "ReceiptTemplateDraftPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      operationReference: ref(r.operationReference),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
function original(v: unknown): ReceiptTemplateDraftOriginal {
  const r = record(v, [
      "profile",
      ...scopeKeys,
      "actorReference",
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
      "fields",
      "purposeCode",
    ]),
    p = pins(r);
  if (
    r.profile !== "DigitalReceiptTemplateDraftSaveV1" ||
    r.purposeCode !== "RECEIPT_TEMPLATE_AUTHORING" ||
    p.expectedRevision === 2147483647
  )
    return fail();
  return Object.freeze({
    profile: "DigitalReceiptTemplateDraftSaveV1",
    ...scopeFrom(r),
    operationReference: ref(r.operationReference),
    ...p,
    fields: parseReceiptTemplateDraftFields(r.fields),
    purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
  });
}
export async function validateReceiptTemplateDraftReceipt(
  v: unknown,
  input: ReceiptTemplateDraftCursor,
): Promise<ReceiptTemplateDraftReceipt> {
  const receipt = safe(() => {
    const c = parseReceiptTemplateDraftCursor(input),
      r = record(v, [
        "profile",
        ...scopeKeys,
        "actorReference",
        "operationReference",
        "templateReference",
        "expectedVersionReference",
        "expectedRevision",
        "intentDigest",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r);
    if (!sameScope(scope, c.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateDraftReceiptV1" ||
      r.operationReference !== c.operationReference ||
      r.templateReference !== c.templateReference ||
      r.expectedVersionReference !== c.expectedVersionReference ||
      r.expectedRevision !== c.expectedRevision ||
      r.intentDigest !== c.intentDigest ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const snapshot = r.snapshot === null ? null : parseReceiptTemplateDraftSnapshot(r.snapshot),
      occurredAt = instant(r.occurredAt);
    if ((r.outcome === "Abandoned") !== (snapshot === null)) return fail();
    if (
      snapshot &&
      (snapshot.revision !== c.expectedRevision + 1 ||
        snapshot.authoredByReference !== scope.actorReference ||
        snapshot.previousVersionReference !== c.expectedVersionReference ||
        snapshot.updatedAt !== occurredAt ||
        (c.templateReference !== null &&
          snapshot.content.templateReference !== c.templateReference) ||
        scopeKeys.some(
          (k) =>
            Object.getOwnPropertyDescriptor(snapshot, k)?.value !==
            Object.getOwnPropertyDescriptor(scope, k)?.value,
        ))
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftReceiptV1",
      ...scope,
      operationReference: c.operationReference,
      templateReference: c.templateReference,
      expectedVersionReference: c.expectedVersionReference,
      expectedRevision: c.expectedRevision,
      intentDigest: c.intentDigest,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
  if (receipt.snapshot) {
    await validateReceiptTemplateDraftContentDigest(receipt.snapshot);
    const c = receipt.snapshot.content;
    const cmd = original({
      profile: "DigitalReceiptTemplateDraftSaveV1",
      ...scopeFrom({ ...receipt }),
      operationReference: receipt.operationReference,
      templateReference: receipt.templateReference,
      expectedVersionReference: receipt.expectedVersionReference,
      expectedRevision: receipt.expectedRevision,
      purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
      fields: {
        locale: c.locale,
        layoutDefinitionReference: c.layoutDefinitionReference,
        complianceRuleReference: c.complianceRuleReference,
        activation: c.activation,
        effectiveUntil: c.effectiveUntil,
      },
    });
    if ((await publicationValueDigest(cmd)) !== receipt.intentDigest) return fail();
  }
  return receipt;
}
export interface ReceiptTemplateDraftRoster extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateDraftRosterV1";
  readonly afterTemplate: string | null;
  readonly entries: readonly ReceiptTemplateDraftSnapshot[];
  readonly nextAfter: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export function parseReceiptTemplateDraftRoster(
  v: unknown,
  store: string,
  afterTemplate: string | null,
  expectedScope?: StoreSetupScope,
): ReceiptTemplateDraftRoster {
  return safe(() => {
    const r = record(v, [
        "profile",
        ...scopeKeys,
        "actorReference",
        "afterTemplate",
        "entries",
        "nextAfter",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      scope = scopeFrom(r),
      after = nullable(r.afterTemplate),
      nextAfter = nullable(r.nextAfter),
      observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil);
    if (
      scope.storeReference !== ref(store) ||
      (expectedScope && !sameScope(scope, parseStoreSetupScope(expectedScope)))
    )
      return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateDraftRosterV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      after !== (afterTemplate === null ? null : ref(afterTemplate)) ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      !Array.isArray(r.entries) ||
      Object.getPrototypeOf(r.entries) !== Array.prototype ||
      r.entries.length > 20 ||
      Reflect.ownKeys(r.entries).length !== r.entries.length + 1
    )
      return fail();
    const entries: ReceiptTemplateDraftSnapshot[] = [];
    let previous = after;
    for (let i = 0; i < r.entries.length; i++) {
      const d = Object.getOwnPropertyDescriptor(r.entries, String(i));
      if (!d?.enumerable || !("value" in d)) return fail();
      const snapshot = parseReceiptTemplateDraftSnapshot(d.value),
        template = snapshot.content.templateReference;
      if (
        (previous !== null && template <= previous) ||
        snapshot.updatedAt > observedAt ||
        scopeKeys.some(
          (k) =>
            Object.getOwnPropertyDescriptor(snapshot, k)?.value !==
            Object.getOwnPropertyDescriptor(scope, k)?.value,
        )
      )
        return fail();
      entries.push(snapshot);
      previous = template;
    }
    if (nextAfter !== null && (entries.length !== 20 || nextAfter !== previous)) return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftRosterV1",
      ...scope,
      afterTemplate: after,
      entries: Object.freeze(entries),
      nextAfter,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}
interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}

export function createReceiptTemplateDraftClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
    subject?: string | null,
    roster = false,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    const current = canonical({
      store,
      subject: subject ?? null,
      roster,
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
      const response = await fetcher(
        `/merchant/store-setup/receipt-template-draft${roster ? "s" : ""}${body === undefined ? `?storeReference=${ref(store)}${subject ? `&${roster ? "afterTemplate" : "templateReference"}=${ref(subject)}` : ""}` : ""}`,
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
    async loadRoster(
      input: RequestOptions & {
        storeReference: string;
        afterTemplate: string | null;
        expectedScope?: StoreSetupScope;
      },
    ) {
      const attemptCsrf = input.csrf,
        attemptSignal = input.signal;
      const store = safe(() => ref(input.storeReference)),
        after = safe(() => nullable(input.afterTemplate)),
        scope = input.expectedScope ? parseStoreSetupScope(input.expectedScope) : undefined;
      const roster = parseReceiptTemplateDraftRoster(
          await request(store, scope, input, undefined, after, true),
          store,
          after,
          scope,
        ),
        receivedEpoch = epoch;
      for (const snapshot of roster.entries)
        await validateReceiptTemplateDraftContentDigest(snapshot);
      if (
        epoch !== receivedEpoch ||
        input.afterTemplate !== after ||
        input.storeReference !== store ||
        input.csrf !== attemptCsrf ||
        input.signal !== attemptSignal ||
        attemptSignal?.aborted ||
        canonical(input.expectedScope ? parseStoreSetupScope(input.expectedScope) : null) !==
          canonical(scope ?? null)
      )
        return fail("ScopeChanged");
      if (Date.now() < Date.parse(roster.observedAt) || Date.now() >= Date.parse(roster.validUntil))
        return fail("Stale");
      return roster;
    },
    async load(
      input: RequestOptions & {
        storeReference: string;
        templateReference: string | null;
        expectedScope?: StoreSetupScope;
      },
    ) {
      const attemptCsrf = input.csrf,
        attemptSignal = input.signal;
      const store = safe(() => ref(input.storeReference)),
        subject = safe(() => nullable(input.templateReference)),
        scope = input.expectedScope ? parseStoreSetupScope(input.expectedScope) : undefined;
      const current = parseReceiptTemplateDraftCurrent(
        await request(store, scope, input, undefined, subject),
        store,
        subject,
        scope,
      );
      if (
        Date.now() < Date.parse(current.observedAt) ||
        Date.now() >= Date.parse(current.validUntil)
      )
        return fail("Stale");
      const receivedEpoch = epoch;
      await validateReceiptTemplateDraftContentDigest(current.snapshot);
      if (
        epoch !== receivedEpoch ||
        input.templateReference !== subject ||
        input.storeReference !== store ||
        input.csrf !== attemptCsrf ||
        input.signal !== attemptSignal ||
        attemptSignal?.aborted ||
        canonical(input.expectedScope ? parseStoreSetupScope(input.expectedScope) : null) !==
          canonical(scope ?? null)
      )
        return fail("ScopeChanged");
      if (
        Date.now() < Date.parse(current.observedAt) ||
        Date.now() >= Date.parse(current.validUntil)
      )
        return fail("Stale");
      return current;
    },
    async prepare(input: {
      expectedScope: StoreSetupScope;
      templateReference: string | null;
      operationReference: string;
      expectedVersionReference: string | null;
      expectedRevision: number;
      fields: unknown;
    }): Promise<PreparedReceiptTemplateDraft> {
      const r = safe(() =>
          record(input, [
            "expectedScope",
            "templateReference",
            "operationReference",
            "expectedVersionReference",
            "expectedRevision",
            "fields",
          ]),
        ),
        scope = parseStoreSetupScope(r.expectedScope),
        command = safe(() =>
          original({
            profile: "DigitalReceiptTemplateDraftSaveV1",
            ...scope,
            templateReference: r.templateReference,
            operationReference: r.operationReference,
            expectedVersionReference: r.expectedVersionReference,
            expectedRevision: r.expectedRevision,
            fields: r.fields,
            purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
          }),
        ),
        intentDigest = await publicationValueDigest(command),
        cursor = parseReceiptTemplateDraftCursor({
          profile: "ReceiptTemplateDraftPendingOriginalV1",
          scope,
          templateReference: command.templateReference,
          operationReference: command.operationReference,
          expectedVersionReference: command.expectedVersionReference,
          expectedRevision: command.expectedRevision,
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(input: PreparedReceiptTemplateDraft, options: RequestOptions & { csrf: string }) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const r = safe(() => record(input, ["command", "cursor", "intentDigest"])),
        command = safe(() => original(r.command)),
        cursor = parseReceiptTemplateDraftCursor(r.cursor);
      if (
        !sameScope(scopeFrom({ ...command }), cursor.scope) ||
        command.templateReference !== cursor.templateReference ||
        command.operationReference !== cursor.operationReference ||
        command.expectedVersionReference !== cursor.expectedVersionReference ||
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
            command: "SaveDraft",
            operationReference: cursor.operationReference,
            templateReference: cursor.templateReference,
            expectedVersionReference: cursor.expectedVersionReference,
            expectedRevision: cursor.expectedRevision,
            fields: command.fields,
          },
          cursor.templateReference,
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateReceiptTemplateDraftReceipt(raw, cursor);
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
    async resolve(input: ReceiptTemplateDraftCursor, options: RequestOptions & { csrf: string }) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const cursor = parseReceiptTemplateDraftCursor(input),
        raw = await request(
          cursor.scope.storeReference,
          cursor.scope,
          { csrf: attemptCsrf, ...(attemptSignal ? { signal: attemptSignal } : {}) },
          {
            command: "ResolveOriginal",
            operationReference: cursor.operationReference,
            templateReference: cursor.templateReference,
            expectedVersionReference: cursor.expectedVersionReference,
            expectedRevision: cursor.expectedRevision,
            intentDigest: cursor.intentDigest,
          },
          cursor.templateReference,
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateReceiptTemplateDraftReceipt(raw, cursor);
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
