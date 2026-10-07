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
export { StoreSetupClientError as StoreSetupReferenceClientError };
export type StoreSetupReferenceKind = "Address" | "Contact";
export interface StoreSetupBusinessAddress {
  readonly countryCode: string;
  readonly regionCode: string;
  readonly locality: string;
  readonly postalCode: string;
  readonly addressLines: readonly string[];
}
export interface StoreSetupBusinessContact {
  readonly contactName: string;
  readonly businessPhone: string;
  readonly website: string | null;
}
export type StoreSetupReferenceContent = StoreSetupBusinessAddress | StoreSetupBusinessContact;
export interface StoreSetupReferenceSnapshot {
  readonly profile: "StoreSetupReferenceVersionV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly kind: StoreSetupReferenceKind;
  readonly reference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousReference: string | null;
  readonly content: StoreSetupReferenceContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
export interface StoreSetupReferencesCurrent extends StoreSetupScope {
  readonly profile: "StoreSetupReferencesCurrentV1";
  readonly address: StoreSetupReferenceSnapshot | null;
  readonly contact: StoreSetupReferenceSnapshot | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly businessReferenceValidation: "NotEvaluated";
}
export interface StoreSetupReferenceCursor {
  readonly profile: "StoreSetupReferencePendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly kind: StoreSetupReferenceKind;
  readonly operationReference: string;
  readonly expectedReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface StoreSetupReferenceOriginal extends StoreSetupScope {
  readonly profile: "StoreSetupReferenceSaveV1";
  readonly kind: StoreSetupReferenceKind;
  readonly operationReference: string;
  readonly expectedReference: string | null;
  readonly expectedRevision: number;
  readonly content: StoreSetupReferenceContent;
  readonly purposeCode: "STORE_SETUP_REFERENCE";
}
export interface PreparedStoreSetupReference {
  readonly command: StoreSetupReferenceOriginal;
  readonly intentDigest: string;
  readonly cursor: StoreSetupReferenceCursor;
}
export interface StoreSetupReferenceReceipt extends StoreSetupScope {
  readonly profile: "StoreSetupReferenceReceiptV1";
  readonly kind: StoreSetupReferenceKind;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly expectedReference: string | null;
  readonly expectedRevision: number;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: StoreSetupReferenceSnapshot | null;
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
const kind = (v: unknown): StoreSetupReferenceKind =>
  v === "Address" || v === "Contact" ? v : fail();
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
    expectedReference = nullable(r.expectedReference);
  if ((expectedReference === null) !== (expectedRevision === 0)) return fail();
  return { expectedRevision, expectedReference };
}
function plain(v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    v.length < 1 ||
    v.length > max ||
    v.trim() !== v ||
    /[<>{}[\]`*_#]/u.test(v) ||
    [...v].some((c) => {
      const n = c.codePointAt(0);
      return n !== undefined && (n <= 31 || n === 127);
    })
  )
    return fail();
  return v;
}
export function parseStoreSetupReferenceContent(
  k: StoreSetupReferenceKind,
  v: unknown,
): StoreSetupReferenceContent {
  return safe(() => {
    if (kind(k) === "Address") {
      const r = record(v, ["countryCode", "regionCode", "locality", "postalCode", "addressLines"]);
      if (
        typeof r.countryCode !== "string" ||
        !/^[A-Z]{2}$/u.test(r.countryCode) ||
        typeof r.regionCode !== "string" ||
        !/^[A-Z0-9][A-Z0-9-]{0,15}$/u.test(r.regionCode) ||
        typeof r.postalCode !== "string" ||
        !/^[A-Z0-9][A-Z0-9 -]{0,15}$/u.test(r.postalCode) ||
        !Array.isArray(r.addressLines) ||
        r.addressLines.length < 1 ||
        r.addressLines.length > 3
      )
        return fail();
      if (
        Object.getPrototypeOf(r.addressLines) !== Array.prototype ||
        Reflect.ownKeys(r.addressLines).length !== r.addressLines.length + 1
      )
        return fail();
      const lines: string[] = [];
      for (let i = 0; i < r.addressLines.length; i++) {
        const d = Object.getOwnPropertyDescriptor(r.addressLines, String(i));
        if (!d?.enumerable || !("value" in d)) return fail();
        lines.push(plain(d.value, 160));
      }
      return Object.freeze({
        countryCode: r.countryCode,
        regionCode: r.regionCode,
        locality: plain(r.locality, 96),
        postalCode: r.postalCode,
        addressLines: Object.freeze(lines),
      });
    }
    const r = record(v, ["contactName", "businessPhone", "website"]);
    if (
      typeof r.contactName !== "string" ||
      r.contactName.trim() === "" ||
      r.contactName.length > 120 ||
      /[\p{Cc}\p{Cf}<>]/u.test(r.contactName) ||
      typeof r.businessPhone !== "string" ||
      !/^\+[1-9]\d{7,14}$/u.test(r.businessPhone)
    )
      return fail();
    let website: string | null = null;
    if (r.website !== null) {
      if (typeof r.website !== "string" || r.website.length > 512 || r.website.trim() !== r.website)
        return fail();
      const u = new URL(r.website);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !u.hostname ||
        u.toString() !== r.website
      )
        return fail();
      website = r.website;
    }
    return Object.freeze({
      contactName: r.contactName.trim(),
      businessPhone: r.businessPhone,
      website,
    });
  });
}
export function parseStoreSetupReferenceSnapshot(v: unknown): StoreSetupReferenceSnapshot {
  return safe(() => {
    const r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "kind",
        "reference",
        "revision",
        "authoredByReference",
        "previousReference",
        "content",
        "createdAt",
        "updatedAt",
        "dataClassification",
      ]),
      k = kind(r.kind),
      revision = int(r.revision, 1),
      reference = ref(r.reference),
      previousReference = nullable(r.previousReference),
      createdAt = instant(r.createdAt),
      updatedAt = instant(r.updatedAt);
    if (
      r.profile !== "StoreSetupReferenceVersionV1" ||
      r.dataClassification !== "Internal" ||
      (revision === 1) !== (previousReference === null) ||
      reference === previousReference ||
      updatedAt < createdAt ||
      (revision === 1 && updatedAt !== createdAt)
    )
      return fail();
    return Object.freeze({
      profile: "StoreSetupReferenceVersionV1",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      kind: k,
      reference,
      revision,
      authoredByReference: ref(r.authoredByReference),
      previousReference,
      content: parseStoreSetupReferenceContent(k, r.content),
      createdAt,
      updatedAt,
      dataClassification: "Internal",
    });
  });
}
export function parseStoreSetupReferencesCurrent(
  v: unknown,
  expectedStore: string,
  expectedScope?: StoreSetupScope,
): StoreSetupReferencesCurrent {
  return safe(() => {
    const r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "address",
        "contact",
        "observedAt",
        "validUntil",
        "businessReferenceValidation",
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
      r.profile !== "StoreSetupReferencesCurrentV1" ||
      r.businessReferenceValidation !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const address = r.address === null ? null : parseStoreSetupReferenceSnapshot(r.address),
      contact = r.contact === null ? null : parseStoreSetupReferenceSnapshot(r.contact);
    for (const [s, k] of [
      [address, "Address"],
      [contact, "Contact"],
    ] as const)
      if (
        s &&
        (s.kind !== k ||
          s.tenantReference !== scope.tenantReference ||
          s.brandReference !== scope.brandReference ||
          s.storeReference !== scope.storeReference ||
          s.updatedAt > observedAt)
      )
        return fail();
    return Object.freeze({
      profile: "StoreSetupReferencesCurrentV1",
      ...scope,
      address,
      contact,
      observedAt,
      validUntil,
      businessReferenceValidation: "NotEvaluated",
    });
  });
}
export function parseStoreSetupReferenceCursor(v: unknown): StoreSetupReferenceCursor {
  return safe(() => {
    const r = record(v, [
      "profile",
      "scope",
      "kind",
      "operationReference",
      "expectedReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "StoreSetupReferencePendingOriginalV1") return fail();
    return Object.freeze({
      profile: "StoreSetupReferencePendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      kind: kind(r.kind),
      operationReference: ref(r.operationReference),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
function original(v: unknown): StoreSetupReferenceOriginal {
  const r = record(v, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "kind",
      "operationReference",
      "expectedReference",
      "expectedRevision",
      "content",
      "purposeCode",
    ]),
    k = kind(r.kind),
    p = pins(r);
  if (
    r.profile !== "StoreSetupReferenceSaveV1" ||
    r.purposeCode !== "STORE_SETUP_REFERENCE" ||
    p.expectedRevision === 2147483647
  )
    return fail();
  return Object.freeze({
    profile: "StoreSetupReferenceSaveV1",
    ...scopeFrom(r),
    kind: k,
    operationReference: ref(r.operationReference),
    ...p,
    content: parseStoreSetupReferenceContent(k, r.content),
    purposeCode: "STORE_SETUP_REFERENCE",
  });
}
export async function validateStoreSetupReferenceReceipt(
  v: unknown,
  input: StoreSetupReferenceCursor,
): Promise<StoreSetupReferenceReceipt> {
  const receipt = safe(() => {
    const c = parseStoreSetupReferenceCursor(input),
      r = record(v, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "kind",
        "operationReference",
        "intentDigest",
        "expectedReference",
        "expectedRevision",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r);
    if (!sameScope(scope, c.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "StoreSetupReferenceReceiptV1" ||
      r.kind !== c.kind ||
      r.operationReference !== c.operationReference ||
      r.intentDigest !== c.intentDigest ||
      r.expectedReference !== c.expectedReference ||
      r.expectedRevision !== c.expectedRevision ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const snapshot = r.snapshot === null ? null : parseStoreSetupReferenceSnapshot(r.snapshot),
      occurredAt = instant(r.occurredAt);
    if ((r.outcome === "Abandoned") !== (snapshot === null)) return fail();
    if (
      snapshot &&
      (snapshot.kind !== c.kind ||
        snapshot.tenantReference !== scope.tenantReference ||
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.authoredByReference !== scope.actorReference ||
        snapshot.previousReference !== c.expectedReference ||
        snapshot.reference === c.expectedReference ||
        snapshot.revision !== c.expectedRevision + 1 ||
        snapshot.updatedAt !== occurredAt)
    )
      return fail();
    return Object.freeze({
      profile: "StoreSetupReferenceReceiptV1",
      ...scope,
      kind: c.kind,
      operationReference: c.operationReference,
      intentDigest: c.intentDigest,
      expectedReference: c.expectedReference,
      expectedRevision: c.expectedRevision,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
  if (receipt.snapshot) {
    const command = {
      profile: "StoreSetupReferenceSaveV1",
      tenantReference: receipt.tenantReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      actorReference: receipt.actorReference,
      kind: receipt.kind,
      operationReference: receipt.operationReference,
      expectedReference: receipt.expectedReference,
      expectedRevision: receipt.expectedRevision,
      content: receipt.snapshot.content,
      purposeCode: "STORE_SETUP_REFERENCE",
    };
    if ((await publicationValueDigest(command)) !== receipt.intentDigest) return fail();
  }
  return receipt;
}
interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}

export function createStoreSetupReferenceClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
    selectedKind?: StoreSetupReferenceKind,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    const current = canonical({ store, scope: scope ?? null, csrf: options.csrf });
    if (current !== key) {
      key = current;
      epoch++;
    }
    const captured = epoch;
    if (body !== undefined && (typeof options.csrf !== "string" || !options.csrf)) return fail();
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
        `/merchant/store-setup/references${body === undefined ? `?storeReference=${ref(store)}` : `/${selectedKind === "Address" ? "address" : "contact"}`}`,
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
      const current = parseStoreSetupReferencesCurrent(
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
      kind: StoreSetupReferenceKind;
      operationReference: string;
      expectedReference: string | null;
      expectedRevision: number;
      content: unknown;
    }): Promise<PreparedStoreSetupReference> {
      const r = safe(() =>
          record(input, [
            "expectedScope",
            "kind",
            "operationReference",
            "expectedReference",
            "expectedRevision",
            "content",
          ]),
        ),
        scope = parseStoreSetupScope(r.expectedScope),
        command = safe(() =>
          original({
            profile: "StoreSetupReferenceSaveV1",
            ...scope,
            kind: r.kind,
            operationReference: r.operationReference,
            expectedReference: r.expectedReference,
            expectedRevision: r.expectedRevision,
            content: r.content,
            purposeCode: "STORE_SETUP_REFERENCE",
          }),
        ),
        intentDigest = await publicationValueDigest(command),
        cursor = parseStoreSetupReferenceCursor({
          profile: "StoreSetupReferencePendingOriginalV1",
          scope,
          kind: command.kind,
          operationReference: command.operationReference,
          expectedReference: command.expectedReference,
          expectedRevision: command.expectedRevision,
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(input: PreparedStoreSetupReference, options: RequestOptions & { csrf: string }) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const r = safe(() => record(input, ["command", "cursor", "intentDigest"])),
        command = safe(() => original(r.command)),
        cursor = parseStoreSetupReferenceCursor(r.cursor);
      if (
        !sameScope(scopeFrom({ ...command }), cursor.scope) ||
        command.kind !== cursor.kind ||
        command.operationReference !== cursor.operationReference ||
        command.expectedReference !== cursor.expectedReference ||
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
            command: "SaveReference",
            operationReference: cursor.operationReference,
            expectedReference: cursor.expectedReference,
            expectedRevision: cursor.expectedRevision,
            content: command.content,
          },
          cursor.kind,
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateStoreSetupReferenceReceipt(raw, cursor);
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
    async resolve(input: StoreSetupReferenceCursor, options: RequestOptions & { csrf: string }) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const cursor = parseStoreSetupReferenceCursor(input),
        raw = await request(
          cursor.scope.storeReference,
          cursor.scope,
          { csrf: attemptCsrf, ...(attemptSignal ? { signal: attemptSignal } : {}) },
          {
            command: "ResolveOriginal",
            operationReference: cursor.operationReference,
            expectedReference: cursor.expectedReference,
            expectedRevision: cursor.expectedRevision,
            intentDigest: cursor.intentDigest,
          },
          cursor.kind,
        ),
        receivedEpoch = epoch;
      try {
        const result = await validateStoreSetupReferenceReceipt(raw, cursor);
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
