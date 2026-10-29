import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  bundleSellablesActive,
  CatalogError,
  createBundleService,
  createPostgresBundleRepository,
  listBrandBundles,
  listBundleComboRecords,
  parseCatalogHash,
  recordBundleComboChoices,
  recordBundleComboDish,
  recordBundleSingleStoreListing,
  type BundleAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { chineseOf, withChinese } from "./merchant-chinese-text.js";
import { derivedReference } from "./merchant-products.js";
import {
  MerchantSingleStoreListingError,
  requireMerchantBrandSingleStore,
} from "./merchant-sole-operator.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (Owner 2026-10-28 decision 10, approach B): a
 * combo — one price, a choice in each slot (汤 choose 1, 主食 choose 1) — is authored in the Catalog
 * Bundle aggregate and compiled for orders into one dish sold at the combo price, with one choice
 * group per slot whose choices each stand for a dish (Catalog records, 2000_115). Payment, receipts
 * and reports therefore count the combo once at its price; the kitchen reads which dish each choice
 * stands for. A combo is listed with "List it" at a Brand with exactly one store, no pricing review
 * (recorded as a single-store listing, refused by the database at any other Brand).
 */
export class MerchantComboError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Invalid"
      | "Conflict"
      /** Listing without review needs a Brand with exactly one store. */
      | "NotSingleStore"
      /** A dish the combo offers is no longer sold. */
      | "DishUnavailable",
  ) {
    super(code);
    this.name = "MerchantComboError";
  }
}
const fail = (code: MerchantComboError["code"]): never => {
  throw new MerchantComboError(code);
};
const catalogErrors: Partial<Record<CatalogError["code"], MerchantComboError["code"]>> = {
  CATALOG_PERMISSION_DENIED: "PermissionDenied",
  CATALOG_VERSION_CONFLICT: "Conflict",
  CATALOG_IDEMPOTENCY_CONFLICT: "Conflict",
  CATALOG_LIFECYCLE_CONFLICT: "Conflict",
  CATALOG_CODE_CONFLICT: "Conflict",
  CATALOG_UNAVAILABLE: "DishUnavailable",
  CATALOG_INPUT_INVALID: "Invalid",
};
const mapped = (error: unknown): never => {
  const code = error instanceof CatalogError ? catalogErrors[error.code] : undefined;
  if (code !== undefined) return fail(code);
  if (error instanceof MerchantSingleStoreListingError)
    return fail(error.code === "NotSingleStore" ? "NotSingleStore" : "PermissionDenied");
  throw error;
};

export interface ComboSlot {
  /** The slot's stable code (kept across versions; the kitchen and its choice group use it). */
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
  readonly minimum: number;
  readonly maximum: number;
  /** The choice group the slot is compiled into. */
  readonly optionSetReference: string;
  readonly dishes: readonly {
    readonly skuReference: string;
    /** The choice standing for this dish. */
    readonly optionReference: string;
    readonly upgradeMinor: string;
  }[];
}
export interface ComboView {
  readonly bundleReference: string;
  readonly aggregateVersion: number;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly priceMinor: string;
  /** The dish the combo is compiled into (null until its first save finished). */
  readonly productReference: string | null;
  readonly skuReference: string | null;
  /** Listed: guests get this version. Waiting: saved changes not listed yet. */
  readonly state: "Listed" | "Waiting";
  readonly slots: readonly ComboSlot[];
  /** Every choice ever made for the combo's slots (a dish offered again keeps its choice). */
  readonly choiceHistory: readonly {
    readonly groupCode: string;
    readonly optionSetReference: string;
    readonly optionReference: string;
    readonly dishSkuReference: string;
  }[];
}

const name = (names: Readonly<Record<string, string>>, locale: string) =>
  names[locale] ?? Object.values(names)[0] ?? "";

