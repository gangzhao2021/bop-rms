import { expect, it } from "vitest";
import { newOperationReference } from "./operation-reference.js";
import { serviceOperationReference } from "./service-control-client.js";

it("makes a UUIDv7 whose time prefix is the current millisecond, unique per call", () => {
  const before = Date.now();
  const reference = newOperationReference();
  const after = Date.now();
  expect(reference).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  const millis = Number.parseInt(reference.replace("-", "").slice(0, 12), 16);
  expect(millis).toBeGreaterThanOrEqual(before);
  expect(millis).toBeLessThanOrEqual(after);
  expect(new Set(Array.from({ length: 50 }, newOperationReference)).size).toBe(50);
});

it("is the one generator the service-control commands use too", () => {
  expect(serviceOperationReference).toBe(newOperationReference);
});
