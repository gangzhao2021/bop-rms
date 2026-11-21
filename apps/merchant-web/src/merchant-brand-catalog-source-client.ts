import {
  productCommandRecord as exact,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonicalizeRfc8785,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
export class BrandCatalogSourceClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged"
      | "Stale",
  ) {
    super("Catalogue source request could not be confirmed");
    this.name = "BrandCatalogSourceClientError";
  }
}
const scopeFields = ["tenantReference", "brandReference", "actorReference"] as const;
const fail = (code: BrandCatalogSourceClientError["code"] = "Invalid"): never => {
  throw new BrandCatalogSourceClientError(code);
};
function scope(r: Record<string, unknown>) {
  return Object.freeze({
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
  });
}
export function parseBrandCatalogSourceScope(value: unknown) {
  return scope(exact(value, scopeFields));
}
export type BrandCatalogSourceScope = ReturnType<typeof parseBrandCatalogSourceScope>;
function label(value: unknown): string {
  if (typeof value !== "string") return fail();
  // RFC 8785 rejects lone UTF-16 surrogates rather than hashing a replacement.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return fail();
  }
  for (const character of value) {
    const point = character.charCodeAt(0);
    if (point <= 31 || (point >= 127 && point <= 159)) return fail();
  }
  const result = value.trim();
  if (!result.length || result.length > 200) return fail();
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) return fail();
  return value;
}

/** Registers the existing Brand catalogue namespace, not a Product or a publication. */
export function parseBrandCatalogSourceRegister(value: unknown) {
  const r = exact(value, ["profile", ...scopeFields, "operationReference", "code", "label"]);
  if (r.profile !== "BrandCatalogSourceRegisterV1") return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceRegisterV1" as const,
    ...scope(r),
    operationReference: parseCatalogReference(r.operationReference),
    code: parseCatalogCode(r.code),
    label: label(r.label),
  });
}
export type BrandCatalogSourceRegister = ReturnType<typeof parseBrandCatalogSourceRegister>;
export async function brandCatalogSourceIntentDigest(value: unknown) {
  return hash(await publicationValueDigest(parseBrandCatalogSourceRegister(value)));
}
export function parseBrandCatalogSourceResolve(value: unknown) {
  const r = exact(value, ["profile", ...scopeFields, "operationReference", "intentDigest"]);
  if (r.profile !== "BrandCatalogSourceResolveV1") return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceResolveV1" as const,
    ...scope(r),
    operationReference: parseCatalogReference(r.operationReference),
    intentDigest: hash(r.intentDigest),
  });
}
export type BrandCatalogSourceResolve = ReturnType<typeof parseBrandCatalogSourceResolve>;

export function parseBrandCatalogSourceRegisteredIdentity(value: unknown) {
  const r = exact(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "sourceReference",
    "code",
    "label",
    "registeredByReference",
    "operationReference",
    "auditReference",
    "registeredAt",
    "dataClassification",
  ]);
  if (
    r.profile !== "BrandCatalogSourceRegisteredIdentityV1" ||
    r.dataClassification !== "ConfigurationMetadata"
  )
    return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceRegisteredIdentityV1" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    sourceReference: parseCatalogReference(r.sourceReference),
    code: parseCatalogCode(r.code),
    label: label(r.label),
    registeredByReference: parseCatalogReference(r.registeredByReference),
    operationReference: parseCatalogReference(r.operationReference),
    auditReference: parseCatalogReference(r.auditReference),
    registeredAt: parseCatalogInstant(r.registeredAt),
    dataClassification: "ConfigurationMetadata" as const,
  });
}
export type BrandCatalogSourceRegisteredIdentity = ReturnType<
  typeof parseBrandCatalogSourceRegisteredIdentity
