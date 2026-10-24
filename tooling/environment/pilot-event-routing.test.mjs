import { describe, expect, it } from "vitest";
import { eventCatalog } from "../../packages/contracts/events/catalog.ts";
import {
  isPilotDispatchScope,
  pilotDispatchScopes,
  pilotUndeployedConsumers,
  pilotUnsubscribedEventTypes,
} from "./pilot-event-routing.mjs";

const brandReference = "0190fa46-0000-7000-8000-000000000001";
const storeReference = "0190fa46-0000-7000-8000-000000000002";
const scope = { brandReference, storeReference };

describe("pilot event routing (WP-2423 5e)", () => {
  it("dispatches the bound Store and the bound Brand, so Brand-scoped events are claimable", () => {
    expect(pilotDispatchScopes(scope)).toEqual([
      { brandId: brandReference, storeId: storeReference },
      { brandId: brandReference },
    ]);
    expect(isPilotDispatchScope({ brandId: brandReference }, scope)).toBe(true);
    expect(isPilotDispatchScope({ brandId: brandReference, storeId: storeReference }, scope)).toBe(
      true,
    );
    expect(
      isPilotDispatchScope(
        { brandId: brandReference, storeId: "0190fa46-0000-7000-8000-000000000003" },
        scope,
      ),
    ).toBe(false);
    expect(isPilotDispatchScope({ brandId: storeReference }, scope)).toBe(false);
    expect(isPilotDispatchScope(undefined, scope)).toBe(false);
  });

  it("declares exactly the catalog event types of each undeployed consumer", () => {
    for (const entry of pilotUndeployedConsumers) {
      const catalogTypes = eventCatalog
        .filter((event) => event.consumers.includes(entry.consumerName))
        .map((event) => event.eventType)
        .sort();
      expect([...entry.eventTypes].sort(), entry.consumerName).toEqual(catalogTypes);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("acknowledges an event type only when every catalog consumer of it is undeployed", () => {
    const declared = new Set(pilotUndeployedConsumers.map((entry) => entry.consumerName));
    for (const eventType of pilotUnsubscribedEventTypes([])) {
      const event = eventCatalog.find((candidate) => candidate.eventType === eventType);
      expect(event, eventType).toBeDefined();
      for (const consumer of event.consumers) expect(declared.has(consumer), consumer).toBe(true);
    }
    expect(pilotUnsubscribedEventTypes([])).toEqual(
      expect.arrayContaining([
        "AvailabilityRuleCreated",
        "AvailabilityRuleReplaced",
        "AvailabilityRuleLifecycleChanged",
        "MenuPublished",
        "ProductCreated",
      ]),
    );
    // Order, payment and kitchen events keep their deployed consumers and are never declared.
    for (const eventType of ["OrderCreated", "PaymentRefunded", "KitchenTicketClosed"])
      expect(pilotUnsubscribedEventTypes([])).not.toContain(eventType);
  });

  it("delivers to a deployed subscriber instead, and refuses a deployed undeployed consumer", () => {
    expect(
      pilotUnsubscribedEventTypes([
        { consumerName: "synthetic.availability-reader:v1", eventType: "AvailabilityRuleCreated" },
      ]),
    ).not.toContain("AvailabilityRuleCreated");
    expect(() =>
      pilotUnsubscribedEventTypes([
        {
          consumerName: "catalog.availability-workbench-projection:v1",
          eventType: "AvailabilityRuleCreated",
        },
      ]),
    ).toThrow("PILOT_EVENT_ROUTING_CONSUMER_DEPLOYED");
  });
});
