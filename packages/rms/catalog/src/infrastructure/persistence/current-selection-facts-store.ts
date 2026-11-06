import { parsePublishingDigest } from "@bop/publishing";
import type { ValidateCatalogSelectionInput } from "../../contracts/selection-validation.js";
import { createPostgresAvailabilityQueryStore } from "./availability-query-store.js";
import { createCurrentAvailabilityQueryService } from "../../application/current-availability-query-service.js";
import {
  createCurrentCatalogSelectionSource,
  publishedSelectionRules,
} from "../../application/current-selection-source.js";
import { createCatalogSelectionValidationService } from "../../application/selection-validation-service.js";
import type { CurrentAvailabilityQueryPorts } from "../../application/ports/current-availability-query-ports.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
  type CatalogCode,
  type CatalogInstant,
  type CatalogReference,
} from "../../contracts/product.js";
import type { CurrentSelectionSourcePorts } from "../../application/current-selection-source.js";
import type { AvailabilityQueryTransactionRunner } from "./availability-query-store.js";
import { createPostgresCurrentMenuReleaseStore } from "./current-menu-release-store.js";
import { createPostgresPublishedMenuQueryStore } from "./published-menu-query-store.js";
import { createPostgresCurrentSkuStore } from "./current-sku-store.js";
import {
  OptionBindingSourceError,
  createPostgresCurrentOptionBindingsStore,
} from "./current-option-bindings-store.js";
import { resolveCurrentCatalogSelectionRules } from "../../application/current-selection-rules.js";

/**
 * WP-2423 (guest-cart-503): one cart line's standing now. Only `Available` sells; `Indeterminate`
 * may change by itself (retry); the others are stable until staff change the menu or stock.
 */
export type CatalogLineStanding =
  | "Available"
  | "Unavailable"
  | "NotOnMenu"
  | "OptionsChanged"
  | "SetupIncomplete"
  | "Indeterminate";
type FactsTransaction = Parameters<Parameters<AvailabilityQueryTransactionRunner["run"]>[0]>[0];
interface FactsRequest {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly menuReference: CatalogReference;
  readonly channelCode: CatalogCode;
  readonly orderTypeCode: CatalogCode;
  readonly observedAt: CatalogInstant;
}
/**
 * WP-2423 (guest-cart-503): why a dish has no current facts. `NotOnMenu` only when the current
 * release and its Fresh published menu agree and the dish is not in it, or its product can no longer
 * be sold; anything that can change by itself (a listing in progress, a projection not yet rebuilt,
 * release and published rows that disagree) is `Indeterminate`.
 */
type FactsAbsence = "NotOnMenu" | "Indeterminate";
type MenuMemo = Map<string, Promise<unknown>>;

