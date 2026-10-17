import { expect, it, vi } from "vitest";
import {
  createStaffItemCancellationClient,
  itemCancelFailure,
  parseItemCancelPreview,
  parseItemRefundCheck,
} from "./staff-item-cancellation-client.js";

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const csrf = "synthetic-csrf";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const selection = {
  orderReference: id(1),
  orderBatchReference: id(90),
  orderItemReferences: [id(202), id(201)],
  expectedOrderVersion: 3,
};
const itemsPreview = {
  scope: "Items",
  refund: {
    amountMinor: "1130",
    currencyCode: "CAD",
    includesTip: false,
    netAmountMinor: "1000",
    taxAmountMinor: "130",
    tipAmountMinor: "0",
  },
};
const cancelled = (overrides: Record<string, unknown> = {}) => ({
  status: "Cancelled",
  scope: "Items",
  orderReference: id(1),
  orderBatchReference: id(90),
  cancellationReference: id(700),
  orderItemReferences: [id(201), id(202)],
  cancelledAt: "2026-10-11T12:05:00.000Z",
  refund: { status: "Pending", amountMinor: "1130", currencyCode: "CAD", includesTip: false },
  ...overrides,
});
const sentBody = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number) =>
  JSON.parse(String(fetcher.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;

it("WP-2423 Q6 step 2: previews the refund for the exact selection", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(itemsPreview));
  const answer = await createStaffItemCancellationClient(csrf, fetcher).preview(selection);
  expect(answer).toEqual({ ok: true, value: itemsPreview });
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/orders/cancel-items/preview",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-bop-csrf": csrf },
    }),
  );
  expect(sentBody(fetcher, 0)).toEqual({
    orderReference: id(1),
    orderBatchReference: id(90),
    orderItemReferences: [id(201), id(202)],
    expectedOrderVersion: 3,
  });
  // The last items: the whole remaining payment, tip included; only the total is meaningful.
  expect(
    parseItemCancelPreview({
      scope: "Batch",
      refund: {
        ...itemsPreview.refund,
        amountMinor: "1380",
        includesTip: true,
        netAmountMinor: "0",
        taxAmountMinor: "0",
      },
    }).scope,
  ).toBe("Batch");
  // DEC-TIP-REFUND-PROPORTIONAL: some items carry their share of the tip.
  const withTip = {
    ...itemsPreview,
    refund: {
      ...itemsPreview.refund,
      amountMinor: "1316",
      includesTip: true,
      tipAmountMinor: "186",
    },
  };
  expect(parseItemCancelPreview(withTip)).toEqual(withTip);
  for (const invalid of [
    { ...itemsPreview, scope: "Order" },
    { ...itemsPreview, refund: { ...itemsPreview.refund, includesTip: true } },
    { ...withTip, refund: { ...withTip.refund, includesTip: false } },
    { ...withTip, refund: { ...withTip.refund, tipAmountMinor: "185" } },
    { ...itemsPreview, scope: "Batch", refund: { ...itemsPreview.refund, tipAmountMinor: "10" } },
    { ...itemsPreview, refund: { ...itemsPreview.refund, amountMinor: "1131" } },
    { ...itemsPreview, refund: { ...itemsPreview.refund, amountMinor: 1130 } },
    { ...itemsPreview, refund: { ...itemsPreview.refund, currencyCode: "USD" } },
    { ...itemsPreview, refund: { ...itemsPreview.refund, amountMinor: "-1" } },
    { ...itemsPreview, actor: "Sam" },
  ])
    expect(() => parseItemCancelPreview(invalid)).toThrow();
  const malformed = vi.fn<typeof fetch>().mockResolvedValue(json({ scope: "Items" }));
  expect(await createStaffItemCancellationClient(csrf, malformed).preview(selection)).toEqual({
    ok: false,
    failure: "Unknown",
  });
  expect(() =>
    createStaffItemCancellationClient(csrf, fetcher).preview({
      ...selection,
      orderItemReferences: [id(201), id(201)],
    }),
  ).toThrow();
  expect(() =>
    createStaffItemCancellationClient(csrf, fetcher).preview({
      ...selection,
      orderItemReferences: [],
    }),
  ).toThrow();
});

