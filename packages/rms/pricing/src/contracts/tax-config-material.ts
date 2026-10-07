import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import { TaxConfigWorkflowError } from "../application/tax-config-service.js";
import {
  parseTaxConfigAuthoringScope,
  type TaxConfigAuthoringScope,
} from "./tax-config-authoring.js";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
  parseTaxRate,
  parseAmountMinor,
  type CurrencyMetadataSnapshot,
  type PricingReference,
  type PricingDigest,
} from "../domain/money-tax-contract.js";
import type { DraftTaxFixture, TaxFixtureSimulation } from "../domain/tax-fixture-simulation.js";
export type TaxConfigMaterialKind =
  "RegistrationApplicability" | "ProfessionalReport" | "FixtureSuite";
export interface TaxConfigMaterialTarget {
  readonly versionReference: PricingReference;
  readonly contentDigest: PricingDigest;
}
export interface TaxRegistrationApplicabilityMaterial {
  readonly operatingEntityProfileVersionReference: PricingReference;
  readonly operatingEntityTaxReference: PricingReference | null;
  readonly jurisdictionCode: "CA-ON";
  readonly applicability: "Applicable" | "NotApplicable";
  readonly sourceIssuedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly declaredSourceDigest: PricingDigest | null;
}
/** External declarations retained for review; neither identity nor conclusion is certified here. */
export interface TaxProfessionalReportMaterial {
  readonly targetPublicationCandidate: TaxConfigMaterialTarget;
  readonly registrationMaterial: TaxConfigMaterialTarget;
  readonly fixtureSuiteMaterial: TaxConfigMaterialTarget;
  readonly declaredIssuer: {
    readonly displayName: string;
    readonly organizationName: string | null;
    readonly credentialIdentifier: string | null;
  };
  readonly reviewedAt: string;
  readonly validUntil: string;
  readonly declaredConclusion: "Pass" | "Fail";
  readonly declaredSourceDigest: PricingDigest | null;
}
/** Declared expected outputs, not a mechanical comparison or an approved-coverage decision. */
export interface TaxFixtureSuiteMaterial {
  readonly targetPublicationCandidate: TaxConfigMaterialTarget;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly cases: readonly {
    readonly fixture: DraftTaxFixture;
    readonly expected: TaxFixtureSimulation;
  }[];
  readonly sourceIssuedAt: string;
  readonly declaredSourceDigest: PricingDigest | null;
}
export type TaxConfigMaterialContent =
  TaxRegistrationApplicabilityMaterial | TaxProfessionalReportMaterial | TaxFixtureSuiteMaterial;
export interface TaxConfigMaterialVersion {
  readonly profile: "TaxConfigMaterialVersionV1";
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly materialReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly revision: number;
  readonly previousVersionReference: PricingReference | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly content: TaxConfigMaterialContent;
  readonly contentDigest: PricingDigest;
  readonly recordedByActorReference: PricingReference;
  /** Material root creation time, retained across replacement revisions. */
  readonly createdAt: string;
  /** Actual recording time of this immutable revision. */ readonly recordedAt: string;
  readonly dataClassification: "Confidential";
  readonly status: "Recorded";
  readonly qualification: "NotEvaluated";
}
export interface TaxConfigMaterialCommand {
  readonly action: "CreateMaterial" | "ReplaceMaterial";
  readonly operationReference: PricingReference;
  readonly materialReference: PricingReference | null;
  readonly expectedRevision: number | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly content: TaxConfigMaterialContent;
}
export interface TaxConfigMaterialResolve extends Omit<TaxConfigMaterialCommand, "content"> {
  readonly intentDigest: PricingDigest;
}
export interface TaxConfigMaterialOperation extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigMaterialOperationV1";
  readonly action: TaxConfigMaterialCommand["action"];
  readonly operationReference: PricingReference;
  readonly materialReference: PricingReference | null;
  readonly expectedRevision: number | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly command: TaxConfigMaterialCommand | null;
  readonly intentDigest: PricingDigest;
  readonly outcome: "Committed" | "Abandoned";
  readonly version: TaxConfigMaterialVersion | null;
  readonly auditReference: PricingReference;
  readonly eventReference: PricingReference | null;
  readonly occurredAt: string;
}
export interface TaxConfigMaterialCurrent extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigMaterialCurrentV1";
  readonly materialReference: PricingReference | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly version: TaxConfigMaterialVersion | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export interface TaxConfigMaterialSummary {
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly materialReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly revision: number;
  readonly materialKind: TaxConfigMaterialKind;
  readonly contentDigest: PricingDigest;
  readonly recordedAt: string;
  readonly status: "Recorded";
  readonly qualification: "NotEvaluated";
}
export interface TaxConfigMaterialRoster extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigMaterialRosterV1";
  readonly materialKind: TaxConfigMaterialKind;
  readonly afterMaterial: PricingReference | null;
  readonly entries: readonly TaxConfigMaterialSummary[];
  readonly nextAfterMaterial: PricingReference | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export const taxConfigMaterialMaximumContentBytes = 1048576;
