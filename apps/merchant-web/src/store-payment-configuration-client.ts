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
export { StoreSetupClientError as StorePaymentConfigurationClientError };
export interface StorePaymentConfigurationContent {
  readonly customerOnlineCardEnabled: boolean;
  readonly staffTerminalCardPresentEnabled: boolean;
  readonly staffTerminalInteracEnabled: boolean;
}
export interface StorePaymentConfigurationSnapshot {
  readonly profile: "StorePaymentConfigurationV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousConfigurationReference: string | null;
  readonly content: StorePaymentConfigurationContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currencyCode: "CAD";
  readonly dataClassification: "Internal";
}
export interface StorePaymentConfigurationCurrent extends StoreSetupScope {
  readonly profile: "StorePaymentConfigurationCurrentV1";
  readonly snapshot: StorePaymentConfigurationSnapshot | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly providerReadiness: "NotEvaluated";
}
export interface StorePaymentConfigurationCursor {
  readonly profile: "StorePaymentConfigurationPendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly operationReference: string;
  readonly expectedConfigurationReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface StorePaymentConfigurationOriginal extends StoreSetupScope {
  readonly profile: "StorePaymentConfigurationSaveV1";
  readonly operationReference: string;
  readonly expectedConfigurationReference: string | null;
  readonly expectedRevision: number;
  readonly content: StorePaymentConfigurationContent;
  readonly purposeCode: "STORE_PAYMENT_CONFIGURATION";
}
export interface PreparedStorePaymentConfiguration {
  readonly command: StorePaymentConfigurationOriginal;
  readonly intentDigest: string;
  readonly cursor: StorePaymentConfigurationCursor;
}
export interface StorePaymentConfigurationReceipt extends StoreSetupScope {
  readonly profile: "StorePaymentConfigurationReceiptV1";
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly expectedConfigurationReference: string | null;
  readonly expectedRevision: number;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: StorePaymentConfigurationSnapshot | null;
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
    expectedConfigurationReference = nullable(r.expectedConfigurationReference);
  if ((expectedConfigurationReference === null) !== (expectedRevision === 0)) return fail();
  return { expectedRevision, expectedConfigurationReference };
}
export function parseStorePaymentConfigurationContent(
  v: unknown,
): StorePaymentConfigurationContent {
  return safe(() => {
    const r = record(v, [
      "customerOnlineCardEnabled",
      "staffTerminalCardPresentEnabled",
      "staffTerminalInteracEnabled",
    ]);
    if (
      typeof r.customerOnlineCardEnabled !== "boolean" ||
      typeof r.staffTerminalCardPresentEnabled !== "boolean" ||
      typeof r.staffTerminalInteracEnabled !== "boolean"
    )
      return fail();
    return Object.freeze({
      customerOnlineCardEnabled: r.customerOnlineCardEnabled,
      staffTerminalCardPresentEnabled: r.staffTerminalCardPresentEnabled,
      staffTerminalInteracEnabled: r.staffTerminalInteracEnabled,
    });
  });
}
export function parseStorePaymentConfigurationSnapshot(
  v: unknown,
): StorePaymentConfigurationSnapshot {
  return safe(() => {
    const r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "configurationReference",
        "revision",
        "authoredByReference",
        "previousConfigurationReference",
        "content",
        "currencyCode",
        "createdAt",
        "updatedAt",
        "dataClassification",
      ]),
      revision = int(r.revision, 1),
      configurationReference = ref(r.configurationReference),
      previousConfigurationReference = nullable(r.previousConfigurationReference),
      createdAt = instant(r.createdAt),
      updatedAt = instant(r.updatedAt);
    if (
      r.profile !== "StorePaymentConfigurationV1" ||
      r.dataClassification !== "Internal" ||
      r.currencyCode !== "CAD" ||
      (revision === 1) !== (previousConfigurationReference === null) ||
      configurationReference === previousConfigurationReference ||
      updatedAt < createdAt ||
      (revision === 1 && updatedAt !== createdAt)
    )
      return fail();
    return Object.freeze({
      profile: "StorePaymentConfigurationV1",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      configurationReference,
      revision,
      authoredByReference: ref(r.authoredByReference),
      previousConfigurationReference,
      content: parseStorePaymentConfigurationContent(r.content),
      createdAt,
      updatedAt,
      currencyCode: "CAD",
      dataClassification: "Internal",
    });
  });
}
export function parseStorePaymentConfigurationCurrent(
  v: unknown,
  expectedStore: string,
  expectedScope?: StoreSetupScope,
): StorePaymentConfigurationCurrent {
  return safe(() => {
    const r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "snapshot",
        "observedAt",
        "validUntil",
        "providerReadiness",
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
      r.profile !== "StorePaymentConfigurationCurrentV1" ||
      r.providerReadiness !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const snapshot =
      r.snapshot === null ? null : parseStorePaymentConfigurationSnapshot(r.snapshot);
    if (
      snapshot &&
      (snapshot.tenantReference !== scope.tenantReference ||
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.updatedAt > observedAt)
    )
      return fail();
    return Object.freeze({
      profile: "StorePaymentConfigurationCurrentV1",
      ...scope,
      snapshot,
      observedAt,
      validUntil,
      providerReadiness: "NotEvaluated",
    });
  });
}
export function parseStorePaymentConfigurationCursor(v: unknown): StorePaymentConfigurationCursor {
  return safe(() => {
    const r = record(v, [
      "profile",
      "scope",
      "operationReference",
      "expectedConfigurationReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "StorePaymentConfigurationPendingOriginalV1") return fail();
    return Object.freeze({
      profile: "StorePaymentConfigurationPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      operationReference: ref(r.operationReference),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
function original(v: unknown): StorePaymentConfigurationOriginal {
  const r = record(v, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "operationReference",
      "expectedConfigurationReference",
      "expectedRevision",
      "content",
      "purposeCode",
    ]),
    p = pins(r);
  if (
    r.profile !== "StorePaymentConfigurationSaveV1" ||
    r.purposeCode !== "STORE_PAYMENT_CONFIGURATION" ||
    p.expectedRevision === 2147483647
  )
    return fail();
  return Object.freeze({
    profile: "StorePaymentConfigurationSaveV1",
    ...scopeFrom(r),
    operationReference: ref(r.operationReference),
    ...p,
    content: parseStorePaymentConfigurationContent(r.content),
    purposeCode: "STORE_PAYMENT_CONFIGURATION",
  });
}
export async function validateStorePaymentConfigurationReceipt(
  v: unknown,
  input: StorePaymentConfigurationCursor,
): Promise<StorePaymentConfigurationReceipt> {
  const receipt = safe(() => {
    const c = parseStorePaymentConfigurationCursor(input),
      r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "operationReference",
        "intentDigest",
        "expectedConfigurationReference",
        "expectedRevision",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r);
    if (!sameScope(scope, c.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "StorePaymentConfigurationReceiptV1" ||
      r.operationReference !== c.operationReference ||
      r.intentDigest !== c.intentDigest ||
      r.expectedConfigurationReference !== c.expectedConfigurationReference ||
      r.expectedRevision !== c.expectedRevision ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const snapshot =
        r.snapshot === null ? null : parseStorePaymentConfigurationSnapshot(r.snapshot),
      occurredAt = instant(r.occurredAt);
    if ((r.outcome === "Abandoned") !== (snapshot === null)) return fail();
    if (
      snapshot &&
      (snapshot.tenantReference !== scope.tenantReference ||
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.authoredByReference !== scope.actorReference ||
        snapshot.previousConfigurationReference !== c.expectedConfigurationReference ||
        snapshot.configurationReference === c.expectedConfigurationReference ||
        snapshot.revision !== c.expectedRevision + 1 ||
        snapshot.updatedAt !== occurredAt)
    )
      return fail();
    return Object.freeze({
      profile: "StorePaymentConfigurationReceiptV1",
      ...scope,
      operationReference: c.operationReference,
      intentDigest: c.intentDigest,
      expectedConfigurationReference: c.expectedConfigurationReference,
      expectedRevision: c.expectedRevision,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
  if (receipt.snapshot) {
    const command = {
      profile: "StorePaymentConfigurationSaveV1",
      tenantReference: receipt.tenantReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      actorReference: receipt.actorReference,
      operationReference: receipt.operationReference,
      expectedConfigurationReference: receipt.expectedConfigurationReference,
      expectedRevision: receipt.expectedRevision,
      content: receipt.snapshot.content,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    };
    if ((await publicationValueDigest(command)) !== receipt.intentDigest) return fail();
  }
  return receipt;
}
interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}

export function createStorePaymentConfigurationClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
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
        `/merchant/store-setup/payment-configuration${body === undefined ? `?storeReference=${ref(store)}` : ""}`,
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
      const current = parseStorePaymentConfigurationCurrent(
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
      operationReference: string;
      expectedConfigurationReference: string | null;
      expectedRevision: number;
      content: unknown;
    }): Promise<PreparedStorePaymentConfiguration> {
      const r = safe(() =>
          record(input, [
            "expectedScope",
            "operationReference",
            "expectedConfigurationReference",
            "expectedRevision",
            "content",
          ]),
        ),
        scope = parseStoreSetupScope(r.expectedScope),
        command = safe(() =>
          original({
            profile: "StorePaymentConfigurationSaveV1",
            ...scope,
            operationReference: r.operationReference,
            expectedConfigurationReference: r.expectedConfigurationReference,
            expectedRevision: r.expectedRevision,
            content: r.content,
            purposeCode: "STORE_PAYMENT_CONFIGURATION",
          }),
        ),
        intentDigest = await publicationValueDigest(command),
        cursor = parseStorePaymentConfigurationCursor({
          profile: "StorePaymentConfigurationPendingOriginalV1",
          scope,
          operationReference: command.operationReference,
          expectedConfigurationReference: command.expectedConfigurationReference,
          expectedRevision: command.expectedRevision,
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(
      input: PreparedStorePaymentConfiguration,
      options: RequestOptions & { csrf: string },
    ) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const r = safe(() => record(input, ["command", "cursor", "intentDigest"])),
        command = safe(() => original(r.command)),
        cursor = parseStorePaymentConfigurationCursor(r.cursor);
      if (
        !sameScope(scopeFrom({ ...command }), cursor.scope) ||
        command.operationReference !== cursor.operationReference ||
        command.expectedConfigurationReference !== cursor.expectedConfigurationReference ||
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
            command: "SaveConfiguration",
            operationReference: cursor.operationReference,
            expectedConfigurationReference: cursor.expectedConfigurationReference,
            expectedRevision: cursor.expectedRevision,
            content: command.content,
          },
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateStorePaymentConfigurationReceipt(raw, cursor);
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
      input: StorePaymentConfigurationCursor,
      options: RequestOptions & { csrf: string },
    ) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const cursor = parseStorePaymentConfigurationCursor(input),
        raw = await request(
          cursor.scope.storeReference,
          cursor.scope,
          { csrf: attemptCsrf, ...(attemptSignal ? { signal: attemptSignal } : {}) },
          {
            command: "ResolveOriginal",
            operationReference: cursor.operationReference,
            expectedConfigurationReference: cursor.expectedConfigurationReference,
            expectedRevision: cursor.expectedRevision,
            intentDigest: cursor.intentDigest,
          },
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateStorePaymentConfigurationReceipt(raw, cursor);
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