it("WP-2423 Q6 step 2: maps every refusal to a clear outcome", () => {
  expect(itemCancelFailure(403, "order_cancellation_permission_denied")).toBe("Denied");
  expect(itemCancelFailure(409, "order_preparation_started")).toBe("PreparationStarted");
  expect(itemCancelFailure(409, "order_version_conflict")).toBe("VersionConflict");
  expect(itemCancelFailure(409, "order_item_stock_legacy")).toBe("LegacyStock");
  expect(itemCancelFailure(409, "order_not_cancellable")).toBe("NotCancellable");
  expect(itemCancelFailure(409, "order_stock_not_releasable")).toBe("NotCancellable");
  expect(itemCancelFailure(400, "order_cancellation_input_invalid")).toBe("NotCancellable");
  expect(itemCancelFailure(404, "order_cancellation_not_found")).toBe("NotCancellable");
  expect(itemCancelFailure(503, "order_cancellation_unavailable")).toBe("Unknown");
  expect(itemCancelFailure(500, null)).toBe("Unknown");
  // A PIN sign-in that is not confirmed is not a missing permission.
  expect(itemCancelFailure(403, "full_sign_in_required")).toBe("FullSignInRequired");
  expect(itemCancelFailure(403, null)).toBe("Denied");
  expect(itemCancelFailure(401, "full_sign_in_required")).toBe("Denied");
});

it("WP-2423 Q6 step 2: a lost answer retries the same operation; a settled one starts a new one", async () => {
  let n = 500;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(json({ error: "order_cancellation_unavailable" }, 503))
    .mockResolvedValueOnce(json(cancelled({ status: "AlreadyCancelled" })))
    .mockResolvedValueOnce(json({ error: "order_version_conflict" }, 409));
  const client = createStaffItemCancellationClient(csrf, fetcher, () => id(n++));
  expect(await client.cancel(selection, "SOLD_OUT")).toEqual({ ok: false, failure: "Unknown" });
  expect(client.pendingIntent()?.operationReference).toBe(id(500));
  // The retry ignores a changed selection or reason: it is the same intent.
  expect(
    await client.cancel({ ...selection, orderItemReferences: [id(203)] }, "STORE_ERROR"),
  ).toEqual({ ok: false, failure: "Unknown" });
  const replay = await client.cancel(selection, "SOLD_OUT");
  expect(replay).toMatchObject({
    ok: true,
    value: { status: "AlreadyCancelled", scope: "Items", cancellationReference: id(700) },
  });
  expect(client.pendingIntent()).toBeNull();
  for (const call of [0, 1, 2])
    expect(sentBody(fetcher, call)).toEqual({
      orderReference: id(1),
      orderBatchReference: id(90),
      orderItemReferences: [id(201), id(202)],
      expectedOrderVersion: 3,
      operationReference: id(500),
      reasonCode: "SOLD_OUT",
    });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/orders/cancel-items");
  expect(await client.cancel(selection, "STORE_ERROR")).toEqual({
    ok: false,
    failure: "VersionConflict",
  });
  expect(sentBody(fetcher, 3)).toMatchObject({
    operationReference: id(501),
    reasonCode: "STORE_ERROR",
  });
  expect(client.pendingIntent()).toBeNull();
});

it("WP-2423: a PIN sign-in refusal keeps the same cancellation for the retry after verifying", async () => {
  let n = 500;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ error: "full_sign_in_required" }, 403))
    .mockResolvedValueOnce(json(cancelled()));
  const client = createStaffItemCancellationClient(csrf, fetcher, () => id(n++));
  expect(await client.cancel(selection, "SOLD_OUT")).toEqual({
    ok: false,
    failure: "FullSignInRequired",
  });
  expect(client.pendingIntent()?.operationReference).toBe(id(500));
  expect(await client.cancel(selection, "STORE_ERROR")).toMatchObject({ ok: true });
  expect(sentBody(fetcher, 1)).toMatchObject({
    operationReference: id(500),
    reasonCode: "SOLD_OUT",
  });
  expect(client.pendingIntent()).toBeNull();
});

