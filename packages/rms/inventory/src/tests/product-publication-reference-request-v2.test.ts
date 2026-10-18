import { describe, expect, it, vi } from "vitest";
import {
  parseInventoryProductPublicationReferenceRequestV2,
  parseInventoryConfigurationReferenceRequest,
} from "../index.js";
const id = (n: number) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = "sha256:" + "a".repeat(64),
  at = "2026-10-03T12:00:00.000Z";
const request = () => ({
  profile: "InventoryProductPublicationReferenceRequestV2",
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  actorKind: "User",
  operationReference: id(4),
  productReference: id(5),
  versionReference: id(6),
  originalIntentDigest: hash,
  replacementIntentDigest: hash,
  aggregateSnapshotDigest: hash,
  currentPublicationDigest: null,
  observedAt: at,
  validUntil: "2026-10-03T12:00:05.000Z",
});
describe("Inventory publication primitive request", () => {
  it("preserves every full-intent binding, shortened lease and System actor without claiming command verification", () => {
    const input = {
        ...request(),
        actorKind: "System",
        currentPublicationDigest: hash,
        validUntil: "2026-10-03T12:00:01.000Z",
      },
      parsed = parseInventoryProductPublicationReferenceRequestV2(input);
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    input.actorReference = id(90);
    expect(parsed.actorReference).toBe(id(3));
    expect(() => parseInventoryConfigurationReferenceRequest(parsed)).toThrow(
      expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it.each([
    { profile: "InventoryConfigurationReferenceRequestV1" },
    { purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" },
    { actorKind: "Service" },
    { originalIntentDigest: "a".repeat(64) },
    { replacementIntentDigest: undefined },
    { aggregateSnapshotDigest: "sha256:" + "A".repeat(64) },
    { currentPublicationDigest: false },
    { operationReference: "unknown" },
    { validUntil: at },
    { validUntil: "2026-10-03T12:00:05.001Z" },
    { observedAt: "2026-10-03T12:00:00Z" },
    { unsupported: true },
  ])("rejects a malformed or mixed request %o", (patch) => {
    expect(() =>
      parseInventoryProductPublicationReferenceRequestV2({ ...request(), ...patch }),
    ).toThrow(expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }));
  });
  it("rejects descriptors/prototypes without evaluating getters", () => {
    const input = request(),
      getter = vi.fn(() => hash);
    Object.defineProperty(input, "originalIntentDigest", { enumerable: true, get: getter });
    expect(() => parseInventoryProductPublicationReferenceRequestV2(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      parseInventoryProductPublicationReferenceRequestV2(
        Object.assign(Object.create({}), request()),
      ),
    ).toThrow();
  });
});
