import { describe, expect, it } from "vitest";
import {
  createReceiptController,
  ReceiptClientError,
  parseReceiptView,
} from "./receipt-controller.js";

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function payload() {
  const amount = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  return {
    orderReference: id(1),
    freshnessStatus: "Fresh",
    deliveryStatus: "Unavailable",
    supportEligible: true,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-08-12T14:00:00.000Z",
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          operatingEntityDisplayName: "Synthetic Operating Entity",
          storeDisplayName: "Synthetic Store",
          orderNumber: "1001",
          issuedAt: "2026-08-12T14:00:00.000Z",
          locale: "en-CA",
          lines: [
            {
              lineReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: amount("1000"),
            },
          ],
          subtotal: amount("1000"),
          tax: amount("130"),
          tip: amount("0"),
          total: amount("1130"),
          paymentStatus: "Paid",
          refundedTotal: amount("0"),
        },
      },
    ],
  };
}

describe("receipt response parser", () => {
  it("accepts the closed JSON DTO and converts money strings without binary float", () => {
    const parsed = parseReceiptView(payload(), id(1));
    expect(parsed.records[0]?.snapshot.total.amountMinor).toBe(1130n);
    expect(Object.isFrozen(parsed.records)).toBe(true);
  });

  it("rejects open data bags and accessors without invoking them", () => {
    expect(() => parseReceiptView({ ...payload(), secret: "must-not-pass" }, id(1))).toThrow(
      "invalid receipt",
    );
    const candidate = payload();
    let invoked = false;
    Object.defineProperty(candidate.records[0], "snapshot", {
      enumerable: true,
      get() {
        invoked = true;
        return payload().records[0]?.snapshot;
      },
    });
    expect(() => parseReceiptView(candidate, id(1))).toThrow("invalid receipt");
    expect(invoked).toBe(false);
  });
});