/** The Brand's combos with what each is compiled into. */
export async function readCombos(
  tx: unknown,
  input: { readonly brandReference: string; readonly locale: string },
): Promise<readonly ComboView[]> {
  const ptx = tx as ProductLifecycleTransaction;
  const bundles = await listBrandBundles(ptx, { brandReference: input.brandReference });
  const records = await listBundleComboRecords(ptx, { brandReference: input.brandReference });
  return bundles
    .filter((b) => b.lifecycle === "Draft" || b.lifecycle === "Published")
    .map((bundle) => {
      const version = bundle.currentVersion;
      const dish = records.dishes.find((d) => d.bundleReference === bundle.bundleReference);
      const choices = records.choices.filter((c) => c.bundleReference === bundle.bundleReference);
      return {
        bundleReference: bundle.bundleReference,
        aggregateVersion: bundle.aggregateVersion,
        name: name(version.localizedNames, input.locale),
        nameZh: chineseOf(version.localizedNames),
        description: ((d) => (d === name(version.localizedNames, input.locale) ? "" : d))(
          version.localizedDescriptions[input.locale] ?? "",
        ),
        descriptionZh: chineseOf(version.localizedDescriptions),
        priceMinor: version.fixedPrice?.amountMinor ?? "0",
        productReference: dish?.productReference ?? null,
        skuReference: dish?.skuReference ?? null,
        state:
          bundle.lifecycle === "Published" &&
          records.listedVersions.includes(version.versionReference)
            ? ("Listed" as const)
            : ("Waiting" as const),
        slots: version.componentGroups.map((group) => {
          const slotChoices = choices.filter((c) => c.groupCode === group.stableCode);
          return {
            code: group.stableCode,
            name: name(group.localizedNames, input.locale),
            nameZh: chineseOf(group.localizedNames),
            minimum: group.minimumSelection,
            maximum: group.maximumSelection,
            optionSetReference: slotChoices[0]?.optionSetReference ?? "",
            dishes: group.eligibleSellables.map((item) => ({
              skuReference: item.sellableReference,
              optionReference:
                slotChoices.find((c) => c.dishSkuReference === item.sellableReference)
                  ?.optionReference ?? "",
              upgradeMinor: item.upgradePrice?.amountMinor ?? "0",
            })),
          };
        }),
        choiceHistory: choices.map((c) => ({
          groupCode: c.groupCode,
          optionSetReference: c.optionSetReference,
          optionReference: c.optionReference,
          dishSkuReference: c.dishSkuReference,
        })),
      };
    });
}

interface BrandAuthority {
  readonly context: TenantContext;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly decision: (action: string) => Promise<PermissionDecision | null>;
}

