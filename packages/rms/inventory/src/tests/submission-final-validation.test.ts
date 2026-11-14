import { describe, expect, it } from "vitest";
import {
  InventoryFinalValidationError,
  parseSubmissionInventoryFinalValidation,
} from "../index.js";
import { finalValidationFixture as fixture } from "./submission-final-validation.fixture.js";
describe("submission Inventory final validation", () => {
  it("matches split reservations with exact decimal sums and captures immutable input", () => {
    const raw = fixture();
    const result = parseSubmissionInventoryFinalValidation(raw);
    expect(result).toEqual(raw);
    raw.items.length = 0;
    expect(result.items).toHaveLength(1);
    expect(Object.isFrozen(result.items[0]?.configurationOperationReferences)).toBe(true);
  });
  it.each(["NotTracked", "ZeroDemand", "Deferred"])(
    "records %s explicitly without a reservation set",
    (disposition) => {
      const raw = fixture();
      const original = raw.items[0];
      const result = parseSubmissionInventoryFinalValidation({
        ...raw,
        reservationSet: null,
        items: [
          {
            ...original,
            disposition,
            quantity: disposition === "ZeroDemand" ? "0" : "0.3",
            stockTrackingEnabled: disposition !== "NotTracked",
            deferredActionCode: disposition === "Deferred" ? "AcceptOrder" : null,
          },
        ],
      });
      expect(result.reservationSet).toBeNull();
      expect(result.items[0]?.disposition).toBe(disposition);
      expect("paymentReady" in result).toBe(false);
    },
  );
  it.each([
    "tenantReference",
    "brandReference",
    "storeReference",
    "submissionReference",
    "cartReference",
    "quoteReference",
    "demandReference",
    "actorReference",
    "workflowReference",
  ])("rejects reservation ownership/binding mismatch: %s", (field) => {
    expect(() =>
      parseSubmissionInventoryFinalValidation({
        ...fixture(),
        [field]: "01909997-0000-7000-8000-0000000003e7",
      }),
    ).toThrow(InventoryFinalValidationError);
  });
  it.each(["cartVersion", "workflowVersion"])("rejects %s mismatch", (field) => {
    expect(() => parseSubmissionInventoryFinalValidation({ ...fixture(), [field]: 2 + 3 })).toThrow(
      InventoryFinalValidationError,
    );
  });
  it("rejects missing, extra and insufficient reservations", () => {
    const raw = fixture();
    expect(() => parseSubmissionInventoryFinalValidation({ ...raw, reservationSet: null })).toThrow(
      InventoryFinalValidationError,
    );
    expect(() => parseSubmissionInventoryFinalValidation({ ...raw, items: [] })).toThrow(
      InventoryFinalValidationError,
    );
    expect(() =>
      parseSubmissionInventoryFinalValidation({
        ...raw,
        reservationSet: { ...raw.reservationSet, entries: raw.reservationSet.entries.slice(0, 1) },
      }),
    ).toThrow(InventoryFinalValidationError);
  });
  it.each([
    { disposition: "NotTracked", stockTrackingEnabled: true },
    { disposition: "Reserved", stockTrackingEnabled: false },
    { disposition: "ZeroDemand", quantity: "0.3" },
    { disposition: "Deferred", stockTrackingEnabled: false, deferredActionCode: "AcceptOrder" },
    { disposition: "Deferred", deferredActionCode: null },
    { quantity: "0.300001", unit: { ...fixture().items[0]?.unit, ledgerPrecision: 2 } },
    { configurationOperationReferences: [] },
  ])("rejects contradictory item outcome %#", (patch) => {
    const raw = fixture();
    expect(() =>
      parseSubmissionInventoryFinalValidation({
        ...raw,
        items: [{ ...raw.items[0], ...patch }],
      }),
    ).toThrow(InventoryFinalValidationError);
  });
  it("rejects duplicate items and accessors without invoking them", () => {
    const raw = fixture();
    expect(() =>
      parseSubmissionInventoryFinalValidation({ ...raw, items: [...raw.items, ...raw.items] }),
    ).toThrow(InventoryFinalValidationError);
    let calls = 0;
    Object.defineProperty(raw, "items", {
      enumerable: true,
      get() {
        calls++;
        return [];
      },
    });
    expect(() => parseSubmissionInventoryFinalValidation(raw)).toThrow(
      InventoryFinalValidationError,
    );
    expect(calls).toBe(0);
  });
});
