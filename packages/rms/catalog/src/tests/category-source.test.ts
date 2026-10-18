import { it, expect, vi } from "vitest";
import {
  parseCategorySourceEvent,
  categorySourceRevision,
  categorySourceEventDigest,
} from "../index.js";
const id = (n: number) => "01909900-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const event = () => ({
  eventId: id(1),
  eventType: "CategoryCreated",
  schemaVersion: 1,
  occurredAt: "2026-09-14T08:00:00.000Z",
  producerModule: "@rms/catalog",
  tenantId: id(2),
  aggregateType: "Category",
  aggregateId: id(3),
  aggregateVersion: 1n,
  correlationId: id(4),
  causationId: id(5),
  actor: { type: "Actor", actorId: id(6) },
  payload: {
    categoryReference: id(3),
    aggregateVersion: "1",
    lifecycle: "Draft",
    operationReference: id(5),
    sourceRevision: "1",
    snapshotDigest: "sha256:" + "1".repeat(64),
  },
  redactionClassification: "indirect_identifier",
  replayMetadata: { replaySafe: true },
});
it("copies actual transport bigint and JSON string versions into the same immutable Event proof", () => {
  const input = event(),
    parsed = parseCategorySourceEvent(input),
    json = JSON.parse(
      JSON.stringify(input, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    );
  expect(categorySourceEventDigest(parseCategorySourceEvent(json))).toBe(
    categorySourceEventDigest(parsed),
  );
  input.payload.lifecycle = "Active";
  expect(parsed.payload.lifecycle).toBe("Draft");
  expect(Object.isFrozen(parsed.actor)).toBe(true);
});
it.each([
  { schemaVersion: 2 },
  { redactionClassification: "none" },
  { producerModule: "@rms/ordering" },
  { aggregateType: "Product" },
  { storeId: id(7) },
  { aggregateVersion: 2147483648n },
  { actor: { type: "System" } },
  { replayMetadata: { replaySafe: true, extra: true } },
  { payload: { ...event().payload, localizedNames: {} } },
  { payload: { ...event().payload, sourceRevision: "9223372036854775808" } },
  { payload: { ...event().payload, categoryReference: id(99) } },
  { payload: { ...event().payload, operationReference: id(99) } },
])("rejects closed identity/source/version mismatch case %#", (change) => {
  expect(() => parseCategorySourceEvent({ ...event(), ...change })).toThrow();
});
it("never invokes top or nested source accessors", () => {
  for (const key of ["eventId", "payload"]) {
    const getter = vi.fn(() => id(1)),
      value = event();
    Object.defineProperty(value, key, { enumerable: true, get: getter });
    expect(() => parseCategorySourceEvent(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  }
  const value = event(),
    getter = vi.fn(() => "1");
  Object.defineProperty(value.payload, "sourceRevision", { enumerable: true, get: getter });
  expect(() => parseCategorySourceEvent(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each(["01", "-1", "9223372036854775808", 1, NaN, null])(
  "rejects unsafe bigint checkpoint %j",
  (value) => expect(() => categorySourceRevision(value)).toThrow(),
);
it("accepts exact bounded source revisions including empty zero", () => {
  expect(categorySourceRevision("0")).toBe("0");
  expect(categorySourceRevision("9223372036854775807")).toBe("9223372036854775807");
});
