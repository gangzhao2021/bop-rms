import { expect, it, vi } from "vitest";
import { createOrdinaryRefundClient } from "./ordinary-refund-client";
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "a".repeat(43);
const command = () => ({
  orderReference: id(1),
  requestReference: id(2),
  operationReference: id(3),
  expectedClaimVersion: 0,
  reasonCode: "CUSTOMER_REQUEST",
  items: [{ orderBatchReference: id(4), orderItemReference: id(5), quantity: 1 }],
});
const preview = {
  status: "Previewed",
  requestReference: id(2),
  operationReference: id(3),
  claimVersion: 0,
  currencyCode: "CAD",
  amountMinor: "1130",
  paymentAttemptReferences: [id(6)],
  components: {
    netAmountMinor: "1000",
    taxAmountMinor: "130",
    tipAmountMinor: "0",
    serviceChargeAmountMinor: "0",
    serviceChargeTaxAmountMinor: "0",
  },
};
const recorded = {
  status: "RequestRecorded",
  requestReference: id(2),
  operationReference: id(3),
  claimVersion: 1,
  currencyCode: "CAD",
  amountMinor: "1130",
  paymentAttemptReferences: [id(6)],
  replayed: false,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
it("freezes nested selection and retries the exact request after response loss", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(preview))
    .mockRejectedValueOnce(new Error("lost"))
    .mockResolvedValueOnce(response({ ...recorded, replayed: true }, 202));
  const source = command(),
    operation = createOrdinaryRefundClient(fetcher).prepareRequest(source);
  source.items[0] = { orderBatchReference: id(99), orderItemReference: id(98), quantity: 99 };
  await operation.preview(csrf);
  await expect(operation.submit(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(operation.preview(csrf)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(operation.submit("b".repeat(43))).resolves.toEqual({ ...recorded, replayed: true });
  for (const call of fetcher.mock.calls)
    expect(JSON.parse(String(call[1]?.body))).toEqual(command());
  expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-BOP-CSRF": "b".repeat(43) },
  });
});
it("requires a validated preview before sending a request", async () => {
  const fetcher = vi.fn<typeof fetch>(),
    operation = createOrdinaryRefundClient(fetcher).prepareRequest(command());
  await expect(operation.submit(csrf)).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { ...preview, amountMinor: "1131" },
  { ...preview, amountMinor: 1130 },
  { ...preview, operationReference: id(99) },
  { ...preview, claimVersion: 1 },
  { ...preview, status: "Refunded" },
  { ...preview, components: { ...preview.components, taxAmountMinor: "-130" } },
])("rejects invalid money or intent binding %j", async (data) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(data)),
    operation = createOrdinaryRefundClient(fetcher).prepareRequest(command());
  await expect(operation.preview(csrf)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(operation.submit(csrf)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
it("keeps integer money exact beyond Number safe precision", async () => {
  const huge = "9007199254740993",
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        ...preview,
        amountMinor: huge,
        components: { ...preview.components, netAmountMinor: huge, taxAmountMinor: "0" },
      }),
    );
  await expect(
    createOrdinaryRefundClient(fetcher).prepareRequest(command()).preview(csrf),
  ).resolves.toMatchObject({ amountMinor: huge, components: { netAmountMinor: huge } });
});
it.each([
  { ...recorded, amountMinor: "1131" },
  { ...recorded, paymentAttemptReferences: [id(99)] },
  { ...recorded, claimVersion: 2 },
])("treats mismatched submission receipt as unknown %j", async (data) => {
  const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response(data, 202)),
    operation = createOrdinaryRefundClient(fetcher).prepareRequest(command());
  await operation.preview(csrf);
  await expect(operation.submit(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("rejects caller authority fields and duplicate item identity", () => {
  const client = createOrdinaryRefundClient(vi.fn());
  expect(() =>
    client.prepareRequest({ ...command(), actorReference: id(99) } as ReturnType<typeof command>),
  ).toThrow();
  const value = command();
  value.items.push({ orderBatchReference: id(7), orderItemReference: id(5), quantity: 1 });
  expect(() => client.prepareRequest(value)).toThrow();
});
it("binds item queries to order and denies selectable units on uncaptured batches", async () => {
  const item = {
      orderBatchReference: id(4),
      orderItemReference: id(5),
      label: "Latte",
      quantity: 2,
      unclaimedQuantity: 1,
      paymentCaptured: true,
      paymentIntentReference: id(31),
    },
    data = {
      orderReference: id(1),
      orderNumber: "12",
      claimVersion: 1,
      recentRequests: [
        {
          requestReference: id(40),
          operationReference: id(41),
          claimVersion: 1,
          requestedAt: "2026-09-20T12:00:00.000Z",
          reasonCode: "CUSTOMER_REQUEST",
          currencyCode: "CAD",
          amountMinor: "1130",
        },
      ],
      items: [item],
    };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(data))
    .mockResolvedValueOnce(response({ ...data, items: [{ ...item, paymentCaptured: false }] }))
    .mockResolvedValueOnce(response({ ...data, orderReference: id(99) }));
  const client = createOrdinaryRefundClient(fetcher);
  await expect(client.items(id(1), csrf)).resolves.toEqual(data);
  await expect(client.items(id(1), csrf)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(client.items(id(1), csrf)).rejects.toMatchObject({ code: "Unavailable" });
});

const context = {
  paymentIntentReference: id(6),
  paymentAttemptReference: id(7),
  orderReference: id(1),
  orderBatchReference: id(4),
  observedAt: "2026-09-20T12:00:00.000Z",
  paymentState: "Captured",
  currencyCode: "CAD",
  capturedAmountMinor: "2260",
  confirmedRefundMinor: "0",
  pendingRefundMinor: "1130",
};
it("payment context preserves separate capture, confirmed and pending amounts", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(context));
  await expect(createOrdinaryRefundClient(fetcher).context(id(6), csrf)).resolves.toEqual(context);
});
it("payment context preserves unknown amounts rather than inventing zero", async () => {
  const unknown = {
    ...context,
    paymentState: "Unresolved",
    currencyCode: null,
    capturedAmountMinor: null,
    confirmedRefundMinor: null,
    pendingRefundMinor: null,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(unknown))
    .mockResolvedValueOnce(response({ ...unknown, capturedAmountMinor: "0" }));
  const client = createOrdinaryRefundClient(fetcher);
  await expect(client.context(id(6), csrf)).resolves.toEqual(unknown);
  await expect(client.context(id(6), csrf)).rejects.toThrow();
});
it.each([
  { ...context, paymentIntentReference: id(99) },
  { ...context, confirmedRefundMinor: "2260" },
  { ...context, capturedAmountMinor: 2260 },
])("payment context rejects identity or money mismatch %#", async (data) => {
  const client = createOrdinaryRefundClient(
    vi.fn<typeof fetch>().mockResolvedValue(response(data)),
  );
  await expect(client.context(id(6), csrf)).rejects.toMatchObject({ code: "Unavailable" });
});

it("rejects missing, duplicate or inconsistent persisted request history", async () => {
  const entry = {
    requestReference: id(40),
    operationReference: id(41),
    claimVersion: 1,
    requestedAt: "2026-09-20T12:00:00.000Z",
    reasonCode: "CUSTOMER_REQUEST",
    currencyCode: "CAD",
    amountMinor: "1130",
  };
  const data = {
    orderReference: id(1),
    orderNumber: "12",
    claimVersion: 1,
    items: [],
    recentRequests: [entry],
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(data));
  const client = createOrdinaryRefundClient(fetcher);
  expect((await client.items(id(1), csrf)).recentRequests).toEqual([entry]);
  for (const invalid of [
    [],
    [{ ...entry, claimVersion: 2 }],
    [{ ...entry, currencyCode: "USD" }],
    [{ ...entry, amountMinor: "0" }],
    [{ ...entry, requestedAt: "yesterday" }],
    [{ ...entry, actorReference: id(99) }],
  ]) {
    fetcher.mockResolvedValueOnce(response({ ...data, recentRequests: invalid }));
    await expect(client.items(id(1), csrf)).rejects.toMatchObject({ code: "Unavailable" });
  }
  fetcher.mockResolvedValueOnce(
    response({ ...data, claimVersion: 2, recentRequests: [entry, { ...entry, claimVersion: 2 }] }),
  );
  await expect(client.items(id(1), csrf)).rejects.toMatchObject({ code: "Unavailable" });
});

it("binds status to request operation and rejects contradictory completion or money", async () => {
  const payment = {
    paymentAttemptReference: id(7),
    paymentIntentReference: id(6),
    state: "NotDispatched",
    executionOperationReference: null,
    amountMinor: "1130",
    confirmedMinor: "0",
    pendingMinor: "1130",
  };
  const data = {
    orderReference: id(1),
    requestReference: id(2),
    operationReference: id(3),
    observedAt: "2026-09-20T12:00:00.000Z",
    currencyCode: "CAD",
    amountMinor: "1130",
    payments: [payment],
  };
  const fetcher = vi.fn<typeof fetch>();
  const client = createOrdinaryRefundClient(fetcher);
  for (const state of ["NotDispatched", "Prepared", "NeedsReconciliation", "Confirmed"]) {
    const value = {
      ...data,
      payments: [
        {
          ...payment,
          state,
          executionOperationReference: state === "NotDispatched" ? null : id(40),
          confirmedMinor: state === "Confirmed" ? "1130" : "0",
          pendingMinor: state === "Confirmed" ? "0" : "1130",
        },
      ],
    };
    fetcher.mockResolvedValueOnce(response(value));
    await expect(client.status(id(1), id(3), csrf)).resolves.toEqual(value);
  }
  for (const invalid of [
    { ...data, operationReference: id(99) },
    { ...data, orderReference: id(99) },
    { ...data, amountMinor: "1131" },
    { ...data, payments: [{ ...payment, state: "Confirmed" }] },
    { ...data, payments: [{ ...payment, state: "Failed", pendingMinor: "0" }] },
    { ...data, payments: [{ ...payment, providerRefundReference: "private" }] },
  ]) {
    fetcher.mockResolvedValueOnce(response(invalid));
    await expect(client.status(id(1), id(3), csrf)).rejects.toMatchObject({ code: "Unavailable" });
  }
});
