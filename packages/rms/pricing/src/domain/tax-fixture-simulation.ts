import { addMoney, calculateTax, subtractMoney } from "./money-tax.js";
import {
  createMoney,
  parsePricingReference,
  parsePricingCode,
  parseAmountMinor,
  type Money,
  type PricingReference,
} from "./money-tax-contract.js";
import {
  createTaxConfigurationSnapshot,
  resolveTaxConfiguration,
  resolveDraftTaxConfiguration,
  type TaxConfigurationResolution,
  type TaxResolutionContext,
  type TaxChargeType,
  type TaxConfigurationSnapshot,
  type TaxOrderType,
} from "./tax-configuration.js";

export type TaxFixtureKind = "Basket" | "Refund";

export interface TaxFixtureLine {
  readonly lineReference: PricingReference;
  readonly calculationReferences: readonly PricingReference[];
  readonly labelCode: string;
  readonly taxClassificationReference: PricingReference;
  readonly orderType: TaxOrderType;
  readonly chargeType: TaxChargeType;
  readonly amountMinor: string;
}

export interface ApprovedTaxFixture {
  readonly fixtureReference: PricingReference;
  readonly fixtureSuiteReference: PricingReference;
  readonly fixtureSuiteDigest: string;
  readonly kind: TaxFixtureKind;
  readonly evaluatedAt: string;
  readonly lines: readonly TaxFixtureLine[];
}

export interface TaxFixtureSimulation {
  readonly fixtureReference: PricingReference;
  readonly kind: TaxFixtureKind;
  readonly configurationReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly snapshotDigest: string;
  readonly netAmountMinor: string;
  readonly taxAmountMinor: string;
  readonly grossAmountMinor: string;
  readonly receiptPreview: readonly {
    readonly lineReference: PricingReference;
    readonly labelCode: string;
    readonly componentCode: string;
    readonly treatment: string;
    readonly rate: string;
    readonly taxAmountMinor: string;
  }[];
}

export class TaxFixtureSimulationError extends Error {
  constructor(readonly code: "TAX_FIXTURE_INPUT_INVALID" | "TAX_FIXTURE_EVIDENCE_MISMATCH") {
    super("approved tax fixture simulation is unavailable");
    this.name = "TaxFixtureSimulationError";
  }
}

const fail = (code: TaxFixtureSimulationError["code"]): never => {
  throw new TaxFixtureSimulationError(code);
};

function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value))
    return fail("TAX_FIXTURE_INPUT_INVALID");
  try {
    return BigInt(value);
  } catch {
    return fail("TAX_FIXTURE_INPUT_INVALID");
  }
}

export function simulateApprovedTaxFixture(
  snapshotInput: TaxConfigurationSnapshot,
  fixture: ApprovedTaxFixture,
): TaxFixtureSimulation {
  const snapshot = createTaxConfigurationSnapshot(snapshotInput);
  if (
    snapshot.lifecycle !== "Published" ||
    snapshot.professionalEvidence === null ||
    fixture === null ||
    typeof fixture !== "object" ||
    !Array.isArray(fixture.lines) ||
    fixture.lines.length === 0 ||
    (fixture.kind !== "Basket" && fixture.kind !== "Refund") ||
    fixture.fixtureSuiteReference !== snapshot.professionalEvidence.fixtureSuiteReference ||
    fixture.fixtureSuiteDigest !== snapshot.professionalEvidence.fixtureSuiteDigest
  )
    return fail("TAX_FIXTURE_EVIDENCE_MISMATCH");
  return calculateFixture(snapshot, fixture, resolveTaxConfiguration);
}

