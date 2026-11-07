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
export const taxConfigurationReferenceSourceMaximumRows = 1000;
export const taxConfigurationReferenceSourceFields = Object.freeze([
  "configurationReference",
  "brandReference",
  "storeReference",
  "aggregateVersion",
  "currentVersionReference",
  "rootCreatedAt",
  "updatedAt",
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "lifecycle",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
  "ruleReference",
  "taxClassificationReference",
  "orderType",
  "chargeType",
  "taxComponentCode",
] as const);
export class TaxConfigurationReferenceSourceError extends Error {
  readonly code = "TAX_CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("tax configuration references are unavailable");
    this.name = "TaxConfigurationReferenceSourceError";
  }
}
const fail = (): never => {
  throw new TaxConfigurationReferenceSourceError();
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
        v.length > taxConfigurationReferenceSourceMaximumRows ||
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

export interface TaxConfigurationReferenceSourceRequest extends PriceBookReferenceSourceRequest {
  readonly storeReference: string;
}
export function parseTaxConfigurationReferenceSourceRequest(
  value: unknown,
): TaxConfigurationReferenceSourceRequest {
  try {
    const raw = exact(copy(value), [
        "purposeCode",
        "brandReference",
        "actorReference",
        "operationReference",
        "catalogIntentDigest",
        "storeReference",
      ]),
      { storeReference, ...pricing } = raw;
    return Object.freeze({
      ...parsePriceBookReferenceSourceRequest(pricing),
      storeReference: parsePricingReference(storeReference),
    });
  } catch {
    return fail();
  }
}
const rootFields = [
  "configurationReference",
  "brandReference",
  "storeReference",
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
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
  "rules",
] as const;
const ruleFields = [
  "ruleReference",
  "taxClassificationReference",
  "orderType",
  "chargeType",
  "taxComponentCode",
] as const;
export interface TaxConfigurationRootReference {
  readonly configurationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string | null;
  readonly rootCreatedAt: string;
  readonly updatedAt: string;
}
export interface TaxConfigurationRuleReference {
  readonly ruleReference: string;
  readonly taxClassificationReference: string;
  readonly orderType: "DineIn" | "Pickup";
  readonly chargeType: "Sellable" | "ServiceCharge" | "DeliveryFee" | "Tip";
  readonly taxComponentCode: string;
}
export interface TaxConfigurationVersionReference {
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly versionNumber: number;
  readonly snapshotDigest: string;
  readonly lifecycle: "Draft" | "Published";
  readonly timeZone: "America/Toronto";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly rules: readonly TaxConfigurationRuleReference[];
  readonly isCurrentVersion: boolean;
  readonly temporalStatus: "Future" | "Effective" | "Expired";
}
export interface TaxConfigurationReferenceSourceSnapshot {
  readonly request: TaxConfigurationReferenceSourceRequest;
  readonly profile: "TaxConfigurationRules";
  readonly scopeCoverage: "SelectedStoreOnly";
  readonly crossStoreCoverage: "Unavailable";
  readonly coverage: "Complete";
  readonly consistency: "StatementSnapshot";
  readonly observedAt: string;
  readonly digest: string;
  readonly roots: readonly TaxConfigurationRootReference[];
  readonly versions: readonly TaxConfigurationVersionReference[];
}
const positive = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) return fail();
  return v as number;
};
const optional = (v: unknown) => (v === null ? null : parsePricingReference(v));
/** Reference metadata only, not evidence validity, treatment or applicable tax. */
export function buildTaxConfigurationReferenceSourceSnapshot(
  value: unknown,
  input: TaxConfigurationReferenceSourceRequest,
  now: string,
): TaxConfigurationReferenceSourceSnapshot {
  try {
    const request = parseTaxConfigurationReferenceSourceRequest(input),
      raw = exact(copy(value), ["observedAt", "references"]),
      observedAt = parseEffectivePeriodInstant(raw.observedAt),
      at = parseEffectivePeriodInstant(now);
    if (
      !Array.isArray(raw.references) ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000
    )
      return fail();
    const roots = new Map<string, TaxConfigurationRootReference>(),
      versions = new Map<string, TaxConfigurationVersionReference>(),
      numbers = new Set<string>(),
      noVersion = new Set<string>(),
      ruleIds = new Set<string>();
    for (const entry of raw.references) {
      const row = exact(entry, ["root", "version", "precise"]);
      if (row.precise !== true) return fail();
      const r = exact(row.root, rootFields);
      const root: TaxConfigurationRootReference = Object.freeze({
        configurationReference: parsePricingReference(r.configurationReference),
        brandReference: parsePricingReference(r.brandReference),
        storeReference: parsePricingReference(r.storeReference),
        aggregateVersion: positive(r.aggregateVersion),
        currentVersionReference: optional(r.currentVersionReference),
        rootCreatedAt: parseEffectivePeriodInstant(r.rootCreatedAt),
        updatedAt: parseEffectivePeriodInstant(r.updatedAt),
      });
      if (
        root.brandReference !== request.brandReference ||
        root.storeReference !== request.storeReference ||
        root.rootCreatedAt > root.updatedAt ||
        root.updatedAt > observedAt
      )
        return fail();
      const previous = roots.get(root.configurationReference);
      if (previous && canonicalizeRfc8785(previous) !== canonicalizeRfc8785(root)) return fail();
      roots.set(root.configurationReference, root);
      if (row.version === null) {
        if (previous || root.currentVersionReference !== null) return fail();
        noVersion.add(root.configurationReference);
        continue;
      }
      if (noVersion.has(root.configurationReference)) return fail();
      const v = exact(row.version, versionFields),
        versionReference = parsePricingReference(v.versionReference),
        versionNumber = positive(v.versionNumber),
        createdAt = parseEffectivePeriodInstant(v.createdAt),
        effectiveFrom = parseEffectivePeriodInstant(v.effectiveFrom),
        effectiveUntil =
          v.effectiveUntil === null ? null : parseEffectivePeriodInstant(v.effectiveUntil);
      if (
        versions.has(versionReference) ||
        numbers.has(root.configurationReference + ":" + versionNumber) ||
        versionNumber > root.aggregateVersion ||
        createdAt < root.rootCreatedAt ||
        createdAt > root.updatedAt ||
        !["Draft", "Published"].includes(v.lifecycle as string) ||
        v.timeZone !== "America/Toronto" ||
        (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
        !Array.isArray(v.rules)
      )
        return fail();
      const qualifiers = new Set<string>();
      const rules = Object.freeze(
        v.rules
          .map((value) => {
            const r = exact(value, ruleFields),
              ruleReference = parsePricingReference(r.ruleReference),
              taxClassificationReference = parsePricingReference(r.taxClassificationReference),
              taxComponentCode = parsePricingCode(r.taxComponentCode),
              key =
                taxClassificationReference +
                ":" +
                String(r.orderType) +
                ":" +
                String(r.chargeType) +
                ":" +
                taxComponentCode;
            if (
              ruleIds.has(ruleReference) ||
              qualifiers.has(key) ||
              taxComponentCode !== r.taxComponentCode ||
              !["DineIn", "Pickup"].includes(r.orderType as string) ||
              !["Sellable", "ServiceCharge", "DeliveryFee", "Tip"].includes(r.chargeType as string)
            )
              return fail();
            ruleIds.add(ruleReference);
            qualifiers.add(key);
            return Object.freeze({
              ruleReference,
              taxClassificationReference,
              orderType: r.orderType as TaxConfigurationRuleReference["orderType"],
              chargeType: r.chargeType as TaxConfigurationRuleReference["chargeType"],
              taxComponentCode,
            });
          })
          .sort((a, b) => a.ruleReference.localeCompare(b.ruleReference)),
      );
      numbers.add(root.configurationReference + ":" + versionNumber);
      versions.set(
        versionReference,
        Object.freeze({
          configurationReference: root.configurationReference,
          versionReference,
          versionNumber,
          snapshotDigest: parsePricingDigest(v.snapshotDigest),
          lifecycle: v.lifecycle as "Draft" | "Published",
          timeZone: "America/Toronto",
          effectiveFrom,
          effectiveUntil,
          createdAt,
          rules,
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
        versions.get(r.currentVersionReference)?.configurationReference !== r.configurationReference
      )
        return fail();
    const content = {
      request,
      profile: "TaxConfigurationRules" as const,
      scopeCoverage: "SelectedStoreOnly" as const,
      crossStoreCoverage: "Unavailable" as const,
      roots: Object.freeze(
        [...roots.values()].sort((a, b) =>
          a.configurationReference.localeCompare(b.configurationReference),
        ),
      ),
      versions: Object.freeze(
        [...versions.values()].sort((a, b) => a.versionReference.localeCompare(b.versionReference)),
      ),
    };
    return Object.freeze({
      ...content,
      coverage: "Complete",
      consistency: "StatementSnapshot",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
    });
  } catch {
    return fail();
  }
}
export function parseTaxConfigurationReferenceSourceSnapshot(
  value: unknown,
  input: TaxConfigurationReferenceSourceRequest,
  now: string,
): TaxConfigurationReferenceSourceSnapshot {
  try {
    const raw = exact(copy(value), [
      "request",
      "profile",
      "scopeCoverage",
      "crossStoreCoverage",
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
        exact(v, [
          "configurationReference",
          ...versionFields,
          "isCurrentVersion",
          "temporalStatus",
        ]),
      );
    if (
      versions.some(
        (v) => !roots.some((r) => r.configurationReference === v.configurationReference),
      )
    )
      return fail();
    const references = roots.flatMap<unknown>((root) => {
      const own = versions.filter((v) => v.configurationReference === root.configurationReference);
      return own.length === 0
        ? [{ root, version: null, precise: true }]
        : own.map((v) => {
            const { configurationReference, isCurrentVersion, temporalStatus, ...version } = v;
            void configurationReference;
            void isCurrentVersion;
            void temporalStatus;
            return { root, version, precise: true };
          });
    });
    const result = buildTaxConfigurationReferenceSourceSnapshot(
      { observedAt: raw.observedAt, references },
      input,
      now,
    );
    if (canonicalizeRfc8785(result) !== canonicalizeRfc8785(raw)) return fail();
    return result;
  } catch {
    return fail();
  }
}
