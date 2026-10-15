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
  approvalRequired: false,
  escalationReasons: [],
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
  approvalRequired: false,
  escalationReasons: [],
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
  await expect(operation.submit("b".repeat(43))).resolves.toEqual({
    ...recorded,
    replayed: true,
    approveAlone: false,
  });
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
      paymentMethod: "Online",
    },
    data = {
      orderReference: id(1),
      orderNumber: "12",
      canRequest: true,
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
          decline: null,
          progress: "Recorded",
          paymentMethod: "Online",
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
  paymentMethod: "Online",
  currencyCode: "CAD",
  capturedAmountMinor: "2260",
  confirmedRefundMinor: "0",
  pendingRefundMinor: "1130",
  canRequest: true,
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
    decline: null,
    progress: "Recorded",
    paymentMethod: "Online",
  };
  const data = {
    orderReference: id(1),
    orderNumber: "12",
    canRequest: true,
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
    method: "Online",
    refundedOnCardMachineAt: null,
    cardMachineSlipReference: null,
    executionOperationReference: null,
    executionApprovalReference: null,
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

it("WP-2423 Q5: reports why an owner approval is needed and rejects contradictory reasons", async () => {
  const escalated = {
    ...preview,
    approvalRequired: true,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100", "MoreThan24Hours"],
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(escalated));
  await expect(
    createOrdinaryRefundClient(fetcher).prepareRequest(command()).preview(csrf),
  ).resolves.toMatchObject({
    approvalRequired: true,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100", "MoreThan24Hours"],
  });
  for (const invalid of [
    { ...preview, approvalRequired: true, escalationReasons: [] },
    { ...preview, approvalRequired: false, escalationReasons: ["MoreThan24Hours"] },
    { ...preview, approvalRequired: true, escalationReasons: ["Unknown"] },
    { ...preview, approvalRequired: "yes" },
  ]) {
    const failing = vi.fn<typeof fetch>().mockResolvedValueOnce(response(invalid));
    await expect(
      createOrdinaryRefundClient(failing).prepareRequest(command()).preview(csrf),
    ).rejects.toMatchObject({ code: "Unavailable" });
  }
});

it("WP-2423 Q19: says when the requester may approve the escalated refund alone", async () => {
  const escalated = {
    ...preview,
    approvalRequired: true,
    escalationReasons: ["MoreThan24Hours"],
  };
  const alone = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ ...escalated, approveAlone: true }));
  await expect(
    createOrdinaryRefundClient(alone).prepareRequest(command()).preview(csrf),
  ).resolves.toMatchObject({ approvalRequired: true, approveAlone: true });
  const older = vi.fn<typeof fetch>().mockResolvedValueOnce(response(escalated));
  await expect(
    createOrdinaryRefundClient(older).prepareRequest(command()).preview(csrf),
  ).resolves.toMatchObject({ approveAlone: false });
  const invalid = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ ...escalated, approveAlone: "yes" }));
  await expect(
    createOrdinaryRefundClient(invalid).prepareRequest(command()).preview(csrf),
  ).rejects.toMatchObject({ code: "Unavailable" });
});

it("WP-2423 Q5: shows a declined request and sends an Other note only with that reason", async () => {
  const entry = {
    requestReference: id(40),
    operationReference: id(41),
    claimVersion: 1,
    requestedAt: "2026-09-20T12:00:00.000Z",
    reasonCode: "OTHER",
    currencyCode: "CAD",
    amountMinor: "1130",
    decline: {
      reasonCode: "ENTERED_IN_ERROR",
      declinedAt: "2026-09-20T12:05:00.000Z",
      declinerName: "Sam",
      declinedByYou: false,
    },
    progress: "Declined",
    paymentMethod: "Online",
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
    response({
      orderReference: id(1),
      orderNumber: "12",
      canRequest: true,
      claimVersion: 1,
      recentRequests: [entry],
      items: [],
    }),
  );
  expect((await createOrdinaryRefundClient(fetcher).items(id(1), csrf)).recentRequests).toEqual([
    entry,
  ]);
  const client = createOrdinaryRefundClient(vi.fn<typeof fetch>());
  expect(() => client.prepareRequest({ ...command(), reasonCode: "OTHER" })).toThrow();
  expect(() => client.prepareRequest({ ...command(), note: "Not allowed" })).toThrow();
  const sending = vi.fn<typeof fetch>().mockResolvedValueOnce(response(preview));
  await createOrdinaryRefundClient(sending)
    .prepareRequest({ ...command(), reasonCode: "OTHER", note: "  Customer left early " })
    .preview(csrf);
  expect(JSON.parse(String(sending.mock.calls[0]?.[1]?.body))).toMatchObject({
    reasonCode: "OTHER",
    note: "Customer left early",
  });
});