it("WP-2423 Q6 step 2: an answer that does not match the command is an unknown result", async () => {
  for (const answer of [
    cancelled({ orderBatchReference: id(91) }),
    cancelled({ orderItemReferences: [id(201)] }),
    cancelled({ orderItemReferences: [id(201), id(201)] }),
    cancelled({
      refund: { status: "Pending", amountMinor: "1130", currencyCode: "CAD", includesTip: "yes" },
    }),
    cancelled({
      refund: { status: "Failed", amountMinor: "1130", currencyCode: "CAD", includesTip: false },
    }),
    cancelled({ cancelledAt: "today" }),
  ]) {
    const client = createStaffItemCancellationClient(
      csrf,
      vi.fn<typeof fetch>().mockResolvedValue(json(answer)),
    );
    expect(await client.cancel(selection, "SOLD_OUT")).toEqual({ ok: false, failure: "Unknown" });
    expect(client.pendingIntent()).not.toBeNull();
  }
  const batch = createStaffItemCancellationClient(
    csrf,
    vi.fn<typeof fetch>().mockResolvedValue(
      json(
        cancelled({
          scope: "Batch",
          refund: {
            status: "Refunded",
            amountMinor: "1380",
            currencyCode: "CAD",
            includesTip: true,
          },
        }),
      ),
    ),
  );
  // DEC-TIP-REFUND-PROPORTIONAL: cancelled items' refund carries their share of the tip.
  const items = createStaffItemCancellationClient(
    csrf,
    vi.fn<typeof fetch>().mockResolvedValue(
      json(
        cancelled({
          refund: {
            status: "Pending",
            amountMinor: "1316",
            currencyCode: "CAD",
            includesTip: true,
          },
        }),
      ),
    ),
  );
  expect(await items.cancel(selection, "SOLD_OUT")).toMatchObject({
    ok: true,
    value: { scope: "Items", refund: { amountMinor: "1316", includesTip: true } },
  });
  expect(await batch.cancel(selection, "CUSTOMER_REQUEST")).toMatchObject({
    ok: true,
    value: {
      scope: "Batch",
      refund: { status: "Refunded", amountMinor: "1380", includesTip: true },
    },
  });
});

it("WP-2423 Q6 step 2: checks a cancellation's refund without resending it", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({ refund: { status: "Refunded", amountMinor: "1130", currencyCode: "CAD" } }),
    )
    .mockResolvedValueOnce(json({ error: "order_cancellation_permission_denied" }, 403));
  const client = createStaffItemCancellationClient(csrf, fetcher);
  expect(await client.checkRefund(id(1), id(700))).toEqual({
    ok: true,
    value: { status: "Refunded", amountMinor: "1130", currencyCode: "CAD" },
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/orders/cancel-items/refund");
  expect(sentBody(fetcher, 0)).toEqual({ orderReference: id(1), cancellationReference: id(700) });
  expect(await client.checkRefund(id(1), id(700))).toEqual({ ok: false, failure: "Denied" });
  expect(
    parseItemRefundCheck({ refund: { status: "Failed", amountMinor: "0", currencyCode: "CAD" } })
      .status,
  ).toBe("Failed");
  for (const invalid of [
    { refund: { status: "Unknown", amountMinor: "1", currencyCode: "CAD" } },
    { refund: { status: "Pending", amountMinor: "1", currencyCode: "CAD" }, extra: true },
    { refund: { status: "Pending", amountMinor: "1.5", currencyCode: "CAD" } },
  ])
    expect(() => parseItemRefundCheck(invalid)).toThrow();
  expect(() => client.checkRefund(id(1), "x")).toThrow();
});