describe("receipt request lifetime", () => {
  it("retains history but requires a fresh read for live fields after reconnecting", async () => {
    let calls = 0;
    const financial = {
      observedAt: "2026-08-12T14:00:00.000Z",
      currencyCode: "CAD",
      capturedMinor: "1130",
      confirmedRefundMinor: "0",
      pendingRefundMinor: "600",
      unresolvedAttemptCount: 1,
    };
    const controller = createReceiptController(id(1), {
      async load() {
        calls += 1;
        return {
          ...payload(),
          financial,
          deliveryStatus: "Pending",
          cancellationEligible: true,
        };
      },
    });
    await controller.load();
    const original = controller.getState();
    expect(original.status).toBe("ready");
    if (original.status !== "ready") throw new Error("receipt was not loaded");

    controller.setOnline(false);
    expect(controller.getState()).toMatchObject({
      status: "offline",
      view: {
        freshnessStatus: "Stale",
        financial: null,
        deliveryStatus: "Unavailable",
        supportEligible: false,
        cancellationEligible: false,
      },
    });
    controller.setOnline(true);
    const reconnected = controller.getState();
    expect(reconnected.status).toBe("ready");
    if (reconnected.status !== "ready") throw new Error("history was not retained");
    expect(reconnected.view.records).toBe(original.view.records);
    expect(reconnected.view.freshnessStatus).toBe("Stale");
    expect(reconnected.view.financial).toBeNull();
    expect(reconnected.view.supportEligible).toBe(false);
    expect(calls).toBe(1);
    expect(original.view.freshnessStatus).toBe("Fresh");
    expect(original.view.financial?.pendingRefundMinor).toBe(600n);

    await controller.load();
    expect(calls).toBe(2);
    expect(controller.getState()).toMatchObject({
      status: "ready",
      view: {
        freshnessStatus: "Fresh",
        financial: { pendingRefundMinor: 600n },
        deliveryStatus: "Pending",
        supportEligible: true,
        cancellationEligible: true,
      },
    });
  });

  it("does not restore an old receipt after current access is denied", async () => {
    let permitted = true;
    const controller = createReceiptController(id(1), {
      async load() {
        if (!permitted) throw new ReceiptClientError("permission_denied");
        return payload();
      },
    });
    await controller.load();
    expect(controller.getState().status).toBe("ready");
    permitted = false;
    await controller.load();
    expect(controller.getState().status).toBe("permission-denied");
    controller.setOnline(false);
    expect(controller.getState()).toEqual({ status: "offline", view: null });
    controller.setOnline(true);
    expect(controller.getState().status).toBe("unavailable");
  });

  it("discards in-flight responses when the page goes offline", async () => {
    let resolve!: (value: unknown) => void;
    const controller = createReceiptController(id(1), {
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const loading = controller.load();
    controller.setOnline(false);
    resolve(payload());
    await loading;
    expect(controller.getState()).toEqual({ status: "offline", view: null });
    controller.setOnline(true);
    expect(controller.getState().status).toBe("unavailable");
  });

  it("does not let an older response undo the newest denial", async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const controller = createReceiptController(id(1), {
      load() {
        calls += 1;
        if (calls === 1)
          return new Promise((done) => {
            resolve = done;
          });
        return Promise.reject(new ReceiptClientError("permission_denied"));
      },
    });
    const older = controller.load();
    await controller.load();
    resolve(payload());
    await older;
    expect(controller.getState().status).toBe("permission-denied");
    controller.setOnline(false);
    expect(controller.getState()).toEqual({ status: "offline", view: null });
  });
});

describe("receipt adjustments", () => {
  it("preserves old snapshots without adding adjustment fields", () => {
    expect(parseReceiptView(payload(), id(1)).records[0]?.snapshot).not.toHaveProperty(
      "adjustments",
    );
  });
  it.each([
    "valid",
    "missing-fee",
    "extra",
    "negative",
    "overflow",
    "currency",
    "excess-discount",
    "wrong-total",
  ] as const)("validates adjustments: %s", (kind) => {
    const input = payload();
    const record = input.records[0];
    if (!record) throw new Error("missing fixture");
    const discount = { amountMinor: "100", currencyCode: "CAD" };
    const fee = { amountMinor: "50", currencyCode: "CAD" };
    const adjustments: Record<string, unknown> = { discount, fee };
    record.snapshot.total.amountMinor = "1080";
    if (kind === "missing-fee") delete adjustments.fee;
    if (kind === "extra") adjustments.extra = true;
    if (kind === "negative") discount.amountMinor = "-1";
    if (kind === "overflow") fee.amountMinor = "9223372036854775808";
    if (kind === "currency") fee.currencyCode = "USD";
    if (kind === "excess-discount") discount.amountMinor = "1001";
    if (kind === "wrong-total") record.snapshot.total.amountMinor = "1081";
    Object.assign(record.snapshot, { adjustments });
    if (kind === "valid")
      expect(parseReceiptView(input, id(1)).records[0]?.snapshot.adjustments).toEqual({
        discount: { amountMinor: 100n, currencyCode: "CAD" },
        fee: { amountMinor: 50n, currencyCode: "CAD" },
      });
    else expect(() => parseReceiptView(input, id(1))).toThrow("invalid receipt");
  });
});

it("keeps the complete issuer legal name and rejects an oversized source", () => {
  const candidate = payload();
  const record = candidate.records[0];
  if (!record) throw new Error("missing synthetic receipt");
  record.snapshot.operatingEntityDisplayName = "S".repeat(200);
  expect(parseReceiptView(candidate, id(1)).records[0]?.snapshot.operatingEntityDisplayName).toBe(
    "S".repeat(200),
  );
  record.snapshot.operatingEntityDisplayName += "S";
  expect(() => parseReceiptView(candidate, id(1))).toThrow("invalid receipt");
});

const financialPayload = () => ({
  observedAt: "2026-09-21T13:00:00.000Z",
  currencyCode: "CAD",
  capturedMinor: "1130",
  confirmedRefundMinor: "100",
  pendingRefundMinor: "600",
  unresolvedAttemptCount: 1,
});
it("parses optional financial facts separately and preserves old responses", () => {
  expect(parseReceiptView(payload(), id(1)).financial).toBeUndefined();
  expect(parseReceiptView({ ...payload(), financial: null }, id(1)).financial).toBeNull();
  const result = parseReceiptView({ ...payload(), financial: financialPayload() }, id(1));
  expect(result.financial?.pendingRefundMinor).toBe(600n);
  expect(result.records[0]?.snapshot.refundedTotal.amountMinor).toBe(0n);
});
it.each([
  { capturedMinor: "1" },
  { pendingRefundMinor: "-1" },
  { capturedMinor: "9223372036854775808" },
  { unresolvedAttemptCount: -1 },
  { observedAt: "2026-02-30T13:00:00.000Z" },
  { currencyCode: "cad" },
  { secret: "unrecognized" },
])("rejects malformed financial data %j", (change) => {
  expect(() =>
    parseReceiptView({ ...payload(), financial: { ...financialPayload(), ...change } }, id(1)),
  ).toThrow();
});