it("WP-2423 Q5: reads each request's progress and who may record requests", async () => {
  const base = {
    requestReference: id(40),
    operationReference: id(41),
    claimVersion: 1,
    requestedAt: "2026-09-20T12:00:00.000Z",
    reasonCode: "WRONG_ITEM",
    currencyCode: "CAD",
    amountMinor: "1130",
    decline: null,
    paymentMethod: "Online",
  };
  const items = (entry: unknown, canRequest: unknown = false) =>
    response({
      orderReference: id(1),
      orderNumber: "12",
      canRequest,
      claimVersion: 1,
      recentRequests: [entry],
      items: [],
    });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(items({ ...base, progress: "Refunded" }))
    .mockResolvedValueOnce(items({ ...base, progress: "Declined" }))
    .mockResolvedValueOnce(items({ ...base, progress: "Done" }))
    .mockResolvedValueOnce(items({ ...base, progress: "Sending" }, "yes"));
  const client = createOrdinaryRefundClient(fetcher);
  const read = await client.items(id(1), csrf);
  expect(read.canRequest).toBe(false);
  expect(read.recentRequests[0]?.progress).toBe("Refunded");
  for (let i = 0; i < 3; i++)
    await expect(client.items(id(1), csrf)).rejects.toMatchObject({ code: "Unavailable" });
});
it("WP-2423: a PIN sign-in refusal asks to confirm it is them; a plain 403 stays denied", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(preview))
    .mockResolvedValueOnce(response({ error: "full_sign_in_required" }, 403))
    .mockResolvedValueOnce(response({ error: "forbidden" }, 403))
    .mockResolvedValueOnce(response(recorded, 202));
  const operation = createOrdinaryRefundClient(fetcher).prepareRequest(command());
  await operation.preview(csrf);
  await expect(operation.submit(csrf)).rejects.toMatchObject({ code: "FullSignInRequired" });
  await expect(operation.submit(csrf)).rejects.toMatchObject({ code: "Denied" });
  // After confirming, the same request is retried and recorded once.
  await expect(operation.submit(csrf)).resolves.toMatchObject({ status: "RequestRecorded" });
  expect(new Set(fetcher.mock.calls.slice(1).map((call) => call[1]?.body)).size).toBe(1);
});