async function classifiedFacts(
  tx: FactsTransaction,
  fixed: Readonly<{ brandReference: CatalogReference; storeReference: CatalogReference }>,
  request: FactsRequest,
  memo?: MenuMemo,
) {
  const brand = fixed.brandReference,
    store = fixed.storeReference;
  const shared: AvailabilityQueryTransactionRunner = { run: (action) => action(tx) };
  // One read per menu in a batch (same transaction, same instant): the release and its projection.
  const menuKey = [
    request.menuReference,
    request.channelCode,
    request.orderTypeCode,
    request.observedAt,
  ].join("|");
  const loadMenu = async () => {
    const release = await createPostgresCurrentMenuReleaseStore(shared, fixed).load({
      menuReference: request.menuReference,
      channelCode: request.channelCode,
      orderTypeCode: request.orderTypeCode,
      observedAt: request.observedAt,
    });
    if (release === null) return null;
    const projections = await createPostgresPublishedMenuQueryStore(shared, fixed).loadCandidates({
      ...fixed,
      channelCode: request.channelCode,
      orderTypeCode: request.orderTypeCode,
      requestedAt: request.observedAt,
    });
    return { release, projections };
  };
  let menuRead = memo?.get(menuKey) as ReturnType<typeof loadMenu> | undefined;
  if (menuRead === undefined) {
    menuRead = loadMenu();
    memo?.set(menuKey, menuRead);
  }
  const menu = await menuRead;
  if (menu === null) return "Indeterminate" as FactsAbsence;
  const { release, projections } = menu;
  const candidates = projections.filter((p) => p.snapshot.menuReference === request.menuReference);
  if (candidates.length !== 1) return "Indeterminate" as FactsAbsence;
  const projection = candidates[0];
  if (!projection) return "Indeterminate" as FactsAbsence;
  const p = projection.snapshot;
  if (
    projection.freshnessStatus !== "Fresh" ||
    projection.lastRebuiltAt > request.observedAt ||
    p.menuVersionReference !== release.menuVersionReference ||
    p.releaseReference !== release.releaseReference ||
    p.snapshotDigest !== release.snapshotDigest ||
    p.effectiveFrom !== release.effectiveFrom ||
    p.effectiveUntil !== release.effectiveUntil ||
    !p.storeReferences.includes(store) ||
    !p.channelCodes.includes(request.channelCode) ||
    !p.orderTypeCodes.includes(request.orderTypeCode)
  )
    return "Indeterminate" as FactsAbsence;
  const sellables = p.sections
    .flatMap((section) => section.sellables)
    .filter((s) => s.sellableReference === request.sellableReference);
  if (sellables.length === 0) return "NotOnMenu" as FactsAbsence;
  if (new Set(sellables.map((s) => s.productVersionReference)).size !== 1)
    return "Indeterminate" as FactsAbsence;
  const published = sellables[0];
  if (!published) return "Indeterminate" as FactsAbsence;
  const sku = await createPostgresCurrentSkuStore(shared, { brandReference: brand }).load({
    sellableReference: request.sellableReference,
    productVersionReference: published.productVersionReference,
    observedAt: request.observedAt,
  });
  if (sku === null) return "Indeterminate" as FactsAbsence;
  if (!sku.catalogEligible) return "NotOnMenu" as FactsAbsence;
  // Sale rules: a default guests start with that is off for now does not stop the dish.
  const options = await createPostgresCurrentOptionBindingsStore(shared, {
    brandReference: brand,
    rules: "Sale",
  }).load({
    sellableReference: sku.sellableReference,
    productVersionReference: sku.productVersionReference,
    channelCode: request.channelCode,
    observedAt: request.observedAt,
  });
  if (options === null || options.productReference !== sku.productReference)
    return "Indeterminate" as FactsAbsence;
  return Object.freeze({
    brandReference: brand,
    storeReference: store,
    sellableReference: sku.sellableReference,
    observedAt: request.observedAt,
    release,
    published: Object.freeze({
      menuReference: p.menuReference,
      menuVersionReference: p.menuVersionReference,
      releaseReference: p.releaseReference,
      snapshotDigest: p.snapshotDigest,
      sellableReference: published.sellableReference,
      productVersionReference: published.productVersionReference,
      localizedNames: published.localizedNames,
      optionRules: published.optionRules,
    }),
    sku,
    bindings: options.bindings,
  });
}

async function assertCoherentReadOnly(tx: FactsTransaction) {
  const settings = await tx.query(
    "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
    [],
  );
  const rows = Object.getOwnPropertyDescriptor(settings, "rows")?.value as unknown;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid transaction");
  const isolation = Object.getOwnPropertyDescriptor(rows[0], "isolation")?.value as unknown;
  const readonly = Object.getOwnPropertyDescriptor(rows[0], "read_only")?.value as unknown;
  if ((isolation !== "repeatable read" && isolation !== "serializable") || readonly !== "on")
    throw new Error("coherent read-only transaction required");
}

