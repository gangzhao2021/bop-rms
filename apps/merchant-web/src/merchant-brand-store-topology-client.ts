import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
export class BrandStoreTopologyClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Conflict"
      | "FeatureDisabled"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged"
      | "Stale",
  ) {
    super("Brand topology draft request could not be confirmed");
    this.name = "BrandStoreTopologyClientError";
  }
}
export interface BrandTopologyScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
}
export interface BrandTopologyDraft {
  readonly profile: "BrandStoreTopologyDraftV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly draftReference: string;
  readonly selectors: readonly Readonly<{
    kind: "Region" | "StoreGroup";
    reference: string;
    code: string;
    name: string;
  }>[];
  readonly assignments: readonly Readonly<{ storeReference: string; selectorReference: string }>[];
}
export interface BrandTopologySave extends BrandTopologyScope {
  readonly profile: "BrandStoreTopologySaveV1";
  readonly operationReference: string;
  readonly expectedRevision: number;
  readonly content: BrandTopologyDraft;
}
export interface BrandTopologyCursor extends BrandTopologyScope {
  readonly profile: "BrandStoreTopologyResolveV1";
  readonly operationReference: string;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface BrandTopologyRevision extends BrandTopologyScope {
  readonly profile: "BrandStoreTopologyDraftRevisionV1";
  readonly revision: number;
  readonly content: BrandTopologyDraft;
  readonly snapshotDigest: string;
  readonly operationReference: string;
  readonly auditReference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
export interface BrandTopologyReceipt extends BrandTopologyScope {
  readonly profile: "BrandStoreTopologyOperationV1";
  readonly operationReference: string;
  readonly expectedRevision: number;
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: BrandTopologyRevision | null;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
export interface BrandTopologyWorkspace extends BrandTopologyScope {
  readonly profile: "BrandStoreTopologyWorkbenchV1";
  readonly current: Readonly<
    BrandTopologyScope & {
      profile: "BrandStoreTopologyCurrentV1";
      current: BrandTopologyRevision | null;
      observedAt: string;
      validUntil: string;
    }
  >;
  readonly history: readonly BrandTopologyRevision[];
  readonly stores: Readonly<{
    profile: "TenantStoreLabelReferenceV1";
    brandReference: string;
    brandLifecycle: Lifecycle;
    brandVersion: string;
    generation: string;
    referenceCount: string;
    originalIntentDigest: string;
    observedAt: string;
    references: readonly Readonly<{
      storeReference: string;
      lifecycle: Lifecycle;
      version: string;
      createdAt: string;
      updatedAt: string;
      code: string;
      displayName: string;
    }>[];
  }>;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly status: "DraftOnly";
}
type Lifecycle = "Draft" | "Active" | "Suspended" | "Archived";
export interface PreparedBrandTopologySave {
  readonly command: BrandTopologySave;
  readonly cursor: BrandTopologyCursor;
}
const scopeKeys = ["tenantReference", "brandReference", "actorReference"];
const fail = (code: BrandStoreTopologyClientError["code"] = "Invalid"): never => {
  throw new BrandStoreTopologyClientError(code);
};
function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof BrandStoreTopologyClientError) throw e;
    return fail();
  }
}
function integer(value: unknown, min = 0, max = 2147483646): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) return fail();
  return value;
}
function dense(value: unknown, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function text(value: unknown, max: number, code = false): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}<>]/u.test(value) ||
    (code && !/^[A-Z][A-Z0-9_-]{0,62}$/u.test(value))
  )
    return fail();
  return value;
}
function scope(r: Record<string, unknown>): BrandTopologyScope {
  return Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    actorReference: ref(r.actorReference),
  });
}
export function parseBrandTopologyScope(value: unknown): BrandTopologyScope {
  return guard(() => scope(record(value, scopeKeys)));
}
const sameScope = (a: BrandTopologyScope, b: BrandTopologyScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.actorReference === b.actorReference;
function bound(r: Record<string, unknown>, expected?: BrandTopologyScope): BrandTopologyScope {
  const actual = scope(r);
  if (expected && !sameScope(actual, expected)) return fail("ScopeChanged");
  return actual;
}
function window(at: unknown, until: unknown) {
  const observedAt = instant(at),
    validUntil = instant(until);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  if (Date.now() < Date.parse(observedAt) || Date.now() >= Date.parse(validUntil))
    return fail("Stale");
  return { observedAt, validUntil };
}
export function parseBrandTopologyDraft(
  value: unknown,
  expected: BrandTopologyScope,
): BrandTopologyDraft {
  return guard(() => {
    const r = record(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "draftReference",
      "selectors",
      "assignments",
    ]);
    if (
      r.profile !== "BrandStoreTopologyDraftV1" ||
      ref(r.tenantReference) !== expected.tenantReference ||
      ref(r.brandReference) !== expected.brandReference
    )
      return fail();
    const refs = new Set<string>(),
      codes = new Set<string>();
    const selectors = dense(r.selectors, 1000)
      .map((v) => {
        const s = record(v, ["kind", "reference", "code", "name"]);
        if (s.kind !== "Region" && s.kind !== "StoreGroup") return fail();
        const reference = ref(s.reference),
          code = text(s.code, 63, true),
          name = text(s.name, 120),
          key = `${s.kind}:${code}`;
        if (refs.has(reference) || codes.has(key)) return fail();
        refs.add(reference);
        codes.add(key);
        return Object.freeze({ kind: s.kind, reference, code, name });
      })
      .sort((a, b) =>
        a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : a.reference < b.reference
              ? -1
              : a.reference > b.reference
                ? 1
                : 0,
      );
    const pairs = new Set<string>();
    const assignments = dense(r.assignments, 10000)
      .map((v) => {
        const a = record(v, ["storeReference", "selectorReference"]),
          storeReference = ref(a.storeReference),
          selectorReference = ref(a.selectorReference),
          key = `${storeReference}:${selectorReference}`;
        if (!refs.has(selectorReference) || pairs.has(key)) return fail();
        pairs.add(key);
        return Object.freeze({ storeReference, selectorReference });
      })
      .sort((a, b) =>
        a.storeReference < b.storeReference
          ? -1
          : a.storeReference > b.storeReference
            ? 1
            : a.selectorReference < b.selectorReference
              ? -1
              : a.selectorReference > b.selectorReference
                ? 1
                : 0,
      );
    const result = Object.freeze({
      profile: "BrandStoreTopologyDraftV1" as const,
      tenantReference: expected.tenantReference,
      brandReference: expected.brandReference,
      draftReference: ref(r.draftReference),
      selectors: Object.freeze(selectors),
      assignments: Object.freeze(assignments),
    });
    if (new TextEncoder().encode(canonical(result)).length > 2097152) return fail();
    return result;
  });
}
export function parseBrandTopologySave(
  value: unknown,
  expected?: BrandTopologyScope,
): BrandTopologySave {
  return guard(() => {
    const r = record(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "expectedRevision",
      "content",
    ]);
    if (r.profile !== "BrandStoreTopologySaveV1") return fail();
    const fixed = bound(r, expected);
    return Object.freeze({
      profile: "BrandStoreTopologySaveV1",
      ...fixed,
      operationReference: ref(r.operationReference),
      expectedRevision: integer(r.expectedRevision),
      content: parseBrandTopologyDraft(r.content, fixed),
    });
  });
}
export function parseBrandTopologyCursor(
  value: unknown,
  expected?: BrandTopologyScope,
): BrandTopologyCursor {
  return guard(() => {
    const r = record(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "BrandStoreTopologyResolveV1") return fail();
    return Object.freeze({
      profile: "BrandStoreTopologyResolveV1",
      ...bound(r, expected),
      operationReference: ref(r.operationReference),
      expectedRevision: integer(r.expectedRevision),
      intentDigest: hash(r.intentDigest),
    });
  });
}
function revision(value: unknown, expected: BrandTopologyScope): BrandTopologyRevision {
  return guard(() => {
    const r = record(value, [
      "profile",
      ...scopeKeys,
      "revision",
      "content",
      "snapshotDigest",
      "operationReference",
      "auditReference",
      "createdAt",
      "updatedAt",
      "dataClassification",
    ]);
    if (
      r.profile !== "BrandStoreTopologyDraftRevisionV1" ||
      r.dataClassification !== "ConfigurationMetadata"
    )
      return fail();
    const fixed = scope(r);
    if (
      fixed.tenantReference !== expected.tenantReference ||
      fixed.brandReference !== expected.brandReference
    )
      return fail("ScopeChanged");
    const createdAt = instant(r.createdAt),
      updatedAt = instant(r.updatedAt);
    if (updatedAt < createdAt) return fail();
    return Object.freeze({
      profile: "BrandStoreTopologyDraftRevisionV1",
      ...fixed,
      revision: integer(r.revision, 1, 2147483647),
      content: parseBrandTopologyDraft(r.content, fixed),
      snapshotDigest: hash(r.snapshotDigest),
      operationReference: ref(r.operationReference),
      auditReference: ref(r.auditReference),
      createdAt,
      updatedAt,
      dataClassification: "ConfigurationMetadata",
    });
  });
}
async function revisionHash(value: BrandTopologyRevision) {
  const { snapshotDigest, ...body } = value;
  if ((await digest(body)) !== snapshotDigest) return fail();
}
export async function validateBrandTopologyReceipt(
  value: unknown,
  cursorValue: BrandTopologyCursor,
): Promise<BrandTopologyReceipt> {
  const cursor = parseBrandTopologyCursor(cursorValue);
  const result = guard(() => {
    const r = record(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "expectedRevision",
      "intentDigest",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ]);
    if (
      r.profile !== "BrandStoreTopologyOperationV1" ||
      r.dataClassification !== "ConfigurationMetadata" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const fixed = bound(r, cursor),
      operationReference = ref(r.operationReference),
      expectedRevision = integer(r.expectedRevision),
      intentDigest = hash(r.intentDigest),
      auditReference = ref(r.auditReference),
      occurredAt = instant(r.occurredAt);
    if (
      operationReference !== cursor.operationReference ||
      expectedRevision !== cursor.expectedRevision ||
      intentDigest !== cursor.intentDigest
    )
      return fail();
    const snapshot = r.snapshot === null ? null : revision(r.snapshot, fixed);
    if (
      r.outcome === "Abandoned"
        ? snapshot !== null
        : !snapshot ||
          snapshot.actorReference !== fixed.actorReference ||
          snapshot.revision !== expectedRevision + 1 ||
          snapshot.operationReference !== operationReference ||
          snapshot.auditReference !== auditReference ||
          snapshot.updatedAt !== occurredAt
    )
      return fail();
    return Object.freeze({
      profile: "BrandStoreTopologyOperationV1" as const,
      ...fixed,
      operationReference,
      expectedRevision,
      intentDigest,
      outcome: r.outcome,
      snapshot,
      auditReference,
      occurredAt,
      dataClassification: "ConfigurationMetadata" as const,
    });
  });
  if (result.snapshot) {
    await revisionHash(result.snapshot);
    const original = parseBrandTopologySave({
      profile: "BrandStoreTopologySaveV1",
      ...{
        tenantReference: result.tenantReference,
        brandReference: result.brandReference,
        actorReference: result.actorReference,
      },
      operationReference: result.operationReference,
      expectedRevision: result.expectedRevision,
      content: result.snapshot.content,
    });
    if ((await digest(original)) !== result.intentDigest) return fail();
  }
  return result;
}
function count(value: unknown, positive = false): string {
  if (
    typeof value !== "string" ||
    value.length > 19 ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    BigInt(value) > 9223372036854775807n ||
    (positive && value === "0")
  )
    return fail();
  return value;
}
function lifecycle(value: unknown): Lifecycle {
  if (value !== "Draft" && value !== "Active" && value !== "Suspended" && value !== "Archived")
    return fail();
  return value;
}
export async function parseBrandTopologyWorkspace(
  value: unknown,
  brand: string,
  expected?: BrandTopologyScope,
): Promise<BrandTopologyWorkspace> {
  const parsed = guard(() => {
    const r = record(value, [
      "profile",
      ...scopeKeys,
      "current",
      "history",
      "stores",
      "observedAt",
      "validUntil",
      "status",
    ]);
    if (r.profile !== "BrandStoreTopologyWorkbenchV1" || r.status !== "DraftOnly") return fail();
    const fixed = bound(r, expected);
    if (fixed.brandReference !== ref(brand)) return fail("ScopeChanged");
    const lease = window(r.observedAt, r.validUntil);
    const c = record(r.current, ["profile", ...scopeKeys, "current", "observedAt", "validUntil"]);
    if (c.profile !== "BrandStoreTopologyCurrentV1") return fail();
    const currentScope = bound(c, fixed),
      currentLease = window(c.observedAt, c.validUntil);
    if (currentLease.observedAt > lease.observedAt || currentLease.validUntil < lease.validUntil)
      return fail();
    const latest = c.current === null ? null : revision(c.current, fixed);
    if (latest && latest.updatedAt > lease.observedAt) return fail();
    const history = dense(r.history, 1000).map((v) => revision(v, fixed));
    for (let i = 0; i < history.length; i++) {
      const row = history[i],
        previous = history[i - 1];
      if (
        !row ||
        row.revision !== i + 1 ||
        row.updatedAt > lease.observedAt ||
        (previous &&
          (row.createdAt !== previous.createdAt ||
            row.content.draftReference !== previous.content.draftReference ||
            row.updatedAt < previous.updatedAt))
      )
        return fail();
    }
    if (
      (latest === null) !== (history.length === 0) ||
      (latest && canonical(history[history.length - 1]) !== canonical(latest))
    )
      return fail();
    const s = record(r.stores, [
      "profile",
      "brandReference",
      "brandLifecycle",
      "brandVersion",
      "generation",
      "referenceCount",
      "originalIntentDigest",
      "observedAt",
      "references",
    ]);
    if (
      s.profile !== "TenantStoreLabelReferenceV1" ||
      ref(s.brandReference) !== fixed.brandReference
    )
      return fail();
    const observedAt = instant(s.observedAt);
    if (observedAt > lease.observedAt) return fail();
    let last = "";
    const stores = dense(s.references, 10000).map((v) => {
      const t = record(v, [
          "storeReference",
          "lifecycle",
          "version",
          "createdAt",
          "updatedAt",
          "code",
          "displayName",
        ]),
        storeReference = ref(t.storeReference),
        createdAt = instant(t.createdAt),
        updatedAt = instant(t.updatedAt);
      if (storeReference <= last || updatedAt < createdAt || updatedAt > observedAt) return fail();
      last = storeReference;
      return Object.freeze({
        storeReference,
        lifecycle: lifecycle(t.lifecycle),
        version: count(t.version, true),
        createdAt,
        updatedAt,
        code: text(t.code, 63, true),
        displayName: text(t.displayName, 160),
      });
    });
    const referenceCount = count(s.referenceCount);
    if (BigInt(referenceCount) !== BigInt(stores.length)) return fail();
    return Object.freeze({
      profile: "BrandStoreTopologyWorkbenchV1" as const,
      ...fixed,
      current: Object.freeze({
        profile: "BrandStoreTopologyCurrentV1" as const,
        ...currentScope,
        current: latest,
        ...currentLease,
      }),
      history: Object.freeze(history),
      stores: Object.freeze({
        profile: "TenantStoreLabelReferenceV1" as const,
        brandReference: fixed.brandReference,
        brandLifecycle: lifecycle(s.brandLifecycle),
        brandVersion: count(s.brandVersion, true),
        generation: count(s.generation),
        referenceCount,
        originalIntentDigest: hash(s.originalIntentDigest),
        observedAt,
        references: Object.freeze(stores),
      }),
      ...lease,
      status: "DraftOnly" as const,
    });
  });
  for (const row of parsed.history) await revisionHash(row);
  window(parsed.observedAt, parsed.validUntil);
  return parsed;
}
export function createMerchantBrandStoreTopologyClient(fetcher: typeof fetch = fetch) {
  let epoch = 0;
  const invalidate = () => {
    epoch++;
  };
  async function request(
    path: string,
    body: unknown,
    options: { csrf: string; signal?: AbortSignal },
    write: boolean,
  ) {
    const csrf = options.csrf,
      signal = options.signal,
      captured = epoch;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail();
    if (signal?.aborted) return fail("Unavailable");
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false;
    try {
      const encoded = canonical(body);
      if (new TextEncoder().encode(encoded).length > 2105344) return fail();
      sent = true;
      const response = await fetcher(`/merchant/organization/brands/topology/draft/${path}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: encoded,
      });
      if (epoch !== captured || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (response.status === 403) return fail("Denied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 400) return fail("Invalid");
      if (
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
        !response.body
      )
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      let bytes = 0,
        text = "";
      try {
        while (true) {
          if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > (response.ok ? 41943040 : 8192))
            return fail(write ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      if (
        controller.signal.aborted ||
        epoch !== captured ||
        options.csrf !== csrf ||
        options.signal !== signal
      )
        return fail(
          epoch !== captured || options.csrf !== csrf || options.signal !== signal
            ? "ScopeChanged"
            : write
              ? "OutcomeUnknown"
              : "Unavailable",
        );
      const payload = JSON.parse(text);
      if (!response.ok) {
        if (response.status === 503) {
          const r = record(payload, ["error"]);
          if (r.error === "brand_store_topology_feature_disabled") return fail("FeatureDisabled");
        }
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      }
      return payload;
    } catch (error) {
      if (error instanceof BrandStoreTopologyClientError) throw error;
      return fail(sent && write ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    invalidate,
    async workspace(
      input: { expectedBrandReference: string; expectedScope?: BrandTopologyScope },
      options: { csrf: string; signal?: AbortSignal },
    ) {
      const brand = ref(input.expectedBrandReference),
        expected =
          input.expectedScope === undefined
            ? undefined
            : parseBrandTopologyScope(input.expectedScope),
        captured = epoch;
      const body = {
        expectedBrandReference: brand,
        ...(expected ? { expectedScope: expected } : {}),
      };
      const result = await parseBrandTopologyWorkspace(
        await request("workspace", body, options, false),
        brand,
        expected,
      );
      if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
      return result;
    },
    async prepare(
      expected: BrandTopologyScope,
      command: unknown,
      options: { signal?: AbortSignal } = {},
    ) {
      const captured = epoch;
      if (options.signal?.aborted) return fail("Unavailable");
      const fixed = parseBrandTopologyScope(expected),
        parsed = parseBrandTopologySave(command, fixed),
        intentDigest = await digest(parsed);
      if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
      return Object.freeze({
        command: parsed,
        cursor: parseBrandTopologyCursor({
          profile: "BrandStoreTopologyResolveV1",
          ...fixed,
          operationReference: parsed.operationReference,
          expectedRevision: parsed.expectedRevision,
          intentDigest,
        }),
      });
    },
    async execute(
      prepared: PreparedBrandTopologySave,
      options: { csrf: string; signal?: AbortSignal },
    ) {
      const captured = epoch,
        command = parseBrandTopologySave(prepared.command),
        fixed = parseBrandTopologyScope({
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          actorReference: command.actorReference,
        }),
        cursor = parseBrandTopologyCursor(prepared.cursor, fixed);
      if (
        (await digest(command)) !== cursor.intentDigest ||
        command.operationReference !== cursor.operationReference ||
        command.expectedRevision !== cursor.expectedRevision
      )
        return fail();
      if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
      try {
        const result = await validateBrandTopologyReceipt(
          await request("save", { expectedScope: fixed, command }, options, true),
          cursor,
        );
        if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
        return result;
      } catch (error) {
        if (
          error instanceof BrandStoreTopologyClientError &&
          [
            "Denied",
            "Conflict",
            "FeatureDisabled",
            "Invalid",
            "ScopeChanged",
            "OutcomeUnknown",
          ].includes(error.code)
        )
          throw error;
        return fail("OutcomeUnknown");
      }
    },
    async resolve(value: BrandTopologyCursor, options: { csrf: string; signal?: AbortSignal }) {
      const cursor = parseBrandTopologyCursor(value),
        fixed = parseBrandTopologyScope({
          tenantReference: cursor.tenantReference,
          brandReference: cursor.brandReference,
          actorReference: cursor.actorReference,
        }),
        captured = epoch;
      const result = await validateBrandTopologyReceipt(
        await request("resolve", { expectedScope: fixed, command: cursor }, options, true),
        cursor,
      );
      if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
      return result;
    },
  });
}
