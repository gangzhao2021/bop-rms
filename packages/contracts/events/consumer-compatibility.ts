import type { EventCatalogRegistration } from "./catalog.ts";

const consumerName = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/u;
const eventType = /^[A-Z][A-Za-z0-9]{0,127}$/u;
const moduleName = /^@(bop|rms)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export interface EventConsumerContract {
  readonly consumerName: string;
  readonly consumerVersion: number;
  readonly ownerModule: `@bop/${string}` | `@rms/${string}`;
  readonly eventType: string;
  readonly schemaVersions: readonly number[];
  readonly tenantScope: "brand" | "store";
  readonly ordering: "aggregate" | "none";
  readonly sideEffect: string;
  readonly replaySafe: boolean;
}

export class EventConsumerCompatibilityError extends Error {
  constructor(
    readonly code:
      | "CONSUMER_CONTRACT_INVALID"
      | "CONSUMER_CONTRACT_DUPLICATE"
      | "CONSUMER_CONTRACT_MISSING"
      | "CONSUMER_CONTRACT_ORPHANED"
      | "CONSUMER_EVENT_INCOMPATIBLE",
    readonly field: string,
  ) {
    super(`${code}:${field}`);
    this.name = "EventConsumerCompatibilityError";
  }
}

function relation(contract: Pick<EventConsumerContract, "consumerName" | "eventType">): string {
  return `${contract.consumerName}|${contract.eventType}`;
}

function eventIdentity(entry: Pick<EventCatalogRegistration, "eventType" | "schemaVersion">) {
  return `${entry.eventType}:v${entry.schemaVersion}`;
}

export function defineEventConsumerContracts(
  contracts: readonly EventConsumerContract[],
): readonly EventConsumerContract[] {
  const seen = new Set<string>();
  const validated = contracts.map((contract) => {
    const validVersions =
      Array.isArray(contract.schemaVersions) &&
      contract.schemaVersions.length > 0 &&
      contract.schemaVersions.every((version) => Number.isInteger(version) && version > 0) &&
      new Set(contract.schemaVersions).size === contract.schemaVersions.length;
    if (
      !consumerName.test(contract.consumerName) ||
      !Number.isInteger(contract.consumerVersion) ||
      contract.consumerVersion < 1 ||
      !contract.consumerName.endsWith(`:v${contract.consumerVersion}`) ||
      !moduleName.test(contract.ownerModule) ||
      !eventType.test(contract.eventType) ||
      !validVersions ||
      (contract.tenantScope !== "brand" && contract.tenantScope !== "store") ||
      (contract.ordering !== "aggregate" && contract.ordering !== "none") ||
      !/^[a-z][a-z0-9._-]{0,63}$/u.test(contract.sideEffect) ||
      typeof contract.replaySafe !== "boolean"
    )
      throw new EventConsumerCompatibilityError("CONSUMER_CONTRACT_INVALID", relation(contract));
    const key = relation(contract);
    if (seen.has(key))
      throw new EventConsumerCompatibilityError("CONSUMER_CONTRACT_DUPLICATE", key);
    seen.add(key);
    return Object.freeze({
      ...contract,
      schemaVersions: Object.freeze(
        [...contract.schemaVersions].sort((left, right) => left - right),
      ),
    });
  });
  return Object.freeze(
    validated.sort(
      (left, right) =>
        left.consumerName.localeCompare(right.consumerName) ||
        left.eventType.localeCompare(right.eventType),
    ),
  );
}

export function assertEventConsumerCompatibility(
  catalog: readonly EventCatalogRegistration[],
  contracts: readonly EventConsumerContract[],
): void {
  const byRelation = new Map(contracts.map((contract) => [relation(contract), contract]));
  const catalogRelations = new Set<string>();

  for (const event of catalog) {
    for (const name of event.consumers) {
      const key = `${name}|${event.eventType}`;
      catalogRelations.add(key);
      const contract = byRelation.get(key);
      if (!contract)
        throw new EventConsumerCompatibilityError(
          "CONSUMER_CONTRACT_MISSING",
          `${eventIdentity(event)}.${name}`,
        );
      if (
        !contract.schemaVersions.includes(event.schemaVersion) ||
        contract.tenantScope !== event.tenantScope ||
        (event.replaySemantics === "idempotent" && !contract.replaySafe)
      )
        throw new EventConsumerCompatibilityError(
          "CONSUMER_EVENT_INCOMPATIBLE",
          `${eventIdentity(event)}.${name}`,
        );
    }
  }

  for (const contract of contracts) {
    if (!catalogRelations.has(relation(contract)))
      throw new EventConsumerCompatibilityError("CONSUMER_CONTRACT_ORPHANED", relation(contract));
  }
}

const contract = (
  consumer: string,
  ownerModule: EventConsumerContract["ownerModule"],
  consumedEvent: string,
  tenantScope: EventConsumerContract["tenantScope"],
  sideEffect: string,
  ordering: EventConsumerContract["ordering"] = "aggregate",
): EventConsumerContract => ({
  consumerName: `${consumer}:v1`,
  consumerVersion: 1,
  ownerModule,
  eventType: consumedEvent,
  schemaVersions: [1],
  tenantScope,
  ordering,
  sideEffect,
  replaySafe: true,
});

