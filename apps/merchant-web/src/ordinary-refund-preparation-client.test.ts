import { expect, it, vi } from "vitest";
import { createOrdinaryRefundPreparationClient } from "./ordinary-refund-preparation-client";
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = () => ({
  operationReference: id(1),
  orderReference: id(2),
  requestReference: id(3),
  paymentAttemptReference: id(4),
  auditReference: id(5),
  approvalReference: null,
});
const csrf = "a".repeat(43);
const response = (value: unknown, status = 202) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const recorded = { status: "PreparationRecorded", operationReference: id(1), replayed: false };
it("retries the exact frozen intent after response loss using current CSRF", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("lost"))
    .mockResolvedValueOnce(response({ ...recorded, replayed: true }));
  const source = command();
  const operation = createOrdinaryRefundPreparationClient(fetcher).prepare(source);
  source.operationReference = id(9);
  await expect(operation.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(operation.execute("b".repeat(43))).resolves.toEqual({ ...recorded, replayed: true });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(command());
  expect(fetcher.mock.calls[1]).toEqual([
    "/merchant/payments/refunds/prepare",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: expect.objectContaining({ "X-BOP-CSRF": "b".repeat(43) }),
    }),
  ]);
});
it.each([
  [{ ...recorded, operationReference: id(99) }, 202],
  [{ ...recorded, status: "Refunded" }, 202],
  [{ ...recorded, replayed: "false" }, 202],
  [{ ...recorded, amountMinor: "100" }, 202],
  [recorded, 200],
])("does not infer completion from an invalid receipt %j", async (value, status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value, status));
  await expect(
    createOrdinaryRefundPreparationClient(fetcher).prepare(command()).execute(csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("rejects injected authority fields without making a request", () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(() =>
    createOrdinaryRefundPreparationClient(fetcher).prepare({
      ...command(),
      executorReference: id(99),
    } as ReturnType<typeof command>),
  ).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("requires CSRF before send and reports permission denial distinctly", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: "denied" }, 403));
  const intent = createOrdinaryRefundPreparationClient(fetcher).prepare(command());
  await expect(intent.execute("")).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "PermissionDenied" });
});

it("distinguishes exact unconfigured response from uncertain server failures", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ error: "refund_preparation_unavailable" }, 503))
    .mockResolvedValueOnce(response({ error: "other" }, 503));
  const intent = createOrdinaryRefundPreparationClient(fetcher).prepare(command());
  await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
