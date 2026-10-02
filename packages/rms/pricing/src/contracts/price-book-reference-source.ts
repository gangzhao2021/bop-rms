import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../domain/money-tax-contract.js";
export const priceBookReferenceSourceMaximumRows = 1000;
export const priceBookReferenceSourceFields = Object.freeze([
  "priceBookReference",
  "brandReference",
  "aggregateVersion",
  "currentVersionReference",
  "updatedAt",
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "lifecycle",
  "createdAt",
  "entryReference",
  "sellableReference",
  "scopeKind",
  "scopeReference",
  "channelCode",
  "orderType",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
] as const);
export class PriceBookReferenceSourceError extends Error {
  readonly code = "PRICE_BOOK_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("price book references are unavailable");
    this.name = "PriceBookReferenceSourceError";
  }
}
const fail = (): never => {
  throw new PriceBookReferenceSourceError();
};
function copy(value: unknown): unknown {
  let budget = 100000;
  const run = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 8) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 256) return fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return fail();
      return v;
    }
    if (!v || typeof v !== "object") return fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > priceBookReferenceSourceMaximumRows ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return fail();
        return run(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 32)
      return fail();
    return Object.fromEntries(
      Reflect.ownKeys(v).map((k) => {
        if (typeof k !== "string") return fail();
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d?.enumerable || !("value" in d)) return fail();
        return [k, run(d.value, depth + 1)];
      }),
    );
  };
  return run(value, 0);
}
function exact(v: unknown, keys: readonly string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v as Record<string, unknown>;
}
export interface PriceBookReferenceSourceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
export function parsePriceBookReferenceSourceRequest(
  value: unknown,
): PriceBookReferenceSourceRequest {
  try {
    const r = exact(copy(value), [
      "purposeCode",
      "brandReference",
      "actorReference",
      "operationReference",
      "catalogIntentDigest",
    ]);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_PRICING_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      brandReference: parsePricingReference(r.brandReference),
      actorReference: parsePricingReference(r.actorReference),
      operationReference: parsePricingReference(r.operationReference),
      catalogIntentDigest: parsePricingDigest(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}
export interface PriceBookReference {
  readonly priceBookReference: string;
  readonly brandReference: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string | null;
  readonly updatedAt: string;
  readonly versionReference: string;
  readonly versionNumber: number;
  readonly snapshotDigest: string;
  readonly lifecycle: "Draft" | "Published" | "Archived";
  readonly createdAt: string;
  readonly entryReference: string;
  readonly sellableReference: string;
  readonly scopeKind: "Brand" | "Region" | "StoreGroup" | "Store";
  readonly scopeReference: string | null;
  readonly channelCode: string | null;
  readonly orderType: "DineIn" | "Pickup" | null;
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly isCurrentVersion: boolean;
  readonly temporalStatus: "Future" | "Effective" | "Expired";
}
export interface PriceBookReferenceSourceSnapshot {
  readonly request: PriceBookReferenceSourceRequest;
  readonly profile: "PriceBookEntries";
  readonly consistency: "StatementSnapshot";
  readonly coverage: "Complete";
  readonly observedAt: string;
  readonly digest: string;
  readonly references: readonly PriceBookReference[];
}
/** Own configuration references only. Caller must resolve foreign targets through public owner contracts. */
export function buildPriceBookReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): PriceBookReferenceSourceSnapshot {
  try {
    const request = parsePriceBookReferenceSourceRequest(input),
      r = exact(copy(value), ["observedAt", "references"]),
      observedAt = parseEffectivePeriodInstant(r.observedAt),
      at = parseEffectivePeriodInstant(now);
    if (
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      !Array.isArray(r.references)
    )
      return fail();
    const roots = new Map<string, string>(),
      versions = new Map<string, string>(),
      seen = new Set<string>();
    const consistent = (map: Map<string, string>, key: string, data: unknown) => {
      const text = canonicalizeRfc8785(data),
        prior = map.get(key);
      if (prior !== undefined && prior !== text) return fail();
      map.set(key, text);
    };
    const positive = (v: unknown) => {
      if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647)
        return fail();
      return v as number;
    };
    const references = r.references
      .map((value) => {
        const row = exact(value, ["reference", "precise"]);
        if (row.precise !== true) return fail();
        const v = exact(row.reference, priceBookReferenceSourceFields),
          brandReference = parsePricingReference(v.brandReference),
          priceBookReference = parsePricingReference(v.priceBookReference),
          versionReference = parsePricingReference(v.versionReference),
          updatedAt = parseEffectivePeriodInstant(v.updatedAt),
          createdAt = parseEffectivePeriodInstant(v.createdAt),
          effectiveFrom = parseEffectivePeriodInstant(v.effectiveFrom),
          effectiveUntil =
            v.effectiveUntil === null ? null : parseEffectivePeriodInstant(v.effectiveUntil),
          currentVersionReference =
            v.currentVersionReference === null
              ? null
              : parsePricingReference(v.currentVersionReference),
          scopeReference =
            v.scopeReference === null ? null : parsePricingReference(v.scopeReference);
        if (
          brandReference !== request.brandReference ||
          updatedAt > observedAt ||
          createdAt > observedAt ||
          !["Draft", "Published", "Archived"].includes(v.lifecycle as string) ||
          !["Brand", "Region", "StoreGroup", "Store"].includes(v.scopeKind as string) ||
          (v.scopeKind === "Brand" ? scopeReference !== null : scopeReference === null) ||
          (v.orderType !== null && v.orderType !== "DineIn" && v.orderType !== "Pickup") ||
          typeof v.timeZone !== "string" ||
          v.timeZone.length < 1 ||
          v.timeZone.length > 100 ||
          (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
        )
          return fail();
        const zone = new Intl.DateTimeFormat("en-CA", { timeZone: v.timeZone }).resolvedOptions()
          .timeZone;
        if (zone.startsWith("+") || zone.startsWith("-")) return fail();
        const root = {
          priceBookReference,
          brandReference,
          aggregateVersion: positive(v.aggregateVersion),
          currentVersionReference,
          updatedAt,
        };
        const version = {
          priceBookReference,
          versionReference,
          versionNumber: positive(v.versionNumber),
          snapshotDigest: parsePricingDigest(v.snapshotDigest),
          lifecycle: v.lifecycle as PriceBookReference["lifecycle"],
          createdAt,
        };
        consistent(roots, priceBookReference, root);
        consistent(versions, versionReference, version);
        const entryReference = parsePricingReference(v.entryReference);
        if (seen.has(entryReference)) return fail();
        seen.add(entryReference);
        return Object.freeze({
          ...root,
          ...version,
          entryReference,
          sellableReference: parsePricingReference(v.sellableReference),
          scopeKind: v.scopeKind as PriceBookReference["scopeKind"],
          scopeReference,
          channelCode: v.channelCode === null ? null : parsePricingCode(v.channelCode),
          orderType: v.orderType as PriceBookReference["orderType"],
          timeZone: v.timeZone,
          effectiveFrom,
          effectiveUntil,
          isCurrentVersion: currentVersionReference === versionReference,
          temporalStatus:
            effectiveFrom > observedAt
              ? ("Future" as const)
              : effectiveUntil !== null && effectiveUntil <= observedAt
                ? ("Expired" as const)
                : ("Effective" as const),
        });
      })
      .sort((a, b) => a.entryReference.localeCompare(b.entryReference));
    const source = {
      request,
      profile: "PriceBookEntries" as const,
      references: Object.freeze(references),
    };
    return Object.freeze({
      ...source,
      coverage: "Complete",
      consistency: "StatementSnapshot",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
    });
  } catch {
    return fail();
  }
}

/** Validate complete public source, including derived fields and original intent; never a grant. */
export function parsePriceBookReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): PriceBookReferenceSourceSnapshot {
  try {
    const raw = exact(copy(value), [
      "request",
      "profile",
      "consistency",
      "coverage",
      "observedAt",
      "digest",
      "references",
    ]);
    if (!Array.isArray(raw.references)) return fail();
    const references = raw.references.map((value) => {
      const r = exact(value, [
        ...priceBookReferenceSourceFields,
        "isCurrentVersion",
        "temporalStatus",
      ]);
      return {
        reference: Object.fromEntries(priceBookReferenceSourceFields.map((k) => [k, r[k]])),
        precise: true,
      };
    });
    const parsed = buildPriceBookReferenceSourceSnapshot(
      { observedAt: raw.observedAt, references },
      input,
      now,
    );
    if (canonicalizeRfc8785(parsed) !== canonicalizeRfc8785(raw)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}