it("WP-2423 item 4: reads card-machine payments, items, request status and records the machine refund", async () => {
  const machineContext = { ...context, paymentMethod: "CardMachine" };
  const payment = {
    paymentAttemptReference: id(7),
    paymentIntentReference: id(6),
    state: "Confirmed",
    method: "CardMachine",
    refundedOnCardMachineAt: "2026-09-20T12:10:00.000Z",
    cardMachineSlipReference: "AUTH 1234",
    executionOperationReference: null,
    executionApprovalReference: null,
    amountMinor: "565",
    confirmedMinor: "565",
    pendingMinor: "0",
  };
  const status = {
    orderReference: id(1),
    requestReference: id(2),
    operationReference: id(3),
    observedAt: "2026-09-20T12:11:00.000Z",
    currencyCode: "CAD",
    amountMinor: "565",
    payments: [payment],
  };
  const recorded = {
    status: "Recorded",
    orderReference: id(1),
    requestReference: id(2),
    amountMinor: "565",
    refundedAt: "2026-09-20T12:10:00.000Z",
    receipt: "NoDigitalReceipt",
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(machineContext))
    // A card-machine payment that is not taken is never shown.
    .mockResolvedValueOnce(response({ ...machineContext, paymentState: "Unresolved" }))
    .mockResolvedValueOnce(response(status))
    // A card-machine refund is never prepared or sent.
    .mockResolvedValueOnce(
      response({
        ...status,
        payments: [{ ...payment, state: "Prepared", executionOperationReference: id(9) }],
      }),
    )
    .mockResolvedValueOnce(response(recorded))
    .mockResolvedValueOnce(response({ error: "approval_required" }, 409));
  const client = createOrdinaryRefundClient(fetcher);
  expect((await client.context(id(6), csrf)).paymentMethod).toBe("CardMachine");
  await expect(client.context(id(6), csrf)).rejects.toMatchObject({ code: "Unavailable" });
  const read = await client.status(id(1), id(3), csrf);
  expect(read.payments[0]).toMatchObject({
    method: "CardMachine",
    state: "Confirmed",
    refundedOnCardMachineAt: "2026-09-20T12:10:00.000Z",
    cardMachineSlipReference: "AUTH 1234",
  });
  await expect(client.status(id(1), id(3), csrf)).rejects.toMatchObject({ code: "Unavailable" });
  const command = {
    operationReference: id(10),
    orderReference: id(1),
    requestReference: id(2),
    slipReference: "AUTH 1234",
    refundedAt: null,
  };
  await expect(client.recordCardMachineRefund(command, csrf)).resolves.toEqual({
    status: "Recorded",
    amountMinor: "565",
    refundedAt: "2026-09-20T12:10:00.000Z",
    receipt: "NoDigitalReceipt",
  });
  expect(fetcher.mock.calls[4]?.[0]).toBe("/merchant/payments/refunds/card-machine-record");
  expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual(command);
  await expect(client.recordCardMachineRefund(command, csrf)).rejects.toMatchObject({
    code: "Conflict",
  });
  // A card number is never sent as the slip reference.
  await expect(
    client.recordCardMachineRefund({ ...command, slipReference: "4111 1111 1111 1111" }, csrf),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it("WP-2423 item 4: shows a recorded card-machine slip reference, never a card number or one not yet recorded", async () => {
  const payment = {
    paymentAttemptReference: id(7),
    paymentIntentReference: id(6),
    state: "Confirmed",
    method: "CardMachine",
    refundedOnCardMachineAt: "2026-09-20T12:10:00.000Z",
    cardMachineSlipReference: null,
    executionOperationReference: null,
    executionApprovalReference: null,
    amountMinor: "565",
    confirmedMinor: "565",
    pendingMinor: "0",
  };
  const status = (entry: Record<string, unknown>) => ({
    orderReference: id(1),
    requestReference: id(2),
    operationReference: id(3),
    observedAt: "2026-09-20T12:11:00.000Z",
    currencyCode: "CAD",
    amountMinor: "565",
    payments: [{ ...payment, ...entry }],
  });
  const fetcher = vi.fn<typeof fetch>();
  const client = createOrdinaryRefundClient(fetcher);
  // Recorded without a slip reference (it is optional).
  fetcher.mockResolvedValueOnce(response(status({})));
  expect(
    (await client.status(id(1), id(3), csrf)).payments[0]?.cardMachineSlipReference,
  ).toBeNull();
  for (const invalid of [
    { cardMachineSlipReference: "4111 1111 1111 1111" },
    { cardMachineSlipReference: "" },
    { cardMachineSlipReference: 1234 },
    {
      state: "NotDispatched",
      refundedOnCardMachineAt: null,
      confirmedMinor: "0",
      pendingMinor: "565",
      cardMachineSlipReference: "AUTH 1234",
    },
    {
      method: "Online",
      state: "NotDispatched",
      refundedOnCardMachineAt: null,
      confirmedMinor: "0",
      pendingMinor: "565",
      cardMachineSlipReference: "AUTH 1234",
    },
  ]) {
    fetcher.mockResolvedValueOnce(response(status(invalid)));
    await expect(client.status(id(1), id(3), csrf)).rejects.toMatchObject({ code: "Unavailable" });
  }
  const missing: Partial<typeof payment> = { ...payment };
  delete missing.cardMachineSlipReference;
  fetcher.mockResolvedValueOnce(response({ ...status({}), payments: [missing] }));
  await expect(client.status(id(1), id(3), csrf)).rejects.toMatchObject({ code: "Unavailable" });
});