/** One Catalog snapshot. Runner owns a dedicated read-only Repeatable Read transaction. */
export function createPostgresCurrentSelectionFactsStore(
  runner: AvailabilityQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const brand = parseCatalogReference(scope.brandReference),
    store = parseCatalogReference(scope.storeReference);
  return Object.freeze({
    async load(input: Parameters<CurrentSelectionSourcePorts["facts"]["load"]>[0]) {
      try {
        if (input.brandReference !== brand || input.storeReference !== store) return null;
        const request = Object.freeze({
          brandReference: brand,
          storeReference: store,
          sellableReference: parseCatalogReference(input.sellableReference),
          menuReference: parseCatalogReference(input.menuReference),
          channelCode: parseCatalogCode(input.channelCode),
          orderTypeCode: parseCatalogCode(input.orderTypeCode),
          observedAt: parseCatalogInstant(input.observedAt),
        });
        return await runner.run(async (tx) => {
          await assertCoherentReadOnly(tx);
          const found = await classifiedFacts(
            tx,
            { brandReference: brand, storeReference: store },
            request,
          );
          return typeof found === "string" ? null : found;
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

/** Complete Catalog connection; safety ports must come from their actual owning services. */
export function createPostgresCatalogSelectionService(
  runner: AvailabilityQueryTransactionRunner,
  scope: Parameters<typeof createCurrentCatalogSelectionSource>[1],
  safety: Pick<CurrentAvailabilityQueryPorts, "killSwitch" | "inventory" | "clock">,
) {
  const fixed = Object.freeze({ ...scope });
  const ownerScope = { brandReference: fixed.brandReference, storeReference: fixed.storeReference };
  const availability = createCurrentAvailabilityQueryService(
    {
      rules: createPostgresAvailabilityQueryStore(runner, ownerScope),
      killSwitch: safety.killSwitch,
      inventory: safety.inventory,
      clock: safety.clock,
    },
    ownerScope,
  );
  return createCatalogSelectionValidationService({
    snapshots: createCurrentCatalogSelectionSource(
      {
        facts: createPostgresCurrentSelectionFactsStore(runner, ownerScope),
        availability,
        clock: safety.clock,
      },
      fixed,
    ),
  });
}

/** Captures validated Catalog facts only; callers still own current authorization and Inventory. */
export function createPostgresCatalogOrderSnapshotSource(
  runner: AvailabilityQueryTransactionRunner,
  scope: Parameters<typeof createCurrentCatalogSelectionSource>[1],
  safety: Pick<CurrentAvailabilityQueryPorts, "killSwitch" | "inventory" | "clock">,
  references: Readonly<{ generate(): string; hash(value: string): string }>,
) {
  const fixed = Object.freeze({ ...scope });
  const ownerScope = { brandReference: fixed.brandReference, storeReference: fixed.storeReference };
  const standings = createPostgresCatalogLineStandingSource(runner, scope, safety);
  return Object.freeze({
    async capture(input: ValidateCatalogSelectionInput) {
      try {
        return await runner.run(async (tx) => {
          const shared: AvailabilityQueryTransactionRunner = { run: (work) => work(tx) };
          const facts = createPostgresCurrentSelectionFactsStore(shared, ownerScope);
          const captured: { facts: Awaited<ReturnType<typeof facts.load>> } = { facts: null };
          const availability = createCurrentAvailabilityQueryService(
            {
              rules: createPostgresAvailabilityQueryStore(shared, ownerScope),
              killSwitch: safety.killSwitch,
              inventory: safety.inventory,
              clock: safety.clock,
            },
            ownerScope,
          );
          const selection = await createCatalogSelectionValidationService({
            snapshots: createCurrentCatalogSelectionSource(
              {
                facts: {
                  load: async (request) => {
                    captured.facts = await facts.load(request);
                    return captured.facts;
                  },
                },
                availability,
                clock: safety.clock,
              },
              fixed,
            ),
          }).validateSelection(input);
          const current = captured.facts;
          if (
            selection.status !== "Accepted" ||
            current === null ||
            current.sku.taxClassificationReference === null
          )
            return null;
          const options = selection.optionSelections.map((selected) => {
            const matches = current.bindings.flatMap(({ binding, optionSet }) =>
              binding.enabledOptionReferences.includes(selected.optionReference)
                ? optionSet.draft.options
                    .filter(
                      (option) =>
                        option.optionReference === selected.optionReference &&
                        option.lifecycle === "Active",
                    )
                    .map((option) => ({ option, binding }))
                : [],
            );
            if (matches.length !== 1 || !matches[0]) throw new Error("ambiguous option snapshot");
            const { option, binding } = matches[0];
            return Object.freeze({
              optionReference: option.optionReference,
              quantity: selected.quantity,
              bindingReference: binding.bindingReference,
              optionSetVersionReference: binding.optionSetVersionReference,
              localizedNames: option.localizedNames,
            });
          });
          const snapshot = Object.freeze({
            snapshotReference: parseCatalogReference(references.generate()),
            brandReference: selection.brandReference,
            storeReference: selection.storeReference,
            sellableReference: selection.sellableReference,
            sellableType: "Sku" as const,
            productReference: current.sku.productReference,
            productVersionReference: selection.productVersionReference,
            skuReference: current.sku.sellableReference,
            menuVersionReference: selection.menuVersionReference,
            localizedNames: current.published.localizedNames,
            unitOfSale: current.sku.unitOfSale,
            unitQuantity: current.sku.unitQuantity,
            taxClassificationReference: current.sku.taxClassificationReference,
            options: Object.freeze(options),
            capturedAt: selection.validatedAt,
          });
          return Object.freeze({
            ...snapshot,
            snapshotDigest: parsePublishingDigest(references.hash(JSON.stringify(snapshot))),
          });
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
    explainMany: standings.explainMany,
  });
}

/** WP-2423 (guest-cart-503): each cart line's standing now, for the quote and the cart's marks. */
export function createPostgresCatalogLineStandingSource(
  runner: AvailabilityQueryTransactionRunner,
  scope: Parameters<typeof createCurrentCatalogSelectionSource>[1],
  safety: Pick<CurrentAvailabilityQueryPorts, "killSwitch" | "inventory" | "clock">,
) {
  const fixed = Object.freeze({ ...scope });
  const ownerScope = { brandReference: fixed.brandReference, storeReference: fixed.storeReference };
  return Object.freeze({
    /**
     * WP-2423 (guest-cart-503): why each line can or cannot be sold now, in one read-only
     * transaction for the whole cart (the menu is read once). Only a stable fact refuses a line:
     * an availability rule, stock or kill switch that says Unavailable, a dish the current coherent
     * menu does not list, a product no longer sold, options that no longer fit, or a dish whose tax
     * class the merchant has not set. A listing in progress, a projection not yet rebuilt, release
     * and published rows that disagree, or an instant that passed during the read are
     * `Indeterminate`: the caller answers "try again", never "remove it".
     */
    async explainMany(
      inputs: readonly ValidateCatalogSelectionInput[],
    ): Promise<readonly CatalogLineStanding[]> {
      try {
        if (!Array.isArray(inputs) || inputs.length > 100) throw new Error("invalid lines");
        const channelCode = parseCatalogCode(fixed.channelCode),
          orderTypeCode = parseCatalogCode(fixed.orderTypeCode),
          menuReference = parseCatalogReference(fixed.menuReference),
          brand = parseCatalogReference(ownerScope.brandReference),
          store = parseCatalogReference(ownerScope.storeReference);
        return await runner.run(async (tx) => {
          await assertCoherentReadOnly(tx);
          const shared: AvailabilityQueryTransactionRunner = { run: (work) => work(tx) };
          const memo: MenuMemo = new Map();
          const availability = createCurrentAvailabilityQueryService(
            {
              rules: createPostgresAvailabilityQueryStore(shared, ownerScope),
              killSwitch: safety.killSwitch,
              inventory: safety.inventory,
              clock: safety.clock,
            },
            ownerScope,
          );
          const standings: CatalogLineStanding[] = [];
          // Sequential: one transaction client is never used concurrently.
          for (const input of inputs) {
            if (
              input.brandReference !== fixed.brandReference ||
              input.storeReference !== fixed.storeReference ||
              input.sourceChannel !== fixed.sourceChannel ||
              input.orderType !== fixed.orderType
            ) {
              standings.push("Indeterminate");
              continue;
            }
            const sellableReference = parseCatalogReference(input.sellableReference);
            const observedAt = parseCatalogInstant(input.observedAt);
            const available = await availability.resolveCurrent({
              brandReference: ownerScope.brandReference,
              storeReference: ownerScope.storeReference,
              sellableReference,
              channelCode,
              orderTypeCode,
              observedAt,
            });
            if (available.status === "Unavailable") {
              standings.push("Unavailable");
              continue;
            }
            if (available.status !== "Available") {
              // WP-2423 (cart-unsellable-dishes): no rule offers the dish here (staff hid it,
              // StopOffering): a stable fact, as the guest menu already reads it (not offered).
              // `Offer`/`StopOffering` change the rule in one commit and this is one snapshot, so
              // it is never a change half seen. Every other reason may change by itself.
              standings.push(
                available.status === "Indeterminate" &&
                  (available as { reasonCode?: unknown }).reasonCode === "NO_EFFECTIVE_RULE"
                  ? "Unavailable"
                  : "Indeterminate",
              );
              continue;
            }
            let facts: Awaited<ReturnType<typeof classifiedFacts>>;
            try {
              facts = await classifiedFacts(
                tx,
                { brandReference: brand, storeReference: store },
                {
                  brandReference: brand,
                  storeReference: store,
                  sellableReference,
                  menuReference,
                  channelCode,
                  orderTypeCode,
                  observedAt,
                },
                memo,
              );
            } catch (error) {
              // WP-2423 (cart-unsellable-dishes): one dish whose choice group the merchant broke
              // (named rule) is that line's setup problem, never the whole cart's outage.
              if (isOptionBindingSourceError(error)) {
                standings.push("SetupIncomplete");
                continue;
              }
              throw error;
            }
            if (typeof facts === "string") {
              standings.push(facts);
              continue;
            }
            if (facts.sku.taxClassificationReference === null) {
              standings.push("SetupIncomplete");
              continue;
            }
            // A required choice group with nothing offered now: the dish can't be had now.
            if (requiredGroupOffNow(facts, ownerScope.brandReference, channelCode, observedAt)) {
              standings.push("Unavailable");
              continue;
            }
            const selection = await createCatalogSelectionValidationService({
              snapshots: createCurrentCatalogSelectionSource(
                { facts: { load: async () => facts }, availability, clock: safety.clock },
                fixed,
              ),
            }).validateSelection(input);
            standings.push(
              selection.status === "Accepted"
                ? "Available"
                : selection.reason === "SELLABLE_UNAVAILABLE"
                  ? "Indeterminate"
                  : "OptionsChanged",
            );
          }
          return Object.freeze(standings);
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

/** Either copy of OptionBindingSourceError (the deployed entry may load two copies). */
function isOptionBindingSourceError(error: unknown): boolean {
  return (
    error instanceof OptionBindingSourceError ||
    (error instanceof Error && error.name === "OptionBindingSourceError")
  );
}

/**
 * WP-2423 (cart-unsellable-dishes): whether a choice group the guest must choose in (always shown,
 * not opened by another choice) has fewer choices offered now than its minimum. Rules that cannot
 * be resolved are not judged here: the validation that follows keeps its own answer.
 */
function requiredGroupOffNow(
  facts: Exclude<Awaited<ReturnType<typeof classifiedFacts>>, string>,
  brandReference: string,
  channelCode: string,
  observedAt: string,
): boolean {
  let rules;
  try {
    const current = resolveCurrentCatalogSelectionRules(
      facts.bindings,
      {
        brandReference,
        sellableReference: facts.sellableReference,
        channelCode,
        observedAt,
      },
      { rules: "Sale" },
    );
    rules =
      facts.published.optionRules === undefined
        ? current
        : publishedSelectionRules(facts.published.optionRules, current, channelCode);
  } catch {
    return false;
  }
  return rules.some(
    (rule) =>
      rule.activationOptionReferences.length === 0 &&
      rule.minimumQuantity > 0 &&
      rule.options.reduce((sum, option) => sum + option.maximumQuantity, 0) < rule.minimumQuantity,
  );
}
