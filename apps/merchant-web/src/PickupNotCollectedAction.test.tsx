import { expect, it } from "vitest";
import { closeUncollectedBody, closeUncollectedOutcome } from "./PickupNotCollectedAction.js";
import { parsePickupQueueView } from "./pickup.js";
import { pickupQueueFixture } from "./pickup.fixtures.js";

it("WP-2423: sends close intent only and maps the server's answer", () => {
  const parsed = parsePickupQueueView(pickupQueueFixture()).items[0];
  if (!parsed) throw new Error("fixture");
  const item = {
    ...parsed,
    execution: { aggregateVersion: "3", publicOrderReference: null, proof: null, items: [] },
  };
  expect(() =>
    closeUncollectedBody(parsed, "x", { idempotencyReference: "a", correlationReference: "b" }),
  ).toThrow();
  const body = closeUncollectedBody(item, "01900000-0000-7000-8000-000000000004", {
    idempotencyReference: "01900000-0000-7000-8000-000000000005",
    correlationReference: "01900000-0000-7000-8000-000000000006",
  });
  expect(Object.keys(body).sort()).toEqual([
    "correlationReference",
    "expectedAggregateVersion",
    "idempotencyReference",
    "orderReference",
    "storeReference",
  ]);
  expect(body.expectedAggregateVersion).toBe("3");
  expect(closeUncollectedOutcome(200)).toBe("Closed");
  expect(closeUncollectedOutcome(403)).toBe("Denied");
  expect(closeUncollectedOutcome(422)).toBe("NotEligible");
  expect(closeUncollectedOutcome(409)).toBe("NotEligible");
  expect(closeUncollectedOutcome(503)).toBe("Unknown");
});