function calculateFixture(
  snapshot: TaxConfigurationSnapshot,
  fixture: Pick<ApprovedTaxFixture, "fixtureReference" | "kind" | "evaluatedAt" | "lines">,
  resolve: (
    snapshot: TaxConfigurationSnapshot,
    context: TaxResolutionContext,
  ) => TaxConfigurationResolution,
): TaxFixtureSimulation {
  const currencyCode = snapshot.currencyMetadata.currencyCode;
  let net: Money = createMoney({ amountMinor: 0n, currencyCode });
  let tax: Money = createMoney({ amountMinor: 0n, currencyCode });
  let gross: Money = createMoney({ amountMinor: 0n, currencyCode });
  const receipt: TaxFixtureSimulation["receiptPreview"][number][] = [];
  for (const line of fixture.lines) {
    const lineAmount = amount(line.amountMinor);
    if (
      (fixture.kind === "Basket" && lineAmount < 0n) ||
      (fixture.kind === "Refund" && lineAmount > 0n)
    )
      return fail("TAX_FIXTURE_INPUT_INVALID");
    const resolution = resolve(snapshot, {
      brandReference: snapshot.brandReference,
      storeReference: snapshot.storeReference,
      jurisdictionCode: snapshot.jurisdictionCode,
      currencyCode,
      taxClassificationReference: parsePricingReference(line.taxClassificationReference),
      orderType: line.orderType,
      chargeType: line.chargeType,
      evaluatedAt: fixture.evaluatedAt,
    });
    if (
      !Array.isArray(line.calculationReferences) ||
      line.calculationReferences.length !== resolution.rules.length
    )
      return fail("TAX_FIXTURE_INPUT_INVALID");
    let componentBase = createMoney({ amountMinor: lineAmount, currencyCode });
    let lineTax = createMoney({ amountMinor: 0n, currencyCode });
    for (const [index, component] of resolution.rules.entries()) {
      if (component.compoundOnPriorTax) componentBase = addMoney(componentBase, lineTax);
      const calculated = calculateTax({
        calculationReference: parsePricingReference(line.calculationReferences[index]),
        taxableReference: parsePricingReference(line.lineReference),
        inputAmount: componentBase,
        currencyMetadata: snapshot.currencyMetadata,
        resolvedRule: component.resolvedRule,
      });
      lineTax = addMoney(lineTax, calculated.taxAmount);
      receipt.push(
        Object.freeze({
          lineReference: line.lineReference,
          labelCode: line.labelCode,
          componentCode: component.resolvedRule.taxComponentCode,
          treatment: component.resolvedRule.treatment,
          rate: component.resolvedRule.rate,
          taxAmountMinor: calculated.taxAmount.amountMinor.toString(),
        }),
      );
    }
    const pricedAmount = createMoney({ amountMinor: lineAmount, currencyCode });
    const inclusion = resolution.rules[0]?.resolvedRule.priceInclusion;
    if (inclusion === undefined) return fail("TAX_FIXTURE_INPUT_INVALID");
    const lineNet = inclusion === "Inclusive" ? subtractMoney(pricedAmount, lineTax) : pricedAmount;
    const lineGross = inclusion === "Inclusive" ? pricedAmount : addMoney(pricedAmount, lineTax);
    net = addMoney(net, lineNet);
    tax = addMoney(tax, lineTax);
    gross = addMoney(gross, lineGross);
  }
  return Object.freeze({
    fixtureReference: parsePricingReference(fixture.fixtureReference),
    kind: fixture.kind,
    configurationReference: snapshot.configurationReference,
    versionReference: snapshot.versionReference,
    snapshotDigest: snapshot.snapshotDigest,
    netAmountMinor: net.amountMinor.toString(),
    taxAmountMinor: tax.amountMinor.toString(),
    grossAmountMinor: gross.amountMinor.toString(),
    receiptPreview: Object.freeze(receipt),
  });
}

export interface DraftTaxFixture {
  readonly profile: "TaxDraftFixtureV1";
  readonly fixtureReference: PricingReference;
  readonly kind: TaxFixtureKind;
  readonly evaluatedAt: string;
  readonly lines: readonly TaxFixtureLine[];
}
export interface DraftTaxFixtureSimulation extends TaxFixtureSimulation {
  readonly profile: "TaxDraftFixtureSimulationV1";
  readonly professionalReviewStatus: "NotEvaluated";
  readonly legalConclusion: "NotEvaluated";
}
function closedFixture(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail("TAX_FIXTURE_INPUT_INVALID");
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail("TAX_FIXTURE_INPUT_INVALID");
      return [key, d.value];
    }),
  );
}
function fixtureArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail("TAX_FIXTURE_INPUT_INVALID");
  return Object.freeze(
    Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !("value" in d)) return fail("TAX_FIXTURE_INPUT_INVALID");
      return d.value as unknown;
    }),
  );
}
/** Unapproved, detached mechanical Basket/Refund input. It cannot supply a
 * fixture Suite, professional evidence, registration or publication authority. */
