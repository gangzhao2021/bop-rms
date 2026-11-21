import {
  createMoney,
  type CurrencyMetadataSnapshot,
  type Money,
  type PricingReference,
  type TaxCalculationExplanation,
} from "./money-tax-contract.js";
import { calculateTax, roundRational, taxRateRatio } from "./money-tax.js";
import type { ResolvedTaxRuleComponent } from "./tax-configuration.js";

/**
 * WP-2423 DEC-TAX-WHOLE-RECEIPT (coordinator 2026-10-30, Owner authorized): tax is charged per tax
 * type on the whole receipt — round(Σ taxable amount × rate) once per tax type — and each line's
 * tax is that total allocated by largest remainder, so the lines sum exactly to it and a receipt
 * never collects more than whole-receipt rounding. Chosen because it matches the receipt total and
 * never over-collects (our product rule, not a cited tax-authority requirement).
 *
 * `PerLine` is the earlier rule (each line rounded on its own); quotes recorded under it stay as
 * they are and are still verified by it. New quotes use `WholeQuote`.
 */
export type QuoteTaxRounding = "PerLine" | "WholeQuote";

export interface QuoteTaxLineInput {
  readonly lineReference: PricingReference;
  readonly subtotal: Money;
  readonly rules: readonly Pick<
    ResolvedTaxRuleComponent,
    "calculationOrder" | "compoundOnPriorTax" | "resolvedRule"
  >[];
}

export interface QuoteTaxComponentResult {
  readonly taxAmount: Money;
  readonly explanation: TaxCalculationExplanation;
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly ruleReference: PricingReference;
}

/** Largest remainder: floor shares, then the leftover cents to the largest remainders (ties: order). */
function allocate(total: bigint, weights: readonly bigint[]): readonly bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const base = weights.map((weight) => (total * weight) / sum);
  let left = total - base.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  const result = [...base];
  for (const entry of order) {
    if (left <= 0n) break;
    result[entry.index] = (result[entry.index] ?? 0n) + 1n;
    left -= 1n;
  }
  return result;
}

/** Each line's tax components (in its rules' order) under the given rounding rule. */
export function calculateQuoteTax(
  lines: readonly QuoteTaxLineInput[],
  currencyMetadata: CurrencyMetadataSnapshot,
  rounding: QuoteTaxRounding,
): readonly (readonly QuoteTaxComponentResult[])[] {
  const currencyCode = currencyMetadata.currencyCode;
  const money = (amountMinor: bigint) => createMoney({ amountMinor, currencyCode });
  const lineTax = lines.map(() => 0n);
  const results: QuoteTaxComponentResult[][] = lines.map(() => []);
  const component = (lineIndex: number, ruleIndex: number) => {
    const line = lines[lineIndex] as QuoteTaxLineInput;
    const rule = line.rules[ruleIndex] as QuoteTaxLineInput["rules"][number];
    const basis = money(
      line.subtotal.amountMinor + (rule.compoundOnPriorTax ? (lineTax[lineIndex] ?? 0n) : 0n),
    );
    return {
      rule,
      basis,
      calculated: calculateTax({
        calculationReference: rule.resolvedRule.ruleVersionReference,
        taxableReference: line.lineReference,
        inputAmount: basis,
        currencyMetadata,
        resolvedRule: rule.resolvedRule,
      }),
    };
  };
  const record = (
    lineIndex: number,
    rule: QuoteTaxLineInput["rules"][number],
    explanation: TaxCalculationExplanation,
    amountMinor: bigint,
  ) => {
    lineTax[lineIndex] = (lineTax[lineIndex] ?? 0n) + amountMinor;
    (results[lineIndex] as QuoteTaxComponentResult[]).push(
      Object.freeze({
        taxAmount: money(amountMinor),
        explanation,
        calculationOrder: rule.calculationOrder,
        compoundOnPriorTax: rule.compoundOnPriorTax,
        ruleReference: rule.resolvedRule.ruleVersionReference,
      }),
    );
  };
  const steps = Math.max(0, ...lines.map((line) => line.rules.length));
  for (let step = 0; step < steps; step += 1) {
    if (rounding === "PerLine") {
      lines.forEach((line, lineIndex) => {
        if (step >= line.rules.length) return;
        const { rule, calculated } = component(lineIndex, step);
        record(lineIndex, rule, calculated.explanation, calculated.taxAmount.amountMinor);
      });
      continue;
    }
    // One rounding per tax type (and rounding mode) across every line at this step.
    const groups = new Map<
      string,
      { lineIndex: number; numerator: bigint; denominator: bigint }[]
    >();
    const computed = new Map<number, ReturnType<typeof component>>();
    lines.forEach((line, lineIndex) => {
      if (step >= line.rules.length) return;
      const entry = component(lineIndex, step);
      computed.set(lineIndex, entry);
      const rule = entry.rule.resolvedRule;
      const ratio = taxRateRatio(rule.rate);
      const taxable = rule.treatment === "Taxable" && ratio.numerator !== 0n;
      const key = rule.taxComponentCode + "\u0000" + rule.roundingMode;
      groups.set(key, [
        ...(groups.get(key) ?? []),
        {
          lineIndex,
          numerator: taxable ? entry.basis.amountMinor * ratio.numerator : 0n,
          denominator: ratio.denominator,
        },
      ]);
    });
    for (const members of groups.values()) {
      const denominator = members.reduce((d, m) => (m.denominator > d ? m.denominator : d), 1n);
      const scaled = members.map((m) => m.numerator * (denominator / m.denominator));
      const mode = (computed.get(members[0]?.lineIndex ?? -1) as ReturnType<typeof component>).rule
        .resolvedRule.roundingMode;
      const total = roundRational(
        scaled.reduce((a, b) => a + b, 0n),
        denominator,
        mode,
      );
      const shares = allocate(total, scaled);
      members.forEach((member, index) => {
        const entry = computed.get(member.lineIndex) as ReturnType<typeof component>;
        record(member.lineIndex, entry.rule, entry.calculated.explanation, shares[index] ?? 0n);
      });
    }
  }
  return Object.freeze(results.map((entries) => Object.freeze(entries)));
}
