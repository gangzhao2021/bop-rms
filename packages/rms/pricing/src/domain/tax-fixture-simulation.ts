import { addMoney, calculateTax, subtractMoney } from "./money-tax.js";
import {
  createMoney,
  parsePricingReference,
  type Money,
  type PricingReference,
} from "./money-tax-contract.js";
import {
  createTaxConfigurationSnapshot,
  resolveTaxConfiguration,
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
    const resolution = resolveTaxConfiguration(snapshot, {
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