/** The Catalog Bundle service with the Brand authority for this operation. */
function bundleService(
  tx: unknown,
  authority: BrandAuthority,
  operation: string,
  audit: { readonly afterSummary: Readonly<Record<string, string>> } | null,
  facts: (aggregate: BundleAggregate) => Promise<boolean>,
) {
  const generated: Record<string, number> = {};
  return createBundleService({
    authorization: {
      authorize: async (request) => {
        const permission = await authority.decision("catalog.product.update");
        if (permission?.effect !== "Allow") return null;
        const pricing = await authority.decision("pricing.price_book.approve");
        return {
          tenantContext: authority.context,
          permission,
          pricingApproval: pricing?.effect === "Allow" ? pricing : null,
          audit: {
            auditId: derivedReference(operation, "audit:" + request.action),
            brandId: authority.brandReference,
            actor: { type: "User", reference: authority.actorReference },
            actionCode: "CATALOG_BUNDLE_" + request.action.toUpperCase(),
            targetType: "CatalogBundle",
            targetId: request.bundleReference,
            ...(audit === null ? {} : { afterSummary: audit.afterSummary }),
            correlationId: operation,
            occurredAt: request.observedAt,
            reasonCode: "AUTHORIZED_OPERATION",
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: {
      generate: (purpose) => {
        const index = generated[purpose] ?? 0;
        generated[purpose] = index + 1;
        return derivedReference(operation, purpose + ":" + index);
      },
      hashIntent: (value) => parseCatalogHash(createHash("sha256").update(value).digest("hex")),
      equals: (a, b) => a === b,
    },
    facts: { validatePublishedReferences: facts },
    repository: bundleRepository(tx, authority),
  });
}
const bundleRepository = (tx: unknown, authority: BrandAuthority) =>
  createPostgresBundleRepository({
    brandReference: authority.brandReference,
    transactions: { run: (work) => work(tx as ProductLifecycleTransaction) },
    authorize: async () => (await authority.decision("catalog.product.update"))?.effect === "Allow",
    eventReference: (op) => derivedReference(op, "event"),
  });
/**
 * A retried request (same operation) gets what it did the first time: the domain intent includes
 * the request time, so it cannot be re-sent through the service.
 */
async function priorOperation(
  tx: unknown,
  authority: BrandAuthority,
  operationReference: string,
  action: "Create" | "ReplaceDraft" | "Publish",
  bundleReference: string,
) {
  const prior = await bundleRepository(tx, authority).resolveOperation(operationReference as never);
  if (prior === null) return null;
  if (prior.action !== action || prior.aggregate.bundleReference !== bundleReference)
    fail("Conflict");
  return prior.aggregate;
}

export interface SaveComboBundleInput {
  readonly operationReference: string;
  /** null: a new combo (its reference comes from the operation). */
  readonly bundleReference: string | null;
  readonly expectedAggregateVersion: number | null;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly priceMinor: string;
  readonly slots: readonly ComboSlot[];
}

/** Saves the combo as a Bundle draft and records which dish each new choice stands for. */
export async function saveComboBundle(
  tx: unknown,
  authority: BrandAuthority,
  input: { readonly at: string; readonly locale: string; readonly body: SaveComboBundleInput },
): Promise<{ readonly bundleReference: string; readonly aggregateVersion: number }> {
  const { body, at, locale } = input;
  const ptx = tx as ProductLifecycleTransaction;
  const step = (purpose: string) => derivedReference(body.operationReference, purpose);
  const currency = String(authority.context.brand.currencyCode);
  const bundleReference = body.bundleReference ?? step("bundle");
  const version = {
    versionReference: step("bundle-version"),
    status: "Draft" as const,
    defaultLocale: locale,
    localizedNames: withChinese({ [locale]: body.name }, body.nameZh),
    // A Bundle always has a description; without one staff wrote, it is the combo's name.
    localizedDescriptions: withChinese(
      { [locale]: body.description || body.name },
      body.descriptionZh,
    ),
    priceMode: "Fixed" as const,
    fixedPrice: { currencyCode: currency, amountMinor: body.priceMinor },
    componentGroups: body.slots.map((slot, index) => ({
      groupReference: step("slot:" + index),
      stableCode: slot.code,
      localizedNames: withChinese({ [locale]: slot.name }, slot.nameZh),
      minimumSelection: slot.minimum,
      maximumSelection: slot.maximum,
      eligibleSellables: [...slot.dishes]
        .sort((a, b) => (a.skuReference < b.skuReference ? -1 : 1))
        .map((dish) => ({
          sellableReference: dish.skuReference,
          sellableType: "Sku" as const,
          upgradePrice:
            dish.upgradeMinor === "0"
              ? null
              : { currencyCode: currency, amountMinor: dish.upgradeMinor },
        })),
      optionSetVersionReference: null,
    })),
    availabilityRuleReferences: [],
    validationDigest: null,
    createdAt: at,
    updatedAt: at,
    publishedAt: null,
  };
  const service = bundleService(tx, authority, body.operationReference, null, async () => true);
  try {
    const prior = await priorOperation(
      tx,
      authority,
      body.operationReference,
      body.bundleReference === null ? "Create" : "ReplaceDraft",
      bundleReference,
    );
    const result =
      prior !== null
        ? { aggregate: prior }
        : body.bundleReference === null
          ? await service.create({
              candidate: {
                bundleReference,
                brandReference: authority.brandReference,
                internalCode: "COMBO-" + step("code").slice(-12).toUpperCase(),
                lifecycle: "Draft",
                aggregateVersion: 1,
                currentVersion: version,
                createdAt: at,
                createdByActorReference: authority.actorReference,
                updatedAt: at,
              },
              operationReference: body.operationReference,
              requestedAt: at,
            })
          : await (async () => {
              const current = (await listBrandBundles(ptx, authority)).find(
                (b) => b.bundleReference === body.bundleReference,
              );
              if (current === undefined) return fail("NotFound");
              if (current.aggregateVersion !== body.expectedAggregateVersion) fail("Conflict");
              return service.replaceDraft({
                candidate: {
                  ...current,
                  lifecycle: "Draft",
                  aggregateVersion: current.aggregateVersion + 1,
                  currentVersion: version,
                  updatedAt: at,
                },
                expectedAggregateVersion: current.aggregateVersion,
                operationReference: body.operationReference,
                requestedAt: at,
              });
            })();
    await recordBundleComboChoices(ptx, {
      brandReference: authority.brandReference,
      bundleReference,
      actorReference: authority.actorReference,
      recordedAt: at,
      choices: body.slots.flatMap((slot) =>
        slot.dishes.map((dish) => ({
          groupCode: slot.code,
          optionSetReference: slot.optionSetReference,
          optionReference: dish.optionReference,
          dishSkuReference: dish.skuReference,
        })),
      ),
    });
    return {
      bundleReference: result.aggregate.bundleReference,
      aggregateVersion: result.aggregate.aggregateVersion,
    };
  } catch (error) {
    return mapped(error);
  }
}

/**
 * "List it" for the combos: each combo with saved changes is published alone at the Brand's one
 * store — its dishes must still be sold — and the listing is recorded as a single-store listing.
 */
export async function listComboDrafts(
  tx: unknown,
  authority: BrandAuthority,
  input: { readonly at: string; readonly operationReference: string },
): Promise<{ readonly listed: number }> {
  const ptx = tx as ProductLifecycleTransaction;
  const records = await listBundleComboRecords(ptx, authority);
  const waiting = (await listBrandBundles(ptx, authority)).filter(
    (b) =>
      b.lifecycle === "Draft" &&
      records.dishes.some((d) => d.bundleReference === b.bundleReference),
  );
  let listed = 0;
  try {
    for (const bundle of waiting) {
      const operation = derivedReference(
        input.operationReference,
        "combo-" + bundle.bundleReference.slice(-12),
      );
      // The author lists alone only at the Brand's one store (held until this commits).
      await requireMerchantBrandSingleStore(tx as never, {
        brandReference: authority.brandReference,
        storeReference: authority.storeReference,
        actorReference: authority.actorReference,
        permissionCode: "pricing.price-book.approve",
        observedAt: input.at,
        allowed: async () =>
          (await authority.decision("pricing.price_book.approve"))?.effect === "Allow",
      });
      const service = bundleService(
        tx,
        authority,
        operation,
        { afterSummary: { approvalMode: "SingleStoreListing" } },
        async (aggregate) =>
          bundleSellablesActive(ptx, {
            brandReference: authority.brandReference,
            skuReferences: aggregate.currentVersion.componentGroups.flatMap((g) =>
              g.eligibleSellables.map((s) => s.sellableReference),
            ),
          }),
      );
      const prior = await priorOperation(
        tx,
        authority,
        operation,
        "Publish",
        bundle.bundleReference,
      );
      if (prior !== null) continue;
      const result = await service.publish({
        bundleReference: bundle.bundleReference,
        validationDigest: createHash("sha256")
          .update(canonicalizeRfc8785(JSON.parse(JSON.stringify(bundle.currentVersion)) as never))
          .digest("hex"),
        expectedAggregateVersion: bundle.aggregateVersion,
        operationReference: operation,
        requestedAt: input.at,
      });
      if (result.status === "Applied")
        await recordBundleSingleStoreListing(ptx, {
          brandReference: authority.brandReference,
          operationReference: operation,
          bundleReference: bundle.bundleReference,
          versionReference: bundle.currentVersion.versionReference,
          storeReference: authority.storeReference,
          actorReference: authority.actorReference,
          listedAt: input.at,
          auditReference: derivedReference(operation, "audit:Publish"),
        });
      listed += 1;
    }
  } catch (error) {
    return mapped(error);
  }
  return { listed };
}

/** Records the dish a new combo was compiled into. */
export async function recordComboDish(
  tx: unknown,
  authority: BrandAuthority,
  input: {
    readonly at: string;
    readonly bundleReference: string;
    readonly productReference: string;
    readonly skuReference: string;
  },
): Promise<void> {
  try {
    await recordBundleComboDish(tx as ProductLifecycleTransaction, {
      brandReference: authority.brandReference,
      bundleReference: input.bundleReference,
      productReference: input.productReference,
      skuReference: input.skuReference,
      actorReference: authority.actorReference,
      recordedAt: input.at,
    });
  } catch (error) {
    mapped(error);
  }
}

export function createMerchantCombos(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveBrand = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  interface Session {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }
  const run = async <T>(
    input: Session,
    work: (tx: Tx, authority: BrandAuthority) => Promise<T>,
  ): Promise<T> => {
    const current = await options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx: Tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const scope = await resolveBrand(tx, input.sessionCookie, current.sessionReference).catch(
            () => fail("PermissionDenied"),
          );
          const authority: BrandAuthority = {
            context: scope.context,
            brandReference: String(scope.context.brand.brandReference),
            storeReference: String(scope.selectedStoreReference),
            actorReference: String(scope.actorReference),
            decision: async (action) =>
              (await scope.authorizeAction(action)) as PermissionDecision | null,
          };
          if ((await authority.decision("catalog.product.read"))?.effect !== "Allow")
            fail("PermissionDenied");
          return work(tx, authority);
        }),
      ),
    );
  };
  return {
    query: (input: Session) =>
      run(input, async (tx, authority) => ({
        combos: await readCombos(tx, {
          brandReference: authority.brandReference,
          locale: options.locale,
        }),
      })),
    saveBundle: (input: Session & { readonly body: SaveComboBundleInput }) =>
      run(input, (tx, authority) =>
        saveComboBundle(tx, authority, {
          at: options.persistence.now(),
          locale: options.locale,
          body: input.body,
        }),
      ),
    recordDish: (
      input: Session & {
        readonly bundleReference: string;
        readonly productReference: string;
        readonly skuReference: string;
      },
    ) =>
      run(input, (tx, authority) =>
        recordComboDish(tx, authority, { at: options.persistence.now(), ...input }),
      ),
    listDrafts: (input: Session & { readonly operationReference: string }) =>
      run(input, (tx, authority) =>
        listComboDrafts(tx, authority, {
          at: options.persistence.now(),
          operationReference: input.operationReference,
        }),
      ),
  };
}