export const eventConsumerContracts = defineEventConsumerContracts([
  ...["TaxConfigDraftCreated", "TaxConfigDraftReplaced", "TaxConfigPublished"].map((eventType) =>
    contract(
      "pricing.tax-config-admin-projection",
      "@rms/pricing",
      eventType,
      "store",
      "replace_tax_config_admin_projection",
    ),
  ),
  ...[
    "PriceBookArchived",
    "PriceBookDraftCreated",
    "PriceBookDraftReplaced",
    "PriceBookVersionPublished",
  ].map((eventType) =>
    contract(
      "pricing.price-book-admin-projection",
      "@rms/pricing",
      eventType,
      "brand",
      "replace_price_book_admin_projection",
    ),
  ),
  ...[
    "AvailabilityRuleCreated",
    "AvailabilityRuleReplaced",
    "AvailabilityRuleLifecycleChanged",
  ].map((eventType) =>
    contract(
      "catalog.availability-workbench-projection",
      "@rms/catalog",
      eventType,
      "brand",
      "replace_availability_workbench_projection",
    ),
  ),
  ...["BundleDraftCreated", "BundleDraftReplaced", "BundleLifecycleChanged"].map((eventType) =>
    contract(
      "catalog.bundle-management-projection",
      "@rms/catalog",
      eventType,
      "brand",
      "replace_bundle_management_projection",
    ),
  ),
  contract(
    "catalog.bundle-menu-projection",
    "@rms/catalog",
    "BundleVersionPublished",
    "brand",
    "replace_published_bundle_projection",
  ),
  contract(
    "catalog.published-menu-projection",
    "@rms/catalog",
    "MenuPublished",
    "brand",
    "replace_published_menu_projection",
  ),
  contract(
    "fulfillment.confirmed-order",
    "@rms/fulfillment",
    "OrderConfirmed",
    "store",
    "create_pickup_fulfillment",
  ),
  contract(
    "fulfillment.kitchen-item-ready",
    "@rms/fulfillment",
    "KitchenItemReady",
    "store",
    "record_fulfillment_item_ready",
  ),
  contract(
    "fulfillment.kitchen-order-ready",
    "@rms/fulfillment",
    "KitchenOrderReady",
    "store",
    "mark_fulfillment_ready",
  ),
  contract(
    "kitchen.confirmed-order",
    "@rms/kitchen",
    "OrderConfirmed",
    "store",
    "create_kitchen_ticket",
  ),
  contract(
    "kitchen.queue-item-completed-projection",
    "@rms/kitchen",
    "KitchenItemCompleted",
    "store",
    "replace_kitchen_queue_projection",
    "none",
  ),
  contract(
    "kitchen.queue-item-progress-projection",
    "@rms/kitchen",
    "KitchenItemProgressRecorded",
    "store",
    "replace_kitchen_queue_projection",
    "none",
  ),
  contract(
    "kitchen.queue-projection",
    "@rms/kitchen",
    "KitchenWorkCreated",
    "store",
    "replace_kitchen_queue_projection",
    "none",
  ),
  contract(
    "kitchen.queue-work-accepted-projection",
    "@rms/kitchen",
    "KitchenWorkAccepted",
    "store",
    "replace_kitchen_queue_projection",
    "none",
  ),
  contract(
    "kitchen.queue-work-started-projection",
    "@rms/kitchen",
    "KitchenWorkStarted",
    "store",
    "replace_kitchen_queue_projection",
    "none",
  ),
  contract(
    "operations.order-exception",
    "@bop/projection",
    "PaymentRefunded",
    "store",
    "create_order_exception_projection",
  ),
  contract(
    "ordering.fulfillment-completed",
    "@rms/ordering",
    "FulfillmentCompleted",
    "store",
    "advance_order_status_projection",
  ),
  contract(
    "ordering.order-status-projection",
    "@rms/ordering",
    "OrderCreated",
    "store",
    "replace_order_status_projection",
  ),
  contract(
    "ordering.payment-outcome",
    "@rms/ordering",
    "PaymentFailed",
    "store",
    "record_order_payment_outcome",
  ),
  contract(
    "ordering.payment-outcome",
    "@rms/ordering",
    "PaymentSucceeded",
    "store",
    "record_order_payment_outcome",
  ),
  contract(
    "payment.status-projection",
    "@rms/payment",
    "PaymentFailed",
    "store",
    "replace_payment_status_projection",
  ),
  contract(
    "payment.status-projection",
    "@rms/payment",
    "PaymentRefunded",
    "store",
    "replace_payment_status_projection",
  ),
  contract(
    "payment.status-projection",
    "@rms/payment",
    "PaymentSucceeded",
    "store",
    "replace_payment_status_projection",
  ),
]);
