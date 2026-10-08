import {
  listBrandProducts,
  loadBrandProduct,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { listStoreTaxClassifications, loadStoreTaxConfigurationSummary } from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 8.7: TAX-STORE-REVIEW — the selected Store's current tax configuration (what governs, how
 * long it holds), each tax class's rates for pickup and dine-in, and every product's tax class with
 * what is wrong (no class, or a class the Store does not tax for an order type). Read only
 * (pricing.tax_config.read, Store or Brand grant): rates change through the tax configuration workflow, which needs
 * registration and professional review evidence.
 */
export class MerchantStoreTaxError extends Error {
  constructor(readonly code: "PermissionDenied") {
    super(code);
    this.name = "MerchantStoreTaxError";
  }
}
const fail = (code: MerchantStoreTaxError["code"]): never => {
  throw new MerchantStoreTaxError(code);
};
/** The order types the pilot sells; each product needs a rate for both. */
const orderTypes = ["Pickup", "DineIn"] as const;
/** Validity this close to its end is shown as a warning. */
const warnWithinMilliseconds = 30 * 24 * 3_600_000;
/** Component codes of internal test rates (never verified tax facts). */
const testComponent = /^(SYNTHETIC|TEST)_/u;

export function createMerchantStoreTax(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const ctx = (tx: Tx) => tx as unknown as ProductLifecycleTransaction;
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;
  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await resolveScope(tx, input.sessionCookie, current.sessionReference).catch(
          () => fail("PermissionDenied"),
        );
        // The Store's tax configuration: a Store grant or a Brand grant may read it.
        if (!(await scope.allowedAtSelectedStore("pricing.tax_config.read")))
          fail("PermissionDenied");
        const owner = {
          brandReference: String(scope.context.brand.brandReference),
          storeReference: String(scope.selectedStoreReference),
        };
        const at = options.persistence.now();
        const configuration = await loadStoreTaxConfigurationSummary(tx as never, owner, at);
        const classes = await listStoreTaxClassifications(tx as never, owner, at);
        const products: {
          productReference: string;
          name: string;
          selling: boolean;
          taxClassificationReference: string | null;
          status: "NoTaxClass" | "NotCovered" | "Covered";
          missingOrderTypes: string[];
        }[] = [];
        for (const summary of await listBrandProducts(ctx(tx) as never, owner)) {
          const product = await loadBrandProduct(ctx(tx) as never, owner, summary.productReference);
          if (product === null || product.lifecycle === "Archived") continue;
          const taxClass = product.draft.taxClassificationReference;
          const rules =
            classes.find((choice) => choice.taxClassificationReference === taxClass)?.rules ?? [];
          const missing = orderTypes.filter((type) => !rules.some((r) => r.orderType === type));
          products.push({
            productReference: String(product.productReference),
            name: name(product.draft.localizedNames, product.internalCode),
            selling: product.lifecycle === "Active",
            taxClassificationReference: taxClass === null ? null : String(taxClass),
            status:
              taxClass === null
                ? ("NoTaxClass" as const)
                : missing.length > 0
                  ? ("NotCovered" as const)
                  : ("Covered" as const),
            missingOrderTypes: taxClass === null ? [...orderTypes] : missing,
          });
        }
        const ends =
          configuration === null
            ? []
            : [
                { kind: "Configuration", at: configuration.effectiveUntil },
                { kind: "RegistrationEvidence", at: configuration.registrationEvidenceValidUntil },
                { kind: "ProfessionalEvidence", at: configuration.professionalEvidenceValidUntil },
              ].filter((end): end is { kind: string; at: string } => end.at !== null);
        const firstEnd = ends.sort((a, b) => (a.at < b.at ? -1 : 1))[0] ?? null;
        return {
          screenId: "TAX-STORE-REVIEW" as const,
          sourceAsOf: at,
          configuration:
            configuration === null
              ? null
              : {
                  ...configuration,
                  testOnly: configuration.componentCodes.some((code) => testComponent.test(code)),
                  endsAt: firstEnd?.at ?? null,
                  endsBecause: firstEnd?.kind ?? null,
                  endingSoon:
                    firstEnd !== null &&
                    Date.parse(firstEnd.at) - Date.parse(at) <= warnWithinMilliseconds,
                },
          classes: classes.map((choice) => ({
            taxClassificationReference: choice.taxClassificationReference,
            rules: choice.rules,
            productNames: products
              .filter(
                (product) =>
                  product.taxClassificationReference === choice.taxClassificationReference,
              )
              .map((product) => product.name),
          })),
          products,
        };
      }),
    );
  };
  return { query };
}
