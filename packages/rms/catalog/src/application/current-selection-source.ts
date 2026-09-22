import { parsePublishingDigest } from "@bop/publishing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
} from "../domain/product.js";
import { resolveCurrentCatalogSelectionRules } from "./current-selection-rules.js";
import type { CatalogSelectionValidationPorts } from "./ports/selection-validation-ports.js";

type Input = Parameters<CatalogSelectionValidationPorts["snapshots"]["resolveCurrent"]>[0];
export interface CurrentSelectionSourcePorts {
  readonly clock: { now(): string };
  /** Owner must read these current facts coherently; null includes incomplete evidence. */
  readonly facts: {
    load(
      input: Input & {
        readonly menuReference: string;
        readonly channelCode: string;
        readonly orderTypeCode: string;
      },
    ): Promise<{
      readonly brandReference: string;
      readonly storeReference: string;
      readonly sellableReference: string;
      readonly observedAt: string;
      readonly release: {
        readonly menuReference: string;
        readonly menuVersionReference: string;
        readonly releaseReference: string;
        readonly snapshotDigest: string;
        readonly channelCode: string;
        readonly orderTypeCode: string;
        readonly effectiveFrom: string;
        readonly effectiveUntil: string | null;
        readonly releasedAt: string;
      };
      /** Exact membership from the current published snapshot, not a mutable draft. */
      readonly published: {
        readonly menuReference: string;
        readonly menuVersionReference: string;
        readonly releaseReference: string;
        readonly snapshotDigest: string;
        readonly sellableReference: string;
        readonly productVersionReference: string;
      };
      readonly sku: {
        readonly sellableReference: string;
        readonly productVersionReference: string;
        readonly catalogEligible: boolean;
      };
      /** Full owner ProductOptionBinding + OptionSetAggregate pairs, including conditional rules. */
      readonly bindings: unknown;
    } | null>;
  };
  readonly availability: {
    resolveCurrent(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly sellableReference: string;
      readonly channelCode: string;
      readonly orderTypeCode: string;
      readonly observedAt: string;
    }): Promise<{ readonly status: string; readonly observedAt: string }>;
  };
}
/** A current selection observation only. Final Inventory and payment readiness are separate. */
export function createCurrentCatalogSelectionSource(
  ports: CurrentSelectionSourcePorts,
  scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly menuReference: string;
    readonly sourceChannel: Input["sourceChannel"];
    readonly orderType: Input["orderType"];
    readonly channelCode: string;
    readonly orderTypeCode: string;
  },
): CatalogSelectionValidationPorts["snapshots"] {
  const fixed = Object.freeze({
    brandReference: parseCatalogReference(scope.brandReference),
    storeReference: parseCatalogReference(scope.storeReference),
    menuReference: parseCatalogReference(scope.menuReference),
    sourceChannel: scope.sourceChannel,
    orderType: scope.orderType,
    channelCode: parseCatalogCode(scope.channelCode),
    orderTypeCode: parseCatalogCode(scope.orderTypeCode),
  });
  if (
    !["Api", "Pos", "Qr", "Web"].includes(fixed.sourceChannel) ||
    !["DineIn", "Pickup"].includes(fixed.orderType)
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return Object.freeze({
    async resolveCurrent(input: Input) {
      if (
        input.brandReference !== fixed.brandReference ||
        input.storeReference !== fixed.storeReference ||
        input.sourceChannel !== fixed.sourceChannel ||
        input.orderType !== fixed.orderType
      )
        return null;
      try {
        const startedAt = parseCatalogInstant(ports.clock.now());
        const requested = Object.freeze({
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          sourceChannel: fixed.sourceChannel,
          orderType: fixed.orderType,
          sellableReference: parseCatalogReference(input.sellableReference),
          observedAt: parseCatalogInstant(input.observedAt),
        });
        if (requested.observedAt > startedAt) return null;
        const facts = await ports.facts.load({
          ...requested,
          menuReference: fixed.menuReference,
          channelCode: fixed.channelCode,
          orderTypeCode: fixed.orderTypeCode,
        });
        if (facts === null) return null;
        const r = facts.release,
          p = facts.published,
          s = facts.sku;
        const version = parseCatalogReference(r.menuVersionReference);
        const productVersion = parseCatalogReference(s.productVersionReference);
        const release = parseCatalogReference(r.releaseReference);
        const digest = parsePublishingDigest(r.snapshotDigest);
        const from = parseCatalogInstant(r.effectiveFrom);
        const until = r.effectiveUntil === null ? null : parseCatalogInstant(r.effectiveUntil);
        if (
          facts.brandReference !== fixed.brandReference ||
          facts.storeReference !== fixed.storeReference ||
          facts.sellableReference !== requested.sellableReference ||
          parseCatalogInstant(facts.observedAt) !== requested.observedAt ||
          r.menuReference !== fixed.menuReference ||
          r.channelCode !== fixed.channelCode ||
          r.orderTypeCode !== fixed.orderTypeCode ||
          parseCatalogInstant(r.releasedAt) > requested.observedAt ||
          from > requested.observedAt ||
          (until !== null && until <= requested.observedAt) ||
          p.menuReference !== fixed.menuReference ||
          p.menuVersionReference !== version ||
          p.releaseReference !== release ||
          p.snapshotDigest !== digest ||
          p.sellableReference !== requested.sellableReference ||
          p.productVersionReference !== productVersion ||
          s.sellableReference !== requested.sellableReference ||
          s.catalogEligible !== true
        )
          return null;
        const rules = resolveCurrentCatalogSelectionRules(facts.bindings, {
          brandReference: fixed.brandReference,
          sellableReference: requested.sellableReference,
          channelCode: fixed.channelCode,
          observedAt: requested.observedAt,
        });
        // Capture owner facts before another asynchronous dependency can change provider-owned values.
        const snapshot = Object.freeze({
          brandReference: requested.brandReference,
          storeReference: requested.storeReference,
          sourceChannel: requested.sourceChannel,
          orderType: requested.orderType,
          sellableReference: requested.sellableReference,
          availability: "Available" as const,
          freshnessStatus: "Fresh" as const,
          menuVersionReference: version,
          productVersionReference: productVersion,
          catalogChannelCode: fixed.channelCode,
          catalogOrderTypeCode: fixed.orderTypeCode,
          effectiveFrom: from,
          effectiveUntil: until,
          resolvedAt: requested.observedAt,
          rules,
        });
        const available = await ports.availability.resolveCurrent({
          brandReference: requested.brandReference,
          storeReference: requested.storeReference,
          sellableReference: requested.sellableReference,
          channelCode: fixed.channelCode,
          orderTypeCode: fixed.orderTypeCode,
          observedAt: requested.observedAt,
        });
        const completedAt = parseCatalogInstant(ports.clock.now());
        if (completedAt < startedAt || (until !== null && until <= completedAt)) return null;
        if (available.status !== "Available" || available.observedAt !== requested.observedAt)
          return null;
        return snapshot;
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