export const taxConfigMaterialRequiredFields = Object.freeze([
  "scope",
  "materialKind",
  "materialReference",
  "versionReference",
  "revision",
  "content",
  "contentDigest",
  "declaredIssuer",
  "targetPublicationCandidate",
  "originalOperation",
  "audit",
  "event",
] as const);
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const;
const invalid = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};
function normal<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((k) => typeof k !== "string" || !keys.includes(k))
  )
    return invalid();
  return Object.fromEntries(
    keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d?.enumerable || !("value" in d)) return invalid();
      return [k, d.value];
    }),
  );
}
function detached(value: unknown, bytes = taxConfigMaterialMaximumContentBytes): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 200000 || depth > 24) return invalid();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 16384 ? v : invalid();
    if (typeof v === "number") return Number.isFinite(v) ? v : invalid();
    if (!v || typeof v !== "object" || seen.has(v)) return invalid();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 4096 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return invalid();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return invalid();
            return copy(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype) return invalid();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((k) => {
            if (typeof k !== "string" || k === "__proto__") return invalid();
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (!d?.enumerable || !("value" in d)) return invalid();
            return [k, copy(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(canonicalizeRfc8785(result)).length > bytes) return invalid();
  return result;
}
const hash = (value: unknown) =>
  parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(value)));