export function simulateDraftTaxFixture(
  snapshotInput: TaxConfigurationSnapshot,
  value: unknown,
): DraftTaxFixtureSimulation {
  let fixture: DraftTaxFixture;
  try {
    const r = closedFixture(value, ["profile", "fixtureReference", "kind", "evaluatedAt", "lines"]);
    if (
      r.profile !== "TaxDraftFixtureV1" ||
      (r.kind !== "Basket" && r.kind !== "Refund") ||
      typeof r.evaluatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(r.evaluatedAt) ||
      !Number.isFinite(Date.parse(r.evaluatedAt)) ||
      new Date(r.evaluatedAt).toISOString() !== r.evaluatedAt
    )
      return fail("TAX_FIXTURE_INPUT_INVALID");
    const fixtureReference = parsePricingReference(r.fixtureReference),
      ids = new Set<string>([fixtureReference]);
    const unique = (v: unknown) => {
      const ref = parsePricingReference(v);
      if (ids.has(ref)) return fail("TAX_FIXTURE_INPUT_INVALID");
      ids.add(ref);
      return ref;
    };
    const lines = fixtureArray(r.lines, 256).map((value) => {
      const line = closedFixture(value, [
        "lineReference",
        "calculationReferences",
        "labelCode",
        "taxClassificationReference",
        "orderType",
        "chargeType",
        "amountMinor",
      ]);
      if (
        (line.orderType !== "DineIn" && line.orderType !== "Pickup") ||
        typeof line.chargeType !== "string" ||
        !["Sellable", "ServiceCharge", "DeliveryFee", "Tip"].includes(line.chargeType) ||
        typeof line.amountMinor !== "string" ||
        !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u.test(line.amountMinor) ||
        line.amountMinor.length > 20
      )
        return fail("TAX_FIXTURE_INPUT_INVALID");
      const n = parseAmountMinor(BigInt(line.amountMinor));
      if ((r.kind === "Basket" && n < 0n) || (r.kind === "Refund" && n > 0n))
        return fail("TAX_FIXTURE_INPUT_INVALID");
      const chargeType = line.chargeType;
      if (
        chargeType !== "Sellable" &&
        chargeType !== "ServiceCharge" &&
        chargeType !== "DeliveryFee" &&
        chargeType !== "Tip"
      )
        return fail("TAX_FIXTURE_INPUT_INVALID");
      return Object.freeze({
        lineReference: unique(line.lineReference),
        calculationReferences: Object.freeze(
          fixtureArray(line.calculationReferences, 16).map(unique),
        ),
        labelCode: parsePricingCode(line.labelCode),
        taxClassificationReference: parsePricingReference(line.taxClassificationReference),
        orderType: line.orderType,
        chargeType,
        amountMinor: line.amountMinor,
      });
    });
    fixture = Object.freeze({
      profile: "TaxDraftFixtureV1",
      fixtureReference,
      kind: r.kind,
      evaluatedAt: r.evaluatedAt,
      lines: Object.freeze(lines),
    });
    if (new TextEncoder().encode(JSON.stringify(fixture)).length > 131072)
      return fail("TAX_FIXTURE_INPUT_INVALID");
  } catch {
    return fail("TAX_FIXTURE_INPUT_INVALID");
  }
  // Resolve every represented line through the Draft-only owning resolver. That
  // retains scope/effective-period/coverage and the same ordered component rules.
  const first = fixture.lines[0];
  if (!first) return fail("TAX_FIXTURE_INPUT_INVALID");
  const field = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object") return fail("TAX_FIXTURE_INPUT_INVALID");
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail("TAX_FIXTURE_INPUT_INVALID");
    return d.value;
  };
  // Transport metadata is read from data descriptors only. The Draft resolver
  // detaches and validates the complete source before calculation sees it.
  resolveDraftTaxConfiguration(snapshotInput, {
    brandReference: parsePricingReference(field(snapshotInput, "brandReference")),
    storeReference: parsePricingReference(field(snapshotInput, "storeReference")),
    jurisdictionCode: parsePricingCode(field(snapshotInput, "jurisdictionCode")),
    currencyCode: parsePricingCode(field(field(snapshotInput, "currencyMetadata"), "currencyCode")),
    taxClassificationReference: first.taxClassificationReference,
    orderType: first.orderType,
    chargeType: first.chargeType,
    evaluatedAt: fixture.evaluatedAt,
  });
  const snapshot = createTaxConfigurationSnapshot(snapshotInput);
  return Object.freeze({
    profile: "TaxDraftFixtureSimulationV1",
    ...calculateFixture(snapshot, fixture, resolveDraftTaxConfiguration),
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  });
}
