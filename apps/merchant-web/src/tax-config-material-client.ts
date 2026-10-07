import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as hashValue,
} from "./product-publication-command-client-v2.js";
import { parseStoreSetupScope, type StoreSetupScope } from "./store-setup-client.js";
import {
  parseTaxConfigDraftFixture,
  type TaxConfigDraftFixture,
  TaxConfigAuthoringClientError,
} from "./tax-config-authoring-client.js";
export { TaxConfigAuthoringClientError as TaxConfigMaterialClientError } from "./tax-config-authoring-client.js";
const fail = (code: TaxConfigAuthoringClientError["code"] = "Invalid"): never => {
  throw new TaxConfigAuthoringClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof TaxConfigAuthoringClientError) throw e;
    return fail();
  }
}
async function digest(value: unknown): Promise<string> {
  try {
    return await hashValue(value);
  } catch {
    return fail("Unavailable");
  }
}
const scopeKeys = ["tenantReference", "brandReference", "storeReference", "actorReference"];
const optionalRef = (value: unknown) => (value === null ? null : ref(value));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const integer = (v: unknown, min = 1, max = 2147483647) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
function choice<const T extends string>(v: unknown, choices: readonly T[]): T {
  for (const c of choices) if (c === v) return c;
  return fail();
}
function copy(value: unknown, maximumBytes = 65536): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 300000 || depth > 16) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 16384 ? v : fail();
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 4096 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return fail();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return fail();
            return visit(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
        return fail();
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (typeof key !== "string" || key === "__proto__" || !d?.enumerable || !("value" in d))
          return fail();
        result[key] = visit(d.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(v);
    }
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(canonical(result)).length > maximumBytes) return fail();
  return result;
}
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope(Object.fromEntries(scopeKeys.map((key) => [key, r[key]])));
export type TaxConfigMaterialKind =
  "RegistrationApplicability" | "ProfessionalReport" | "FixtureSuite";
export interface TaxRegistrationApplicabilityMaterial {
  readonly operatingEntityProfileVersionReference: string;
  readonly operatingEntityTaxReference: string | null;
  readonly jurisdictionCode: "CA-ON";
  readonly applicability: "Applicable" | "NotApplicable";
  readonly sourceIssuedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly declaredSourceDigest: string | null;
}
interface Target {
  readonly versionReference: string;
  readonly contentDigest: string;
}
export interface TaxProfessionalReportMaterial {
  readonly targetPublicationCandidate: Target;
  readonly registrationMaterial: Target;
  readonly fixtureSuiteMaterial: Target;
  readonly declaredIssuer: {
    readonly displayName: string;
    readonly organizationName: string | null;
    readonly credentialIdentifier: string | null;
  };
  readonly reviewedAt: string;
  readonly validUntil: string;
  readonly declaredConclusion: "Pass" | "Fail";
  readonly declaredSourceDigest: string | null;
}
export interface TaxFixtureSuiteMaterial {
  readonly targetPublicationCandidate: Target;
  readonly currencyMetadata: {
    readonly currencyCode: string;
    readonly minorUnitExponent: number;
    readonly metadataVersion: number;
    readonly metadataVersionReference: string;
    readonly metadataDigest: string;
  };
  readonly cases: readonly {
    readonly fixture: TaxConfigDraftFixture;
    readonly expected: TaxFixtureSuiteExpected;
  }[];
  readonly sourceIssuedAt: string;
  readonly declaredSourceDigest: string | null;
}
export interface TaxFixtureSuiteExpected {
  readonly fixtureReference: string;
  readonly kind: "Basket" | "Refund";
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly snapshotDigest: string;
  readonly netAmountMinor: string;
  readonly taxAmountMinor: string;
  readonly grossAmountMinor: string;
  readonly receiptPreview: readonly {
    readonly lineReference: string;
    readonly labelCode: string;
    readonly componentCode: string;
    readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
    readonly rate: string;
    readonly taxAmountMinor: string;
  }[];
}
export type TaxConfigMaterialContent =
  TaxRegistrationApplicabilityMaterial | TaxProfessionalReportMaterial | TaxFixtureSuiteMaterial;
const kind = (v: unknown) =>
  choice(v, ["RegistrationApplicability", "ProfessionalReport", "FixtureSuite"]);
const text = (v: unknown, max: number) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  v.trim() === v &&
  !Array.from(v).some(
    (character) =>
      character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127 ||
      character === "<" ||
      character === ">",
  )
    ? v
    : fail();
const optionalHash = (v: unknown) => (v === null ? null : hash(v));
function target(value: unknown): Target {
  const r = record(value, ["versionReference", "contentDigest"]);
  return Object.freeze({
    versionReference: ref(r.versionReference),
    contentDigest: hash(r.contentDigest),
  });
}
function suiteArray(v: unknown, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) return fail();
  return v;
}
const suiteMinor = (v: unknown) => {
  if (typeof v !== "string" || v.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/u.test(v)) return fail();
  const n = BigInt(v);
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) return fail();
  return v;
};
const suiteCode = (v: unknown) =>
  typeof v === "string" && v.length <= 64 && /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*$/u.test(v)
    ? v
    : fail();