const optionalRef = (value: unknown) => (value === null ? null : parsePricingReference(value));
const optionalHash = (value: unknown) => (value === null ? null : parsePricingDigest(value));
const instant = (value: unknown) => String(parseCanonicalInstant(value));
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
function kind(value: unknown): TaxConfigMaterialKind {
  if (
    value !== "RegistrationApplicability" &&
    value !== "ProfessionalReport" &&
    value !== "FixtureSuite"
  )
    return invalid();
  return value;
}
function target(value: unknown): TaxConfigMaterialTarget {
  const r = closed(value, ["versionReference", "contentDigest"]);
  return Object.freeze({
    versionReference: parsePricingReference(r.versionReference),
    contentDigest: parsePricingDigest(r.contentDigest),
  });
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > max ||
    /[\p{Cc}\p{Cf}<>]/u.test(value)
  )
    return invalid();
  return value;
}
function currency(value: unknown): CurrencyMetadataSnapshot {
  const r = closed(value, [
    "currencyCode",
    "minorUnitExponent",
    "metadataVersion",
    "metadataVersionReference",
    "metadataDigest",
  ]);
  if (typeof r.minorUnitExponent !== "number" || typeof r.metadataVersion !== "number")
    return invalid();
  return createCurrencyMetadataSnapshot({
    currencyCode: parseCurrencyCode(r.currencyCode),
    minorUnitExponent: r.minorUnitExponent,
    metadataVersion: r.metadataVersion,
    metadataVersionReference: parsePricingReference(r.metadataVersionReference),
    metadataDigest: parsePricingDigest(r.metadataDigest),
  });
}
function minor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u.test(value)
  )
    return invalid();
  parseAmountMinor(BigInt(value));
  return value;
}
function array(value: unknown, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  return value;
}
function fixture(value: unknown): DraftTaxFixture {
  const r = closed(value, ["profile", "fixtureReference", "kind", "evaluatedAt", "lines"]);
  if (r.profile !== "TaxDraftFixtureV1" || (r.kind !== "Basket" && r.kind !== "Refund"))
    return invalid();
  const fixtureReference = parsePricingReference(r.fixtureReference),
    ids = new Set<string>([fixtureReference]);
  const unique = (value: unknown) => {
    const ref = parsePricingReference(value);
    if (ids.has(ref)) return invalid();
    ids.add(ref);
    return ref;
  };
  const lines = array(r.lines, 1, 256).map((value) => {
    const l = closed(value, [
      "lineReference",
      "calculationReferences",
      "labelCode",
      "taxClassificationReference",
      "orderType",
      "chargeType",
      "amountMinor",
    ]);
    if (
      (l.orderType !== "DineIn" && l.orderType !== "Pickup") ||
      (l.chargeType !== "Sellable" &&
        l.chargeType !== "ServiceCharge" &&
        l.chargeType !== "DeliveryFee" &&
        l.chargeType !== "Tip")
    )
      return invalid();
    const amountMinor = minor(l.amountMinor);
    if (
      (r.kind === "Basket" && BigInt(amountMinor) < 0n) ||
      (r.kind === "Refund" && BigInt(amountMinor) > 0n)
    )
      return invalid();
    return Object.freeze({
      lineReference: unique(l.lineReference),
      calculationReferences: Object.freeze(array(l.calculationReferences, 1, 16).map(unique)),
      labelCode: parsePricingCode(l.labelCode),
      taxClassificationReference: parsePricingReference(l.taxClassificationReference),
      orderType: l.orderType,
      chargeType: l.chargeType,
      amountMinor,
    });
  });
  return Object.freeze({
    profile: "TaxDraftFixtureV1",
    fixtureReference,
    kind: r.kind,
    evaluatedAt: instant(r.evaluatedAt),
    lines: Object.freeze(lines),
  });
}
function expected(
  value: unknown,
  input: DraftTaxFixture,
  pin: TaxConfigMaterialTarget,
): TaxFixtureSimulation {
  const r = closed(value, [
    "fixtureReference",
    "kind",
    "configurationReference",
    "versionReference",
    "snapshotDigest",
    "netAmountMinor",
    "taxAmountMinor",
    "grossAmountMinor",
    "receiptPreview",
  ]);
  if (
    r.fixtureReference !== input.fixtureReference ||
    r.kind !== input.kind ||
    r.versionReference !== pin.versionReference ||
    r.snapshotDigest !== pin.contentDigest
  )
    return invalid();
  const netAmountMinor = minor(r.netAmountMinor),
    taxAmountMinor = minor(r.taxAmountMinor),
    grossAmountMinor = minor(r.grossAmountMinor);
  if (
    BigInt(netAmountMinor) + BigInt(taxAmountMinor) !== BigInt(grossAmountMinor) ||
    [netAmountMinor, taxAmountMinor, grossAmountMinor].some((v) =>
      input.kind === "Basket" ? BigInt(v) < 0n : BigInt(v) > 0n,
    )
  )
    return invalid();
  const components = new Set<string>(),
    receiptPreview = array(r.receiptPreview, 1, 4096).map((value) => {
      const p = closed(value, [
          "lineReference",
          "labelCode",
          "componentCode",
          "treatment",
          "rate",
          "taxAmountMinor",
        ]),
        lineReference = parsePricingReference(p.lineReference),
        line = input.lines.find((l) => l.lineReference === lineReference);
      if (
        !line ||
        p.labelCode !== line.labelCode ||
        (p.treatment !== "Taxable" && p.treatment !== "Exempt" && p.treatment !== "ZeroRated")
      )
        return invalid();
      const componentCode = parsePricingCode(p.componentCode),
        componentKey = lineReference + ":" + componentCode;
      if (components.has(componentKey)) return invalid();
      components.add(componentKey);
      const rate = parseTaxRate(p.rate);
      if (p.treatment !== "Taxable" && rate !== "0") return invalid();
      const componentTax = minor(p.taxAmountMinor);
      if (
        (input.kind === "Basket" ? BigInt(componentTax) < 0n : BigInt(componentTax) > 0n) ||
        (p.treatment !== "Taxable" && componentTax !== "0")
      )
        return invalid();
      return Object.freeze({
        lineReference,
        labelCode: line.labelCode,
        componentCode,
        treatment: p.treatment,
        rate,
        taxAmountMinor: componentTax,
      });
    });
  if (
    input.lines.some(
      (l) =>
        receiptPreview.filter((p) => p.lineReference === l.lineReference).length !==
        l.calculationReferences.length,
    ) ||
    receiptPreview.reduce((sum, p) => sum + BigInt(p.taxAmountMinor), 0n) !== BigInt(taxAmountMinor)
  )
    return invalid();
  return Object.freeze({
    fixtureReference: input.fixtureReference,
    kind: input.kind,
    configurationReference: parsePricingReference(r.configurationReference),
    versionReference: pin.versionReference,
    snapshotDigest: pin.contentDigest,
    netAmountMinor,
    taxAmountMinor,
    grossAmountMinor,
    receiptPreview: Object.freeze(receiptPreview),
  });
}
export function parseTaxConfigMaterialContent(
  value: unknown,
  materialKind: TaxConfigMaterialKind,
): TaxConfigMaterialContent {
  return normal(() => {
    const v = detached(value);
    kind(materialKind);
    if (materialKind === "RegistrationApplicability") {
      const r = closed(v, [
        "operatingEntityProfileVersionReference",
        "operatingEntityTaxReference",
        "jurisdictionCode",
        "applicability",
        "sourceIssuedAt",
        "effectiveFrom",
        "effectiveUntil",
        "declaredSourceDigest",
      ]);
      if (
        r.jurisdictionCode !== "CA-ON" ||
        (r.applicability !== "Applicable" && r.applicability !== "NotApplicable")
      )
        return invalid();
      const effectiveFrom = instant(r.effectiveFrom),
        effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
      if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return invalid();
      return Object.freeze({
        operatingEntityProfileVersionReference: parsePricingReference(
          r.operatingEntityProfileVersionReference,
        ),
        operatingEntityTaxReference:
          r.operatingEntityTaxReference === null
            ? null
            : parsePricingReference(r.operatingEntityTaxReference),
        jurisdictionCode: "CA-ON",
        applicability: r.applicability,
        sourceIssuedAt: instant(r.sourceIssuedAt),
        effectiveFrom,
        effectiveUntil,
        declaredSourceDigest: optionalHash(r.declaredSourceDigest),
      });
    }
    if (materialKind === "ProfessionalReport") {
      const r = closed(v, [
          "targetPublicationCandidate",
          "registrationMaterial",
          "fixtureSuiteMaterial",
          "declaredIssuer",
          "reviewedAt",
          "validUntil",
          "declaredConclusion",
          "declaredSourceDigest",
        ]),
        issuer = closed(r.declaredIssuer, [
          "displayName",
          "organizationName",
          "credentialIdentifier",
        ]);
      if (r.declaredConclusion !== "Pass" && r.declaredConclusion !== "Fail") return invalid();
      const reviewedAt = instant(r.reviewedAt),
        validUntil = instant(r.validUntil);
      if (validUntil <= reviewedAt) return invalid();
      return Object.freeze({
        targetPublicationCandidate: target(r.targetPublicationCandidate),
        registrationMaterial: target(r.registrationMaterial),
        fixtureSuiteMaterial: target(r.fixtureSuiteMaterial),
        declaredIssuer: Object.freeze({
          displayName: text(issuer.displayName, 120),
          organizationName:
            issuer.organizationName === null ? null : text(issuer.organizationName, 160),
          credentialIdentifier:
            issuer.credentialIdentifier === null ? null : text(issuer.credentialIdentifier, 120),
        }),
        reviewedAt,
        validUntil,
        declaredConclusion: r.declaredConclusion,
        declaredSourceDigest: optionalHash(r.declaredSourceDigest),
      });
    }
    const r = closed(v, [
        "targetPublicationCandidate",
        "currencyMetadata",
        "cases",
        "sourceIssuedAt",
        "declaredSourceDigest",
      ]),
      pin = target(r.targetPublicationCandidate);
    const cases = array(r.cases, 1, 256).map((value) => {
      const c = closed(value, ["fixture", "expected"]),
        input = fixture(c.fixture);
      return Object.freeze({ fixture: input, expected: expected(c.expected, input, pin) });
    });
    if (
      new Set(cases.map((c) => c.fixture.fixtureReference)).size !== cases.length ||
      new Set(cases.map((c) => c.expected.configurationReference)).size !== 1
    )
      return invalid();
    return Object.freeze({
      targetPublicationCandidate: pin,
      currencyMetadata: currency(r.currencyMetadata),
      cases: Object.freeze(cases),
      sourceIssuedAt: instant(r.sourceIssuedAt),
      declaredSourceDigest: optionalHash(r.declaredSourceDigest),
    });
  });
}
export function taxConfigMaterialContentDigest(
  value: unknown,
  materialKind: TaxConfigMaterialKind,
): PricingDigest {
  return hash(parseTaxConfigMaterialContent(value, materialKind));
}
function pins(r: Record<string, unknown>): Omit<TaxConfigMaterialCommand, "content"> {
  if (r.action !== "CreateMaterial" && r.action !== "ReplaceMaterial") return invalid();
  const materialReference = optionalRef(r.materialReference),
    expectedRevision = r.expectedRevision === null ? null : positive(r.expectedRevision);
  if (
    r.action === "CreateMaterial"
      ? materialReference !== null || expectedRevision !== null
      : materialReference === null || expectedRevision === null || expectedRevision === 2147483647
  )
    return invalid();
  return {
    action: r.action,
    operationReference: parsePricingReference(r.operationReference),
    materialReference,
    expectedRevision,
    materialKind: kind(r.materialKind),
  };
}
export function parseTaxConfigMaterialCommand(value: unknown): TaxConfigMaterialCommand {
  return normal(() => {
    const r = closed(detached(value, taxConfigMaterialMaximumContentBytes + 4096), [
        "action",
        "operationReference",
        "materialReference",
        "expectedRevision",
        "materialKind",
        "content",
      ]),
      p = pins(r);
    return Object.freeze({
      ...p,
      content: parseTaxConfigMaterialContent(r.content, p.materialKind),
    });
  });
}
export function parseTaxConfigMaterialResolve(value: unknown): TaxConfigMaterialResolve {
  return normal(() => {
    const r = closed(detached(value), [
      "action",
      "operationReference",
      "materialReference",
      "expectedRevision",
      "materialKind",
      "intentDigest",
    ]);
    return Object.freeze({ ...pins(r), intentDigest: parsePricingDigest(r.intentDigest) });
  });
}
export function taxConfigMaterialIntentDigest(scope: unknown, command: unknown): PricingDigest {
  return hash({
    scope: parseTaxConfigAuthoringScope(scope),
    command: parseTaxConfigMaterialCommand(command),
  });
}
export function parseTaxConfigMaterialVersion(value: unknown): TaxConfigMaterialVersion {
  return normal(() => {
    const r = closed(detached(value, taxConfigMaterialMaximumContentBytes + 4096), [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "materialReference",
      "versionReference",
      "revision",
      "previousVersionReference",
      "materialKind",
      "content",
      "contentDigest",
      "recordedByActorReference",
      "createdAt",
      "recordedAt",
      "dataClassification",
      "status",
      "qualification",
    ]);
    if (
      r.profile !== "TaxConfigMaterialVersionV1" ||
      r.dataClassification !== "Confidential" ||
      r.status !== "Recorded" ||
      r.qualification !== "NotEvaluated"
    )
      return invalid();
    const materialKind = kind(r.materialKind),
      content = parseTaxConfigMaterialContent(r.content, materialKind),
      contentDigest = parsePricingDigest(r.contentDigest),
      revision = positive(r.revision),
      previousVersionReference = optionalRef(r.previousVersionReference),
      versionReference = parsePricingReference(r.versionReference),
      createdAt = instant(r.createdAt),
      recordedAt = instant(r.recordedAt);
    if (
      contentDigest !== hash(content) ||
      (revision === 1) !== (previousVersionReference === null) ||
      previousVersionReference === versionReference ||
      recordedAt < createdAt ||
      (revision === 1 && recordedAt !== createdAt)
    )
      return invalid();
    const sourceAt = "reviewedAt" in content ? content.reviewedAt : content.sourceIssuedAt;
    if (sourceAt > recordedAt) return invalid();
    return Object.freeze({
      profile: "TaxConfigMaterialVersionV1",
      tenantReference: parsePricingReference(r.tenantReference),
      brandReference: parsePricingReference(r.brandReference),
      storeReference: parsePricingReference(r.storeReference),
      materialReference: parsePricingReference(r.materialReference),
      versionReference,
      revision,
      previousVersionReference,
      materialKind,
      content,
      contentDigest,
      recordedByActorReference: parsePricingReference(r.recordedByActorReference),
      createdAt,
      recordedAt,
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
  });
}
function scopeOf(r: Record<string, unknown>) {
  return parseTaxConfigAuthoringScope(Object.fromEntries(scopeKeys.map((k) => [k, r[k]])));
}
function matchesScope(
  v: Pick<TaxConfigMaterialSummary, "tenantReference" | "brandReference" | "storeReference">,
  s: TaxConfigAuthoringScope,
) {
  if (
    v.tenantReference !== s.tenantReference ||
    v.brandReference !== s.brandReference ||
    v.storeReference !== s.storeReference
  )
    return invalid();
}
export function parseTaxConfigMaterialOperation(value: unknown): TaxConfigMaterialOperation {
  return normal(() => {
    const r = closed(detached(value, 3 * taxConfigMaterialMaximumContentBytes), [
      "profile",
      ...scopeKeys,
      "action",
      "operationReference",
      "materialReference",
      "expectedRevision",
      "materialKind",
      "command",
      "intentDigest",
      "outcome",
      "version",
      "auditReference",
      "eventReference",
      "occurredAt",
    ]);
    if (
      r.profile !== "TaxConfigMaterialOperationV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const s = scopeOf(r),
      p = pins(r),
      intentDigest = parsePricingDigest(r.intentDigest),
      occurredAt = instant(r.occurredAt),
      command = r.command === null ? null : parseTaxConfigMaterialCommand(r.command),
      version = r.version === null ? null : parseTaxConfigMaterialVersion(r.version),
      eventReference = optionalRef(r.eventReference);
    if (
      r.outcome === "Abandoned"
        ? command !== null || version !== null || eventReference !== null
        : command === null || version === null || eventReference === null
    )
      return invalid();
    if (command !== null && version !== null) {
      if (
        canonicalizeRfc8785(p) !==
          canonicalizeRfc8785(
            pins(
              closed(command, [
                "action",
                "operationReference",
                "materialReference",
                "expectedRevision",
                "materialKind",
                "content",
              ]),
            ),
          ) ||
        intentDigest !== taxConfigMaterialIntentDigest(s, command)
      )
        return invalid();
      matchesScope(version, s);
      if (
        version.materialKind !== p.materialKind ||
        version.revision !== (p.expectedRevision ?? 0) + 1 ||
        version.recordedByActorReference !== s.actorReference ||
        version.recordedAt !== occurredAt ||
        (p.materialReference !== null && version.materialReference !== p.materialReference) ||
        (p.expectedRevision === null && version.previousVersionReference !== null) ||
        canonicalizeRfc8785(version.content) !== canonicalizeRfc8785(command.content)
      )
        return invalid();
    }
    return Object.freeze({
      profile: "TaxConfigMaterialOperationV1",
      ...s,
      ...p,
      command,
      intentDigest,
      outcome: r.outcome,
      version,
      auditReference: parsePricingReference(r.auditReference),
      eventReference,
      occurredAt,
    });
  });
}
function observation(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (
    validUntil <= observedAt ||
    Date.parse(validUntil) > Date.parse(observedAt) + 5000 ||
    r.qualification !== "NotEvaluated"
  )
    return invalid();
  return { observedAt, validUntil, qualification: "NotEvaluated" as const };
}
export function parseTaxConfigMaterialCurrent(value: unknown): TaxConfigMaterialCurrent {
  return normal(() => {
    const r = closed(detached(value, taxConfigMaterialMaximumContentBytes + 8192), [
      "profile",
      ...scopeKeys,
      "materialReference",
      "materialKind",
      "version",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (r.profile !== "TaxConfigMaterialCurrentV1") return invalid();
    const s = scopeOf(r),
      materialReference = optionalRef(r.materialReference),
      materialKind = kind(r.materialKind),
      version = r.version === null ? null : parseTaxConfigMaterialVersion(r.version),
      at = observation(r);
    if (version !== null) {
      matchesScope(version, s);
      if (
        version.materialReference !== materialReference ||
        version.materialKind !== materialKind ||
        version.recordedAt > at.observedAt
      )
        return invalid();
    }
    return Object.freeze({
      profile: "TaxConfigMaterialCurrentV1",
      ...s,
      materialReference,
      materialKind,
      version,
      ...at,
    });
  });
}
export function parseTaxConfigMaterialSummary(value: unknown): TaxConfigMaterialSummary {
  return normal(() => {
    const r = closed(detached(value, 4096), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "materialReference",
      "versionReference",
      "revision",
      "materialKind",
      "contentDigest",
      "recordedAt",
      "status",
      "qualification",
    ]);
    if (r.status !== "Recorded" || r.qualification !== "NotEvaluated") return invalid();
    return Object.freeze({
      tenantReference: parsePricingReference(r.tenantReference),
      brandReference: parsePricingReference(r.brandReference),
      storeReference: parsePricingReference(r.storeReference),
      materialReference: parsePricingReference(r.materialReference),
      versionReference: parsePricingReference(r.versionReference),
      revision: positive(r.revision),
      materialKind: kind(r.materialKind),
      contentDigest: parsePricingDigest(r.contentDigest),
      recordedAt: instant(r.recordedAt),
      status: "Recorded",
      qualification: "NotEvaluated",
    });
  });
}
export function parseTaxConfigMaterialRoster(value: unknown): TaxConfigMaterialRoster {
  return normal(() => {
    const r = closed(detached(value, 65536), [
      "profile",
      ...scopeKeys,
      "materialKind",
      "afterMaterial",
      "entries",
      "nextAfterMaterial",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (r.profile !== "TaxConfigMaterialRosterV1") return invalid();
    const s = scopeOf(r),
      materialKind = kind(r.materialKind),
      afterMaterial = optionalRef(r.afterMaterial),
      nextAfterMaterial = optionalRef(r.nextAfterMaterial),
      at = observation(r);
    let prior = afterMaterial;
    const entries = array(r.entries, 0, 50).map((value) => {
      const v = parseTaxConfigMaterialSummary(value);
      matchesScope(v, s);
      if (
        v.materialKind !== materialKind ||
        v.recordedAt > at.observedAt ||
        (prior !== null && v.materialReference <= prior)
      )
        return invalid();
      prior = v.materialReference;
      return v;
    });
    if (nextAfterMaterial !== null && (entries.length !== 50 || nextAfterMaterial !== prior))
      return invalid();
    return Object.freeze({
      profile: "TaxConfigMaterialRosterV1",
      ...s,
      materialKind,
      afterMaterial,
      entries: Object.freeze(entries),
      nextAfterMaterial,
      ...at,
    });
  });
}