>;
const currentFields = [
  "profile",
  ...scopeFields,
  "source",
  "observedAt",
  "validUntil",
  "publicationStatus",
  "referenceEligibility",
] as const;
function current(r: Record<string, unknown>, reader: unknown, now: string) {
  const actualScope = scope(r),
    expectedScope = parseBrandCatalogSourceScope(reader),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil),
    at = parseCatalogInstant(now),
    source = r.source === null ? null : parseBrandCatalogSourceRegisteredIdentity(r.source);
  if (
    canonicalizeRfc8785(actualScope) !== canonicalizeRfc8785(expectedScope) ||
    r.publicationStatus !== "NotEvaluated" ||
    r.referenceEligibility !== "NotEvaluated" ||
    observedAt > at ||
    validUntil <= observedAt ||
    at >= validUntil ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    (source !== null &&
      (source.tenantReference !== actualScope.tenantReference ||
        source.brandReference !== actualScope.brandReference ||
        source.registeredAt > observedAt))
  )
    return fail();
  return Object.freeze({
    ...actualScope,
    source,
    observedAt,
    validUntil,
    publicationStatus: "NotEvaluated" as const,
    referenceEligibility: "NotEvaluated" as const,
  });
}
/** Current Reader authority must be supplied by the actual owner admission. Historical Actor stays historical. */
export function parseBrandCatalogSourceCurrent(
  value: unknown,
  reader: BrandCatalogSourceScope,
  now: string,
) {
  const r = exact(value, currentFields);
  if (r.profile !== "BrandCatalogSourceCurrentV1") return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceCurrentV1" as const,
    ...current(r, reader, now),
  });
}
export type BrandCatalogSourceCurrent = ReturnType<typeof parseBrandCatalogSourceCurrent>;
export function parseBrandCatalogSourceExact(
  value: unknown,
  reader: BrandCatalogSourceScope,
  requested: string,
  now: string,
) {
  const r = exact(value, [...currentFields, "requestedSourceReference"]),
    requestedSourceReference = parseCatalogReference(r.requestedSourceReference),
    expected = parseCatalogReference(requested);
  if (r.profile !== "BrandCatalogSourceExactV1" || requestedSourceReference !== expected)
    return fail();
  const result = current(r, reader, now);
  if (result.source !== null && result.source.sourceReference !== requestedSourceReference)
    return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceExactV1" as const,
    ...result,
    requestedSourceReference,
  });
}
export type BrandCatalogSourceExact = ReturnType<typeof parseBrandCatalogSourceExact>;

/** Abandoned retains the known scalar intent only; it cannot reconstruct an unknown command body. */
export async function parseBrandCatalogSourceReceipt(
  value: unknown,
  expected?: BrandCatalogSourceResolve,
) {
  const r = exact(value, [
    "profile",
    ...scopeFields,
    "operationReference",
    "intentDigest",
    "outcome",
    "originalCommand",
    "source",
    "auditReference",
    "occurredAt",
  ]);
  if (r.profile !== "BrandCatalogSourceReceiptV1") return fail();
  const receiptScope = scope(r),
    operationReference = parseCatalogReference(r.operationReference),
    intentDigest = hash(r.intentDigest),
    auditReference = parseCatalogReference(r.auditReference),
    occurredAt = parseCatalogInstant(r.occurredAt),
    body = {
      profile: "BrandCatalogSourceReceiptV1" as const,
      ...receiptScope,
      operationReference,
      intentDigest,
      auditReference,
      occurredAt,
    };
  if (
    expected &&
    (canonicalizeRfc8785(receiptScope) !==
      canonicalizeRfc8785(
        parseBrandCatalogSourceScope({
          tenantReference: expected.tenantReference,
          brandReference: expected.brandReference,
          actorReference: expected.actorReference,
        }),
      ) ||
      operationReference !== expected.operationReference ||
      intentDigest !== expected.intentDigest)
  )
    throw new BrandCatalogSourceClientError("Conflict");
  if (r.outcome === "Abandoned") {
    if (r.originalCommand !== null || r.source !== null) return fail();
    return Object.freeze({
      ...body,
      outcome: "Abandoned" as const,
      originalCommand: null,
      source: null,
    });
  }
  if (r.outcome !== "Committed") return fail();
  const originalCommand = parseBrandCatalogSourceRegister(r.originalCommand),
    source = parseBrandCatalogSourceRegisteredIdentity(r.source);
  if (
    originalCommand.tenantReference !== receiptScope.tenantReference ||
    originalCommand.brandReference !== receiptScope.brandReference ||
    originalCommand.actorReference !== receiptScope.actorReference ||
    originalCommand.operationReference !== operationReference ||
    (await brandCatalogSourceIntentDigest(originalCommand)) !== intentDigest ||
    source.tenantReference !== receiptScope.tenantReference ||
    source.brandReference !== receiptScope.brandReference ||
    source.registeredByReference !== receiptScope.actorReference ||
    source.operationReference !== operationReference ||
    source.code !== originalCommand.code ||
    source.label !== originalCommand.label ||
    source.auditReference !== auditReference ||
    source.registeredAt !== occurredAt
  )
    return fail();
  return Object.freeze({ ...body, outcome: "Committed" as const, originalCommand, source });
}
export type BrandCatalogSourceReceipt = Awaited<ReturnType<typeof parseBrandCatalogSourceReceipt>>;