function suiteExpected(
  value: unknown,
  input: TaxConfigDraftFixture,
  pin: Target,
): TaxFixtureSuiteExpected {
  const r = record(value, [
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
    return fail();
  const netAmountMinor = suiteMinor(r.netAmountMinor),
    taxAmountMinor = suiteMinor(r.taxAmountMinor),
    grossAmountMinor = suiteMinor(r.grossAmountMinor);
  const signed = (v: string) => (input.kind === "Basket" ? BigInt(v) >= 0n : BigInt(v) <= 0n);
  if (
    BigInt(netAmountMinor) + BigInt(taxAmountMinor) !== BigInt(grossAmountMinor) ||
    ![netAmountMinor, taxAmountMinor, grossAmountMinor].every(signed)
  )
    return fail();
  const components = new Set<string>();
  const receiptPreview = suiteArray(r.receiptPreview, 1, 4096).map((value) => {
    const p = record(value, [
        "lineReference",
        "labelCode",
        "componentCode",
        "treatment",
        "rate",
        "taxAmountMinor",
      ]),
      lineReference = ref(p.lineReference),
      line = input.lines.find((l) => l.lineReference === lineReference),
      componentCode = suiteCode(p.componentCode),
      componentKey = lineReference + ":" + componentCode;
    if (!line || p.labelCode !== line.labelCode || components.has(componentKey)) return fail();
    components.add(componentKey);
    const treatment = choice(p.treatment, ["Taxable", "Exempt", "ZeroRated"]),
      rate =
        typeof p.rate === "string" && /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,11}[1-9])?$/u.test(p.rate)
          ? p.rate
          : fail(),
      tax = suiteMinor(p.taxAmountMinor);
    if (!signed(tax) || (treatment !== "Taxable" && (rate !== "0" || tax !== "0"))) return fail();
    return Object.freeze({
      lineReference,
      labelCode: line.labelCode,
      componentCode,
      treatment,
      rate,
      taxAmountMinor: tax,
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
    return fail();
  return Object.freeze({
    fixtureReference: input.fixtureReference,
    kind: input.kind,
    configurationReference: ref(r.configurationReference),
    versionReference: pin.versionReference,
    snapshotDigest: pin.contentDigest,
    netAmountMinor,
    taxAmountMinor,
    grossAmountMinor,
    receiptPreview: Object.freeze(receiptPreview),
  });
}
function suiteContent(v: unknown): TaxFixtureSuiteMaterial {
  const r = record(v, [
      "targetPublicationCandidate",
      "currencyMetadata",
      "cases",
      "sourceIssuedAt",
      "declaredSourceDigest",
    ]),
    pin = target(r.targetPublicationCandidate),
    c = record(r.currencyMetadata, [
      "currencyCode",
      "minorUnitExponent",
      "metadataVersion",
      "metadataVersionReference",
      "metadataDigest",
    ]);
  if (typeof c.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(c.currencyCode)) return fail();
  const currencyMetadata = Object.freeze({
    currencyCode: c.currencyCode,
    minorUnitExponent: integer(c.minorUnitExponent, 0, 6),
    metadataVersion: integer(c.metadataVersion, 1, Number.MAX_SAFE_INTEGER),
    metadataVersionReference: ref(c.metadataVersionReference),
    metadataDigest: hash(c.metadataDigest),
  });
  const cases = suiteArray(r.cases, 1, 256).map((value) => {
    const item = record(value, ["fixture", "expected"]),
      fixture = parseTaxConfigDraftFixture(item.fixture);
    return Object.freeze({ fixture, expected: suiteExpected(item.expected, fixture, pin) });
  });
  if (
    new Set(cases.map((c) => c.fixture.fixtureReference)).size !== cases.length ||
    new Set(cases.map((c) => c.expected.configurationReference)).size !== 1
  )
    return fail();
  return Object.freeze({
    targetPublicationCandidate: pin,
    currencyMetadata,
    cases: Object.freeze(cases),
    sourceIssuedAt: instant(r.sourceIssuedAt),
    declaredSourceDigest: optionalHash(r.declaredSourceDigest),
  });
}

export function parseTaxConfigMaterialContent(
  value: unknown,
  materialKind: TaxConfigMaterialKind,
): TaxConfigMaterialContent {
  return safe(() => {
    const v = copy(value, 1048576);
    kind(materialKind);
    if (materialKind === "RegistrationApplicability") {
      const r = record(v, [
        "operatingEntityProfileVersionReference",
        "operatingEntityTaxReference",
        "jurisdictionCode",
        "applicability",
        "sourceIssuedAt",
        "effectiveFrom",
        "effectiveUntil",
        "declaredSourceDigest",
      ]);
      if (r.jurisdictionCode !== "CA-ON") return fail();
      const effectiveFrom = instant(r.effectiveFrom),
        effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
      if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return fail();
      return Object.freeze({
        operatingEntityProfileVersionReference: ref(r.operatingEntityProfileVersionReference),
        operatingEntityTaxReference: optionalRef(r.operatingEntityTaxReference),
        jurisdictionCode: "CA-ON",
        applicability: choice(r.applicability, ["Applicable", "NotApplicable"]),
        sourceIssuedAt: instant(r.sourceIssuedAt),
        effectiveFrom,
        effectiveUntil,
        declaredSourceDigest: optionalHash(r.declaredSourceDigest),
      });
    }
    if (materialKind === "FixtureSuite") return suiteContent(v);
    const r = record(v, [
        "targetPublicationCandidate",
        "registrationMaterial",
        "fixtureSuiteMaterial",
        "declaredIssuer",
        "reviewedAt",
        "validUntil",
        "declaredConclusion",
        "declaredSourceDigest",
      ]),
      i = record(r.declaredIssuer, ["displayName", "organizationName", "credentialIdentifier"]),
      reviewedAt = instant(r.reviewedAt),
      validUntil = instant(r.validUntil);
    if (validUntil <= reviewedAt) return fail();
    return Object.freeze({
      targetPublicationCandidate: target(r.targetPublicationCandidate),
      registrationMaterial: target(r.registrationMaterial),
      fixtureSuiteMaterial: target(r.fixtureSuiteMaterial),
      declaredIssuer: Object.freeze({
        displayName: text(i.displayName, 120),
        organizationName: i.organizationName === null ? null : text(i.organizationName, 160),
        credentialIdentifier:
          i.credentialIdentifier === null ? null : text(i.credentialIdentifier, 120),
      }),
      reviewedAt,
      validUntil,
      declaredConclusion: choice(r.declaredConclusion, ["Pass", "Fail"]),
      declaredSourceDigest: optionalHash(r.declaredSourceDigest),
    });
  });
}
export interface TaxConfigMaterialComparisonCommand {
  readonly configurationReference: string;
  readonly targetPublicationCandidate: Target;
  readonly fixtureSuiteMaterial: Target & { readonly materialReference: string };
}
const comparisonFields = [
  "fixtureReference",
  "kind",
  "configurationReference",
  "versionReference",
  "snapshotDigest",
  "netAmountMinor",
  "taxAmountMinor",
  "grossAmountMinor",
  "receiptPreview",
] as const;
export type TaxConfigMaterialComparisonField = (typeof comparisonFields)[number];
export interface TaxConfigMaterialComparison extends StoreSetupScope {
  readonly profile: "TaxConfigMaterialComparisonV1";
  readonly comparison: {
    readonly profile: "TaxConfigCandidateFixtureComparisonV1";
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly candidate: Target;
    readonly suite: Target & { readonly materialReference: string };
    readonly cases: readonly {
      readonly fixtureReference: string;
      readonly matches: boolean;
      readonly actualDigest: string;
      readonly expectedDigest: string;
      readonly mismatchedFields: readonly TaxConfigMaterialComparisonField[];
    }[];
    readonly allCasesMatched: boolean;
    readonly professionalReviewStatus: "NotEvaluated";
    readonly legalConclusion: "NotEvaluated";
  };
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
export function parseTaxConfigMaterialComparisonCommand(
  value: unknown,
): TaxConfigMaterialComparisonCommand {
  return safe(() => {
    const r = record(copy(value, 8192), [
        "configurationReference",
        "targetPublicationCandidate",
        "fixtureSuiteMaterial",
      ]),
      suite = record(r.fixtureSuiteMaterial, [
        "materialReference",
        "versionReference",
        "contentDigest",
      ]);
    return Object.freeze({
      configurationReference: ref(r.configurationReference),
      targetPublicationCandidate: target(r.targetPublicationCandidate),
      fixtureSuiteMaterial: Object.freeze({
        materialReference: ref(suite.materialReference),
        versionReference: ref(suite.versionReference),
        contentDigest: hash(suite.contentDigest),
      }),
    });
  });
}
export function parseTaxConfigMaterialComparison(
  value: unknown,
  scope: StoreSetupScope,
  expected: TaxConfigMaterialComparisonCommand,
): TaxConfigMaterialComparison {
  return safe(() => {
    const r = record(copy(value, 1048576), [
        "profile",
        ...scopeKeys,
        "comparison",
        "observedAt",
        "validUntil",
        "referenceEligibility",
      ]),
      s = scoped(r, scope),
      w = window(r),
      command = parseTaxConfigMaterialComparisonCommand(expected),
      c = record(r.comparison, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "candidate",
        "suite",
        "cases",
        "allCasesMatched",
        "professionalReviewStatus",
        "legalConclusion",
      ]),
      suite = record(c.suite, ["materialReference", "versionReference", "contentDigest"]),
      candidate = target(c.candidate),
      suitePin = Object.freeze({
        materialReference: ref(suite.materialReference),
        versionReference: ref(suite.versionReference),
        contentDigest: hash(suite.contentDigest),
      });
    if (
      r.profile !== "TaxConfigMaterialComparisonV1" ||
      r.referenceEligibility !== "NotEvaluated" ||
      c.profile !== "TaxConfigCandidateFixtureComparisonV1" ||
      c.tenantReference !== s.tenantReference ||
      c.brandReference !== s.brandReference ||
      c.storeReference !== s.storeReference ||
      c.professionalReviewStatus !== "NotEvaluated" ||
      c.legalConclusion !== "NotEvaluated" ||
      !same(candidate, command.targetPublicationCandidate) ||
      !same(suitePin, command.fixtureSuiteMaterial) ||
      typeof c.allCasesMatched !== "boolean"
    )
      return fail();
    const used = new Set<string>(),
      cases = suiteArray(c.cases, 1, 256).map((value) => {
        const v = record(value, [
            "fixtureReference",
            "matches",
            "actualDigest",
            "expectedDigest",
            "mismatchedFields",
          ]),
          fixtureReference = ref(v.fixtureReference),
          actualDigest = hash(v.actualDigest),
          expectedDigest = hash(v.expectedDigest);
        if (used.has(fixtureReference) || typeof v.matches !== "boolean") return fail();
        used.add(fixtureReference);
        let previous = -1;
        const mismatchedFields = suiteArray(v.mismatchedFields, 0, 9).map((value) => {
          const field = choice(value, comparisonFields),
            index = comparisonFields.indexOf(field);
          if (index <= previous) return fail();
          previous = index;
          return field;
        });
        if (
          v.matches !== (mismatchedFields.length === 0) ||
          v.matches !== (actualDigest === expectedDigest)
        )
          return fail();
        return Object.freeze({
          fixtureReference,
          matches: v.matches,
          actualDigest,
          expectedDigest,
          mismatchedFields: Object.freeze(mismatchedFields),
        });
      });
    if (c.allCasesMatched !== cases.every((v) => v.matches)) return fail();
    return Object.freeze({
      profile: "TaxConfigMaterialComparisonV1",
      ...s,
      comparison: Object.freeze({
        profile: "TaxConfigCandidateFixtureComparisonV1",
        tenantReference: s.tenantReference,
        brandReference: s.brandReference,
        storeReference: s.storeReference,
        candidate,
        suite: suitePin,
        cases: Object.freeze(cases),
        allCasesMatched: c.allCasesMatched,
        professionalReviewStatus: "NotEvaluated",
        legalConclusion: "NotEvaluated",
      }),
      ...w,
      referenceEligibility: "NotEvaluated",
    });
  });
}
export interface TaxConfigMaterialCommand {
  readonly action: "CreateMaterial" | "ReplaceMaterial";
  readonly operationReference: string;
  readonly materialReference: string | null;
  readonly expectedRevision: number | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly content: TaxConfigMaterialContent;
}
export interface TaxConfigMaterialResolve extends Omit<TaxConfigMaterialCommand, "content"> {
  readonly intentDigest: string;
}
export interface TaxConfigMaterialCursor extends TaxConfigMaterialResolve {
  readonly profile: "TaxConfigMaterialPendingOriginalV1";
  readonly scope: StoreSetupScope;
}
export interface PreparedTaxConfigMaterialCommand {
  readonly scope: StoreSetupScope;
  readonly command: TaxConfigMaterialCommand;
  readonly intentDigest: string;
  readonly cursor: TaxConfigMaterialCursor;
}
function pins(r: Record<string, unknown>): Omit<TaxConfigMaterialCommand, "content"> {
  const action = choice(r.action, ["CreateMaterial", "ReplaceMaterial"]),
    materialReference = optionalRef(r.materialReference),
    expectedRevision =
      r.expectedRevision === null ? null : integer(r.expectedRevision, 1, 2147483646);
  if (
    action === "CreateMaterial"
      ? materialReference !== null || expectedRevision !== null
      : materialReference === null || expectedRevision === null
  )
    return fail();
  return Object.freeze({
    action,
    operationReference: ref(r.operationReference),
    materialReference,
    expectedRevision,
    materialKind: kind(r.materialKind),
  });
}
export function parseTaxConfigMaterialCommand(value: unknown): TaxConfigMaterialCommand {
  return safe(() => {
    const r = record(copy(value, 1052672), [
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
  return safe(() => {
    const r = record(copy(value), [
      "action",
      "operationReference",
      "materialReference",
      "expectedRevision",
      "materialKind",
      "intentDigest",
    ]);
    return Object.freeze({ ...pins(r), intentDigest: hash(r.intentDigest) });
  });
}
export function parseTaxConfigMaterialCursor(value: unknown): TaxConfigMaterialCursor {
  return safe(() => {
    const r = record(copy(value), [
      "profile",
      "scope",
      "action",
      "operationReference",
      "materialReference",
      "expectedRevision",
      "materialKind",
      "intentDigest",
    ]);
    if (r.profile !== "TaxConfigMaterialPendingOriginalV1") return fail();
    return Object.freeze({
      profile: "TaxConfigMaterialPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
export interface TaxConfigMaterialVersion {
  readonly profile: "TaxConfigMaterialVersionV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly materialReference: string;
  readonly versionReference: string;
  readonly revision: number;
  readonly previousVersionReference: string | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly content: TaxConfigMaterialContent;
  readonly contentDigest: string;
  readonly recordedByActorReference: string;
  readonly createdAt: string;
  readonly recordedAt: string;
  readonly dataClassification: "Confidential";
  readonly status: "Recorded";
  readonly qualification: "NotEvaluated";
}
export function parseTaxConfigMaterialVersion(value: unknown): TaxConfigMaterialVersion {
  return safe(() => {
    const r = record(copy(value, 1052672), [
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
      return fail();
    const materialKind = kind(r.materialKind),
      content = parseTaxConfigMaterialContent(r.content, materialKind),
      revision = integer(r.revision),
      previousVersionReference = optionalRef(r.previousVersionReference),
      versionReference = ref(r.versionReference),
      createdAt = instant(r.createdAt),
      recordedAt = instant(r.recordedAt);
    if (
      (revision === 1) !== (previousVersionReference === null) ||
      previousVersionReference === versionReference ||
      recordedAt < createdAt ||
      (revision === 1 && recordedAt !== createdAt) ||
      ("reviewedAt" in content ? content.reviewedAt : content.sourceIssuedAt) > recordedAt
    )
      return fail();
    return Object.freeze({
      profile: "TaxConfigMaterialVersionV1",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      materialReference: ref(r.materialReference),
      versionReference,
      revision,
      previousVersionReference,
      materialKind,
      content,
      contentDigest: hash(r.contentDigest),
      recordedByActorReference: ref(r.recordedByActorReference),
      createdAt,
      recordedAt,
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
  });
}
export async function validateTaxConfigMaterialVersion(
  value: unknown,
): Promise<TaxConfigMaterialVersion> {
  const v = parseTaxConfigMaterialVersion(value);
  if ((await digest(v.content)) !== v.contentDigest) return fail();
  return v;
}
function matchesScope(
  v: { tenantReference: string; brandReference: string; storeReference: string },
  s: StoreSetupScope,
) {
  if (
    v.tenantReference !== s.tenantReference ||
    v.brandReference !== s.brandReference ||
    v.storeReference !== s.storeReference
  )
    return fail("ScopeChanged");
}
function scoped(r: Record<string, unknown>, expected: StoreSetupScope) {
  const s = scopeFrom(r);
  if (!same(s, parseStoreSetupScope(expected))) return fail("ScopeChanged");
  return s;
}
function window(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  return { observedAt, validUntil };
}
export interface TaxConfigMaterialCurrent extends StoreSetupScope {
  readonly profile: "TaxConfigMaterialCurrentV1";
  readonly materialReference: string | null;
  readonly materialKind: TaxConfigMaterialKind;
  readonly version: TaxConfigMaterialVersion | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export function parseTaxConfigMaterialCurrent(
  value: unknown,
  scope: StoreSetupScope,
  selector: { materialKind: TaxConfigMaterialKind; materialReference: string | null },
): TaxConfigMaterialCurrent {
  return safe(() => {
    const r = record(copy(value, 1056768), [
      "profile",
      ...scopeKeys,
      "materialReference",
      "materialKind",
      "version",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (r.profile !== "TaxConfigMaterialCurrentV1" || r.qualification !== "NotEvaluated")
      return fail();
    const s = scoped(r, scope),
      materialKind = kind(r.materialKind),
      materialReference = optionalRef(r.materialReference),
      version = r.version === null ? null : parseTaxConfigMaterialVersion(r.version),
      w = window(r);
    if (materialKind !== selector.materialKind || materialReference !== selector.materialReference)
      return fail();
    if (version) {
      matchesScope(version, s);
      if (
        version.materialKind !== materialKind ||
        version.materialReference !== materialReference ||
        version.recordedAt > w.observedAt
      )
        return fail();
    }
    return Object.freeze({
      profile: "TaxConfigMaterialCurrentV1",
      ...s,
      materialKind,
      materialReference,
      version,
      ...w,
      qualification: "NotEvaluated",
    });
  });
}
export interface TaxConfigMaterialReceipt extends StoreSetupScope, TaxConfigMaterialResolve {
  readonly profile: "TaxConfigMaterialOperationV1";
  readonly command: TaxConfigMaterialCommand | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly version: TaxConfigMaterialVersion | null;
  readonly auditReference: string;
  readonly eventReference: string | null;
  readonly occurredAt: string;
}
async function receiptValue(
  value: unknown,
  expected: TaxConfigMaterialCursor,
): Promise<TaxConfigMaterialReceipt> {
  const cursor = parseTaxConfigMaterialCursor(expected),
    r = safe(() =>
      record(copy(value, 3145728), [
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
      ]),
    );
  if (r.profile !== "TaxConfigMaterialOperationV1") return fail();
  const s = scoped(r, cursor.scope),
    p = pins(r),
    intentDigest = hash(r.intentDigest),
    outcome = choice(r.outcome, ["Committed", "Abandoned"]),
    command = r.command === null ? null : parseTaxConfigMaterialCommand(r.command),
    version = r.version === null ? null : await validateTaxConfigMaterialVersion(r.version),
    eventReference = optionalRef(r.eventReference),
    occurredAt = instant(r.occurredAt);
  if (
    !same(
      { ...p, intentDigest },
      {
        action: cursor.action,
        operationReference: cursor.operationReference,
        materialReference: cursor.materialReference,
        expectedRevision: cursor.expectedRevision,
        materialKind: cursor.materialKind,
        intentDigest: cursor.intentDigest,
      },
    )
  )
    return fail();
  if (
    outcome === "Abandoned"
      ? command !== null || version !== null || eventReference !== null
      : command === null || version === null || eventReference === null
  )
    return fail();
  if (command && version) {
    const { content, ...cp } = command;
    if (
      !same(cp, p) ||
      (await digest({ scope: s, command })) !== intentDigest ||
      !same(content, version.content)
    )
      return fail();
    matchesScope(version, s);
    if (
      version.materialKind !== p.materialKind ||
      version.revision !== (p.expectedRevision ?? 0) + 1 ||
      version.recordedByActorReference !== s.actorReference ||
      version.recordedAt !== occurredAt ||
      (p.materialReference !== null && version.materialReference !== p.materialReference)
    )
      return fail();
  }
  return Object.freeze({
    profile: "TaxConfigMaterialOperationV1",
    ...s,
    ...p,
    intentDigest,
    outcome,
    command,
    version,
    auditReference: ref(r.auditReference),
    eventReference,
    occurredAt,
  });
}
export async function validateTaxConfigMaterialReceipt(
  value: unknown,
  expected: TaxConfigMaterialCursor,
): Promise<TaxConfigMaterialReceipt> {
  try {
    return await receiptValue(value, expected);
  } catch (error) {
    if (error instanceof TaxConfigAuthoringClientError) throw error;
    return fail();
  }
}
export type TaxConfigMaterialSummary = Omit<
  TaxConfigMaterialVersion,
  | "profile"
  | "previousVersionReference"
  | "content"
  | "recordedByActorReference"
  | "createdAt"
  | "dataClassification"
>;
export interface TaxConfigMaterialRoster extends StoreSetupScope {
  readonly profile: "TaxConfigMaterialRosterV1";
  readonly materialKind: TaxConfigMaterialKind;
  readonly afterMaterial: string | null;
  readonly entries: readonly TaxConfigMaterialSummary[];
  readonly nextAfterMaterial: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export function parseTaxConfigMaterialRoster(
  value: unknown,
  scope: StoreSetupScope,
  selector: { materialKind: TaxConfigMaterialKind; afterMaterial: string | null },
): TaxConfigMaterialRoster {
  return safe(() => {
    const r = record(copy(value), [
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
    if (
      r.profile !== "TaxConfigMaterialRosterV1" ||
      r.qualification !== "NotEvaluated" ||
      !Array.isArray(r.entries) ||
      r.entries.length > 50
    )
      return fail();
    const s = scoped(r, scope),
      materialKind = kind(r.materialKind),
      afterMaterial = optionalRef(r.afterMaterial),
      nextAfterMaterial = optionalRef(r.nextAfterMaterial),
      w = window(r);
    if (materialKind !== selector.materialKind || afterMaterial !== selector.afterMaterial)
      return fail();
    let previous = afterMaterial;
    const entries = r.entries.map((value) => {
      const v = record(value, [
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
        ]),
        materialReference = ref(v.materialReference),
        recordedAt = instant(v.recordedAt);
      if (
        v.status !== "Recorded" ||
        v.qualification !== "NotEvaluated" ||
        v.materialKind !== materialKind ||
        recordedAt > w.observedAt ||
        (previous !== null && materialReference <= previous)
      )
        return fail();
      previous = materialReference;
      const item = Object.freeze({
        tenantReference: ref(v.tenantReference),
        brandReference: ref(v.brandReference),
        storeReference: ref(v.storeReference),
        materialReference,
        versionReference: ref(v.versionReference),
        revision: integer(v.revision),
        materialKind,
        contentDigest: hash(v.contentDigest),
        recordedAt,
        status: "Recorded" as const,
        qualification: "NotEvaluated" as const,
      });
      matchesScope(item, s);
      return item;
    });
    if (nextAfterMaterial !== null && (entries.length !== 50 || nextAfterMaterial !== previous))
      return fail();
    return Object.freeze({
      profile: "TaxConfigMaterialRosterV1",
      ...s,
      materialKind,
      afterMaterial,
      entries: Object.freeze(entries),
      nextAfterMaterial,
      ...w,
      qualification: "NotEvaluated",
    });
  });
}
export interface TaxRegistrantCurrentSource extends StoreSetupScope {
  readonly profile: "TaxRegistrantCurrentSourceV1";
  readonly businessFunction: "TaxRegistrant";
  readonly effectiveAt: string;
  readonly assignmentReference: string;
  readonly assignmentVersion: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly operatingEntityReference: string;
  readonly entityVersion: number;
  readonly operatingEntityProfileVersionReference: string;
  readonly profileVersion: number;
  readonly legalName: string;
  readonly jurisdictionCode: "CA-ON";
  readonly registrationReference: string | null;
  readonly taxRegistrationReference: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export function parseTaxRegistrantCurrentSource(
  value: unknown,
  scope: StoreSetupScope,
): TaxRegistrantCurrentSource {
  return safe(() => {
    const r = record(copy(value), [
      "profile",
      ...scopeKeys,
      "businessFunction",
      "effectiveAt",
      "assignmentReference",
      "assignmentVersion",
      "effectiveFrom",
      "effectiveUntil",
      "operatingEntityReference",
      "entityVersion",
      "operatingEntityProfileVersionReference",
      "profileVersion",
      "legalName",
      "jurisdictionCode",
      "registrationReference",
      "taxRegistrationReference",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (
      r.profile !== "TaxRegistrantCurrentSourceV1" ||
      r.businessFunction !== "TaxRegistrant" ||
      r.jurisdictionCode !== "CA-ON" ||
      r.qualification !== "NotEvaluated"
    )
      return fail();
    const s = scoped(r, scope),
      w = window(r),
      effectiveAt = instant(r.effectiveAt),
      effectiveFrom = instant(r.effectiveFrom),
      effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
    if (
      effectiveAt > w.observedAt ||
      effectiveFrom > effectiveAt ||
      (effectiveUntil !== null && effectiveUntil <= effectiveAt)
    )
      return fail();
    return Object.freeze({
      profile: "TaxRegistrantCurrentSourceV1",
      ...s,
      businessFunction: "TaxRegistrant",
      effectiveAt,
      effectiveFrom,
      effectiveUntil,
      assignmentReference: ref(r.assignmentReference),
      assignmentVersion: integer(r.assignmentVersion),
      operatingEntityReference: ref(r.operatingEntityReference),
      entityVersion: integer(r.entityVersion),
      operatingEntityProfileVersionReference: ref(r.operatingEntityProfileVersionReference),
      profileVersion: integer(r.profileVersion),
      legalName: text(r.legalName, 200),
      jurisdictionCode: "CA-ON",
      registrationReference: optionalRef(r.registrationReference),
      taxRegistrationReference: optionalRef(r.taxRegistrationReference),
      ...w,
      qualification: "NotEvaluated",
    });
  });
}

export interface TaxConfigMaterialRequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}
export function createTaxConfigMaterialClient(fetcher: typeof fetch = fetch) {
  let epoch = 0;
  const begin = () => ++epoch;
  const active = (e: number, signal: AbortSignal | undefined, write = false) => {
    if (e !== epoch) return fail("ScopeChanged");
    if (signal?.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
  };
  const request = async (
    path: string,
    scope: StoreSetupScope | undefined,
    options: TaxConfigMaterialRequestOptions,
    body: unknown | undefined,
    e: number,
    maximumBytes: number,
    readOnlyPost = false,
  ) => {
    const csrf = options.csrf,
      signal = options.signal,
      post = body !== undefined,
      write = post && !readOnlyPost;
    active(e, signal);
    if (post && (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf))) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false,
      definitive = false;
    try {
      const encoded = post ? canonical(body) : undefined;
      if (encoded !== undefined && new TextEncoder().encode(encoded).length > 1052672)
        return fail();
      sent = true;
      const response = await fetcher(`/merchant/tax-config/authoring/${path}`, {
        method: post ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(scope
            ? {
                "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                  .replace(/\+/gu, "-")
                  .replace(/\//gu, "_")
                  .replace(/=+$/u, ""),
              }
            : {}),
          ...(post ? { "Content-Type": "application/json", "X-BOP-CSRF": csrf ?? "" } : {}),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
      active(e, signal, write);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(write ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (response.ok ? maximumBytes : 4096))
            return fail(write ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      active(e, signal, write);
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      if (
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const error = safe(() => record(value, ["error"])).error;
        if (response.status === 403 && error === "request_denied") {
          definitive = true;
          return fail("Denied");
        }
        if (response.status === 400 && error === "tax_config_authoring_invalid") {
          definitive = true;
          return fail("Invalid");
        }
        if (response.status === 409 && error === "tax_config_authoring_conflict") {
          definitive = true;
          return fail("Conflict");
        }
        if (response.status === 503 && error === "tax_config_authoring_feature_disabled") {
          definitive = true;
          return fail("FeatureDisabled");
        }
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      }
      return value;
    } catch (error) {
      if (error instanceof TaxConfigAuthoringClientError) {
        if (write && sent && !definitive && error.code === "Invalid") return fail("OutcomeUnknown");
        throw error;
      }
      return fail(write && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const live = (value: { observedAt: string; validUntil: string }) => {
    if (Date.now() < Date.parse(value.observedAt) || Date.now() >= Date.parse(value.validUntil))
      return fail("Stale");
  };
  const checkInput = (
    rawScope: StoreSetupScope,
    s: StoreSetupScope,
    options: TaxConfigMaterialRequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
    e: number,
    write = false,
  ) => {
    active(e, signal, write);
    if (
      !same(
        s,
        safe(() => parseStoreSetupScope(rawScope)),
      ) ||
      options.csrf !== csrf ||
      options.signal !== signal
    )
      return fail("ScopeChanged");
  };
  const finish = async (
    raw: unknown,
    cursor: TaxConfigMaterialCursor,
    e: number,
    options: TaxConfigMaterialRequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
  ) => {
    try {
      const result = await validateTaxConfigMaterialReceipt(raw, cursor);
      active(e, signal, true);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      return result;
    } catch (error) {
      if (
        error instanceof TaxConfigAuthoringClientError &&
        (error.code === "ScopeChanged" || error.code === "OutcomeUnknown")
      )
        throw error;
      return fail("OutcomeUnknown");
    }
  };
  return Object.freeze({
    invalidate() {
      epoch++;
    },
    async prepare(
      rawScope: StoreSetupScope,
      value: unknown,
      options: Pick<TaxConfigMaterialRequestOptions, "signal"> = {},
    ): Promise<PreparedTaxConfigMaterialCommand> {
      const scope = safe(() => parseStoreSetupScope(rawScope)),
        command = parseTaxConfigMaterialCommand(value),
        e = begin(),
        signal = options.signal;
      active(e, signal);
      const intentDigest = await digest({ scope, command });
      checkInput(rawScope, scope, options, undefined, signal, e);
      const { content, ...original } = command;
      void content;
      const cursor = parseTaxConfigMaterialCursor({
        profile: "TaxConfigMaterialPendingOriginalV1",
        scope,
        ...original,
        intentDigest,
      });
      return Object.freeze({ scope, command, intentDigest, cursor });
    },
    async execute(
      value: PreparedTaxConfigMaterialCommand,
      options: TaxConfigMaterialRequestOptions,
    ) {
      const r = safe(() => record(value, ["scope", "command", "intentDigest", "cursor"])),
        scope = safe(() => parseStoreSetupScope(r.scope)),
        command = parseTaxConfigMaterialCommand(r.command),
        cursor = parseTaxConfigMaterialCursor(r.cursor),
        intentDigest = hash(r.intentDigest),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      active(e, signal);
      const { content, ...original } = command;
      void content;
      if (
        !same(cursor, {
          profile: "TaxConfigMaterialPendingOriginalV1",
          scope,
          ...original,
          intentDigest,
        }) ||
        (await digest({ scope, command })) !== intentDigest
      )
        return fail();
      checkInput(value.scope, scope, options, csrf, signal, e);
      const raw = await request("materials/commands", scope, options, command, e, 3145728);
      checkInput(value.scope, scope, options, csrf, signal, e, true);
      return finish(raw, cursor, e, options, csrf, signal);
    },
    async resolve(value: TaxConfigMaterialCursor, options: TaxConfigMaterialRequestOptions) {
      const cursor = parseTaxConfigMaterialCursor(value),
        { scope, profile, ...body } = cursor;
      void profile;
      const e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request("materials/resolve-original", scope, options, body, e, 3145728);
      checkInput(value.scope, scope, options, csrf, signal, e, true);
      return finish(raw, cursor, e, options, csrf, signal);
    },
    async current(
      rawScope: StoreSetupScope,
      selector: { materialKind: TaxConfigMaterialKind; materialReference: string | null },
      options: TaxConfigMaterialRequestOptions = {},
    ) {
      const scope = safe(() => parseStoreSetupScope(rawScope)),
        r = safe(() => record(selector, ["materialKind", "materialReference"])),
        selected = Object.freeze({
          materialKind: kind(r.materialKind),
          materialReference: optionalRef(r.materialReference),
        }),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request(
          `materials/current?storeReference=${scope.storeReference}&materialKind=${selected.materialKind}${selected.materialReference === null ? "" : `&materialReference=${selected.materialReference}`}`,
          scope,
          options,
          undefined,
          e,
          1056768,
        ),
        result = parseTaxConfigMaterialCurrent(raw, scope, selected);
      if (result.version) await validateTaxConfigMaterialVersion(result.version);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (!same(selected, selector)) return fail("ScopeChanged");
      live(result);
      return result;
    },
    async version(
      rawScope: StoreSetupScope,
      selector: { materialKind: TaxConfigMaterialKind; versionReference: string },
      options: TaxConfigMaterialRequestOptions = {},
    ) {
      const scope = safe(() => parseStoreSetupScope(rawScope)),
        r = safe(() => record(selector, ["materialKind", "versionReference"])),
        selected = Object.freeze({
          materialKind: kind(r.materialKind),
          versionReference: ref(r.versionReference),
        }),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request(
        `materials/version?storeReference=${scope.storeReference}&materialKind=${selected.materialKind}&versionReference=${selected.versionReference}`,
        scope,
        options,
        undefined,
        e,
        1056768,
      );
      const root = safe(() =>
          optionalRef(
            record(raw, [
              "profile",
              ...scopeKeys,
              "materialReference",
              "materialKind",
              "version",
              "observedAt",
              "validUntil",
              "qualification",
            ]).materialReference,
          ),
        ),
        result = parseTaxConfigMaterialCurrent(raw, scope, {
          materialKind: selected.materialKind,
          materialReference: root,
        });
      if (!result.version || result.version.versionReference !== selected.versionReference)
        return fail();
      await validateTaxConfigMaterialVersion(result.version);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (!same(selected, selector)) return fail("ScopeChanged");
      live(result);
      return result;
    },
    async roster(
      rawScope: StoreSetupScope,
      selector: { materialKind: TaxConfigMaterialKind; afterMaterial: string | null },
      options: TaxConfigMaterialRequestOptions = {},
    ) {
      const scope = safe(() => parseStoreSetupScope(rawScope)),
        r = safe(() => record(selector, ["materialKind", "afterMaterial"])),
        selected = Object.freeze({
          materialKind: kind(r.materialKind),
          afterMaterial: optionalRef(r.afterMaterial),
        }),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request(
          `materials/roster?storeReference=${scope.storeReference}&materialKind=${selected.materialKind}${selected.afterMaterial === null ? "" : `&afterMaterial=${selected.afterMaterial}`}`,
          scope,
          options,
          undefined,
          e,
          65536,
        ),
        result = parseTaxConfigMaterialRoster(raw, scope, selected);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (!same(selected, selector)) return fail("ScopeChanged");
      live(result);
      return result;
    },
    async compare(
      rawScope: StoreSetupScope,
      value: unknown,
      options: TaxConfigMaterialRequestOptions = {},
    ) {
      const scope = safe(() => parseStoreSetupScope(rawScope)),
        command = parseTaxConfigMaterialComparisonCommand(value),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal;
      const raw = await request("materials/compare", scope, options, command, e, 1048576, true),
        result = parseTaxConfigMaterialComparison(raw, scope, command);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (!same(command, parseTaxConfigMaterialComparisonCommand(value)))
        return fail("ScopeChanged");
      live(result);
      return result;
    },
    async registrant(rawScope: StoreSetupScope, options: TaxConfigMaterialRequestOptions = {}) {
      const scope = safe(() => parseStoreSetupScope(rawScope)),
        e = begin(),
        csrf = options.csrf,
        signal = options.signal,
        raw = await request(
          `tax-registrant?storeReference=${scope.storeReference}`,
          scope,
          options,
          undefined,
          e,
          65536,
        ),
        result = raw === null ? null : parseTaxRegistrantCurrentSource(raw, scope);
      checkInput(rawScope, scope, options, csrf, signal, e);
      if (result) live(result);
      return result;
    },
  });
}
