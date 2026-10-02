import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../domain/money-tax-contract.js";
import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "./price-book-reference-source.js";
export const optionPriceReferenceSourceMaximumRows = 1000;
export const optionPriceReferenceSourceFields = Object.freeze([
  "ruleReference",
  "brandReference",
  "bindingReference",
  "optionReference",
  "aggregateVersion",
  "currentVersionReference",
  "rootCreatedAt",
  "updatedAt",
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "lifecycle",
  "skuReference",
  "scopeKind",
  "scopeReference",
  "channelCode",
  "orderType",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
] as const);
export class OptionPriceReferenceSourceError extends Error {
  readonly code = "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("option price references are unavailable");
    this.name = "OptionPriceReferenceSourceError";
  }
}
const fail = (): never => {
  throw new OptionPriceReferenceSourceError();
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
        v.length > optionPriceReferenceSourceMaximumRows ||
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

const rootFields = [
  "ruleReference",
  "brandReference",
  "bindingReference",
  "optionReference",
  "aggregateVersion",
  "currentVersionReference",
  "rootCreatedAt",
  "updatedAt",
] as const;
const versionFields = [
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "lifecycle",
  "skuReference",
  "scopeKind",
  "scopeReference",
  "channelCode",
  "orderType",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
] as const;
export interface OptionPriceRootReference {
  readonly ruleReference: string;
  readonly brandReference: string;
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly aggregateVersion: string;
  readonly currentVersionReference: string | null;
  readonly rootCreatedAt: string;
  readonly updatedAt: string;
}
export interface OptionPriceVersionReference {
  readonly ruleReference: string;
  readonly versionReference: string;
  readonly versionNumber: string;
  readonly snapshotDigest: string;
  readonly lifecycle: "Draft" | "Published" | "Archived";
  readonly skuReference: string | null;
  readonly scopeKind: "Brand" | "Region" | "StoreGroup" | "Store";
  readonly scopeReference: string | null;
  readonly channelCode: string | null;
  readonly orderType: "DineIn" | "Pickup" | null;
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly isCurrentVersion: boolean;
  readonly temporalStatus: "Future" | "Effective" | "Expired";
}
export interface OptionPriceReferenceSourceSnapshot {
  readonly request: PriceBookReferenceSourceRequest;
  readonly profile: "OptionPriceBindings";
  readonly consistency: "StatementSnapshot";
  readonly coverage: "Complete";
  readonly observedAt: string;
  readonly digest: string;
  readonly roots: readonly OptionPriceRootReference[];
  readonly versions: readonly OptionPriceVersionReference[];
}
const positive = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
};
const optional = (v: unknown) => (v === null ? null : parsePricingReference(v));
/** Complete owning bindings/history profile; foreign Catalog membership is never inferred. */
export function buildOptionPriceReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): OptionPriceReferenceSourceSnapshot {
  try {
    const request = parsePriceBookReferenceSourceRequest(input),
      raw = exact(copy(value), ["observedAt", "references"]),
      observedAt = parseEffectivePeriodInstant(raw.observedAt),
      at = parseEffectivePeriodInstant(now);
    if (
      !Array.isArray(raw.references) ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000
    )
      return fail();
    const roots = new Map<string, OptionPriceRootReference>(),
      versions = new Map<string, OptionPriceVersionReference>(),
      numbers = new Set<string>(),
      noVersion = new Set<string>();
    for (const rowValue of raw.references) {
      const row = exact(rowValue, ["root", "version", "precise"]);
      if (row.precise !== true) return fail();
      const r = exact(row.root, rootFields);
      const root: OptionPriceRootReference = Object.freeze({
        ruleReference: parsePricingReference(r.ruleReference),
        brandReference: parsePricingReference(r.brandReference),
        bindingReference: parsePricingReference(r.bindingReference),
        optionReference: parsePricingReference(r.optionReference),
        aggregateVersion: positive(r.aggregateVersion),
        currentVersionReference: optional(r.currentVersionReference),
        rootCreatedAt: parseEffectivePeriodInstant(r.rootCreatedAt),
        updatedAt: parseEffectivePeriodInstant(r.updatedAt),
      });
      if (
        root.brandReference !== request.brandReference ||
        root.rootCreatedAt > root.updatedAt ||
        root.updatedAt > observedAt
      )
        return fail();
      const previous = roots.get(root.ruleReference);
      if (previous && canonicalizeRfc8785(previous) !== canonicalizeRfc8785(root)) return fail();
      roots.set(root.ruleReference, root);
      if (row.version === null) {
        if (previous || root.currentVersionReference !== null) return fail();
        noVersion.add(root.ruleReference);
        continue;
      }
      if (noVersion.has(root.ruleReference)) return fail();
      const v = exact(row.version, versionFields),
        versionReference = parsePricingReference(v.versionReference),
        versionNumber = positive(v.versionNumber),
        createdAt = parseEffectivePeriodInstant(v.createdAt),
        effectiveFrom = parseEffectivePeriodInstant(v.effectiveFrom),
        effectiveUntil =
          v.effectiveUntil === null ? null : parseEffectivePeriodInstant(v.effectiveUntil),
        scopeReference = optional(v.scopeReference);
      if (
        versions.has(versionReference) ||
        numbers.has(root.ruleReference + ":" + versionNumber) ||
        BigInt(versionNumber) > BigInt(root.aggregateVersion) ||
        createdAt < root.rootCreatedAt ||
        createdAt > root.updatedAt ||
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
      numbers.add(root.ruleReference + ":" + versionNumber);
      versions.set(
        versionReference,
        Object.freeze({
          ruleReference: root.ruleReference,
          versionReference,
          versionNumber,
          snapshotDigest: parsePricingDigest(v.snapshotDigest),
          lifecycle: v.lifecycle as OptionPriceVersionReference["lifecycle"],
          skuReference: optional(v.skuReference),
          scopeKind: v.scopeKind as OptionPriceVersionReference["scopeKind"],
          scopeReference,
          channelCode: v.channelCode === null ? null : parsePricingCode(v.channelCode),
          orderType: v.orderType as OptionPriceVersionReference["orderType"],
          timeZone: v.timeZone,
          effectiveFrom,
          effectiveUntil,
          createdAt,
          isCurrentVersion: root.currentVersionReference === versionReference,
          temporalStatus:
            effectiveFrom > observedAt
              ? "Future"
              : effectiveUntil !== null && effectiveUntil <= observedAt
                ? "Expired"
                : "Effective",
        }),
      );
    }
    for (const r of roots.values())
      if (
        r.currentVersionReference !== null &&
        versions.get(r.currentVersionReference)?.ruleReference !== r.ruleReference
      )
        return fail();
    const source = {
      request,
      profile: "OptionPriceBindings" as const,
      roots: Object.freeze(
        [...roots.values()].sort((a, b) => a.ruleReference.localeCompare(b.ruleReference)),
      ),
      versions: Object.freeze(
        [...versions.values()].sort((a, b) => a.versionReference.localeCompare(b.versionReference)),
      ),
    };
    return Object.freeze({
      ...source,
      consistency: "StatementSnapshot",
      coverage: "Complete",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
    });
  } catch {
    return fail();
  }
}

/** Validate public roots/history and all computed fields against exact original opaque intent. */
export function parseOptionPriceReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): OptionPriceReferenceSourceSnapshot {
  try {
    const raw = exact(copy(value), [
      "request",
      "profile",
      "coverage",
      "consistency",
      "observedAt",
      "digest",
      "roots",
      "versions",
    ]);
    if (!Array.isArray(raw.roots) || !Array.isArray(raw.versions)) return fail();
    const roots = raw.roots.map((v) => exact(v, rootFields)),
      versions = raw.versions.map((v) =>
        exact(v, ["ruleReference", ...versionFields, "isCurrentVersion", "temporalStatus"]),
      );
    if (versions.some((v) => !roots.some((r) => r.ruleReference === v.ruleReference)))
      return fail();
    const references = roots.flatMap<unknown>((root) => {
      const owned = versions.filter((v) => v.ruleReference === root.ruleReference);
      return owned.length
        ? owned.map((v) => ({
            root,
            version: Object.fromEntries(versionFields.map((k) => [k, v[k]])),
            precise: true,
          }))
        : [{ root, version: null, precise: true }];
    });
    const parsed = buildOptionPriceReferenceSourceSnapshot(
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
