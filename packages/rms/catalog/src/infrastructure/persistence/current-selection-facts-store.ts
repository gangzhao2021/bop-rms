import { parsePublishingDigest } from "@bop/publishing";
import type { ValidateCatalogSelectionInput } from "../../contracts/selection-validation.js";
import { createPostgresAvailabilityQueryStore } from "./availability-query-store.js";
import { createCurrentAvailabilityQueryService } from "../../application/current-availability-query-service.js";
import { createCurrentCatalogSelectionSource } from "../../application/current-selection-source.js";
import { createCatalogSelectionValidationService } from "../../application/selection-validation-service.js";
import type { CurrentAvailabilityQueryPorts } from "../../application/ports/current-availability-query-ports.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
} from "../../contracts/product.js";
import type { CurrentSelectionSourcePorts } from "../../application/current-selection-source.js";
import type { AvailabilityQueryTransactionRunner } from "./availability-query-store.js";
import { createPostgresCurrentMenuReleaseStore } from "./current-menu-release-store.js";
import { createPostgresPublishedMenuQueryStore } from "./published-menu-query-store.js";
import { createPostgresCurrentSkuStore } from "./current-sku-store.js";
import { createPostgresCurrentOptionBindingsStore } from "./current-option-bindings-store.js";

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
          const settings = await tx.query(
            "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
            [],
          );
          const rows = Object.getOwnPropertyDescriptor(settings, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid transaction");
          const isolation = Object.getOwnPropertyDescriptor(rows[0], "isolation")?.value as unknown;
          const readonly = Object.getOwnPropertyDescriptor(rows[0], "read_only")?.value as unknown;
          if (
            (isolation !== "repeatable read" && isolation !== "serializable") ||
            readonly !== "on"
          )
            throw new Error("coherent read-only transaction required");
          const shared: AvailabilityQueryTransactionRunner = { run: (action) => action(tx) };
          const fixed = { brandReference: brand, storeReference: store };
          const release = await createPostgresCurrentMenuReleaseStore(shared, fixed).load({
            menuReference: request.menuReference,
            channelCode: request.channelCode,
            orderTypeCode: request.orderTypeCode,
            observedAt: request.observedAt,
          });
          if (release === null) return null;
          const projections = await createPostgresPublishedMenuQueryStore(
            shared,
            fixed,
          ).loadCandidates({
            ...fixed,
            channelCode: request.channelCode,
            orderTypeCode: request.orderTypeCode,
            requestedAt: request.observedAt,
          });
          const candidates = projections.filter(
            (p) => p.snapshot.menuReference === request.menuReference,
          );
          if (candidates.length !== 1) return null;
          const projection = candidates[0];
          if (!projection) return null;
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
            return null;
          const sellables = p.sections
            .flatMap((section) => section.sellables)
            .filter((s) => s.sellableReference === request.sellableReference);
          if (
            sellables.length === 0 ||
            new Set(sellables.map((s) => s.productVersionReference)).size !== 1
          )
            return null;
          const published = sellables[0];
          if (!published) return null;
          const sku = await createPostgresCurrentSkuStore(shared, { brandReference: brand }).load({
            sellableReference: request.sellableReference,
            productVersionReference: published.productVersionReference,
            observedAt: request.observedAt,
          });
          if (sku === null || !sku.catalogEligible) return null;
          const options = await createPostgresCurrentOptionBindingsStore(shared, {
            brandReference: brand,
          }).load({
            sellableReference: sku.sellableReference,
            productVersionReference: sku.productVersionReference,
            channelCode: request.channelCode,
            observedAt: request.observedAt,
          });
          if (options === null || options.productReference !== sku.productReference) return null;
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
  });
}