export interface PreparedBrandCatalogSource {
  readonly command: BrandCatalogSourceRegister;
  readonly cursor: BrandCatalogSourceResolve;
}
interface RequestOptions {
  csrf: string;
  signal?: AbortSignal;
}
export function createMerchantBrandCatalogSourceClient(fetcher: typeof fetch = fetch) {
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
      const encoded = canonicalizeRfc8785(body);
      if (new TextEncoder().encode(encoded).length > 4096) return fail();
      sent = true;
      const response = await fetcher(`/merchant/organization/brands/catalog-source/${path}`, {
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
          if (bytes > (response.ok ? 32768 : 8192))
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
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      }
      return payload;
    } catch (error) {
      if (error instanceof BrandCatalogSourceClientError) throw error;
      return fail(sent && write ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  const now = () => new Date(Date.now()).toISOString();
  function fixed(value: BrandCatalogSourceScope) {
    return parseBrandCatalogSourceScope(value);
  }
  function finish(captured: number, options: RequestOptions) {
    if (captured !== epoch || options.signal?.aborted)
      throw new BrandCatalogSourceClientError("ScopeChanged");
  }
  return Object.freeze({
    invalidate,
    async current(scope: BrandCatalogSourceScope, options: RequestOptions) {
      const selected = fixed(scope),
        captured = epoch;
      const result = parseBrandCatalogSourceCurrent(
        await request("current", { brandReference: selected.brandReference }, options, false),
        selected,
        now(),
      );
      finish(captured, options);
      return result;
    },
    async exact(scope: BrandCatalogSourceScope, sourceReference: string, options: RequestOptions) {
      const selected = fixed(scope),
        reference = parseCatalogReference(sourceReference),
        captured = epoch;
      const result = parseBrandCatalogSourceExact(
        await request(
          "exact",
          { brandReference: selected.brandReference, sourceReference: reference },
          options,
          false,
        ),
        selected,
        reference,
        now(),
      );
      finish(captured, options);
      return result;
    },
    async prepare(
      scope: BrandCatalogSourceScope,
      value: { operationReference: string; code: string; label: string },
    ): Promise<PreparedBrandCatalogSource> {
      const captured = epoch,
        selected = fixed(scope),
        command = parseBrandCatalogSourceRegister({
          ...exact(value, ["operationReference", "code", "label"]),
          ...selected,
          profile: "BrandCatalogSourceRegisterV1",
        }),
        intentDigest = await brandCatalogSourceIntentDigest(command);
      if (captured !== epoch) throw new BrandCatalogSourceClientError("ScopeChanged");
      return Object.freeze({
        command,
        cursor: parseBrandCatalogSourceResolve({
          profile: "BrandCatalogSourceResolveV1",
          ...selected,
          operationReference: command.operationReference,
          intentDigest,
        }),
      });
    },
    async execute(prepared: PreparedBrandCatalogSource, options: RequestOptions) {
      const captured = epoch,
        command = parseBrandCatalogSourceRegister(prepared.command),
        cursor = parseBrandCatalogSourceResolve(prepared.cursor);
      if (
        (await brandCatalogSourceIntentDigest(command)) !== cursor.intentDigest ||
        command.operationReference !== cursor.operationReference ||
        command.tenantReference !== cursor.tenantReference ||
        command.brandReference !== cursor.brandReference ||
        command.actorReference !== cursor.actorReference
      )
        return fail();
      finish(captured, options);
      try {
        const result = await parseBrandCatalogSourceReceipt(
          await request(
            "register",
            {
              brandReference: command.brandReference,
              command: {
                operationReference: command.operationReference,
                code: command.code,
                label: command.label,
              },
            },
            options,
            true,
          ),
          cursor,
        );
        finish(captured, options);
        return result;
      } catch (e) {
        if (e instanceof BrandCatalogSourceClientError) throw e;
        throw new BrandCatalogSourceClientError("OutcomeUnknown");
      }
    },
    async resolve(value: BrandCatalogSourceResolve, options: RequestOptions) {
      const captured = epoch,
        cursor = parseBrandCatalogSourceResolve(value);
      try {
        const result = await parseBrandCatalogSourceReceipt(
          await request(
            "resolve",
            {
              brandReference: cursor.brandReference,
              original: {
                operationReference: cursor.operationReference,
                intentDigest: cursor.intentDigest,
              },
            },
            options,
            true,
          ),
          cursor,
        );
        finish(captured, options);
        return result;
      } catch (e) {
        if (e instanceof BrandCatalogSourceClientError) throw e;
        throw new BrandCatalogSourceClientError("OutcomeUnknown");
      }
    },
  });
}
