import { expect, it, vi } from "vitest";
import { createOrdinaryRefundExecutionClient } from "./ordinary-refund-execution-client.js";
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = () => ({
  operationReference: id(1),
  orderReference: id(2),
  requestReference: id(3),
  dispatchReference: id(4),
  auditReference: id(5),
  approvalReference: null,
});
const response = (value: unknown, status = 202) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("retains exact send identity and body after unknown outcome despite caller mutation", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockResolvedValueOnce(response({ status: "DispatchRecorded" }));
  const source = command(),
    original = JSON.stringify(source);
  const intent = createOrdinaryRefundExecutionClient(fetcher).prepareSend(source);
  source.dispatchReference = id(99);
  await expect(intent.execute("a".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(intent.execute("a".repeat(43))).resolves.toEqual({ status: "DispatchRecorded" });
  expect(
    fetcher.mock.calls.every(
      ([url, init]) =>
        url === "/merchant/payments/refunds/send" &&
        init?.body === original &&
        init.credentials === "same-origin",
    ),
  ).toBe(true);
});
it.each([
  ["refund_execution_unavailable", "Unavailable"],
  ["refund_execution_unknown", "OutcomeUnknown"],
])("distinguishes %s", async (error, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error }, 503));
  await expect(
    createOrdinaryRefundExecutionClient(fetcher).prepareSend(command()).execute("a".repeat(43)),
  ).rejects.toMatchObject({ code });
});
it("rejects extra caller money fields before any request", () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(() =>
    createOrdinaryRefundExecutionClient(fetcher).prepareSend({
      ...command(),
      amountMinor: "100",
    } as ReturnType<typeof command>),
  ).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("accepts only a closed reconciliation acknowledgment without a settlement claim", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ status: "ReconciliationRecorded", settled: true }))
    .mockResolvedValueOnce(
      response({
        status: "ReconciliationRecorded",
        receipt: { status: "Existing", version: 1, kind: "Original" },
      }),
    );
  const intent = createOrdinaryRefundExecutionClient(fetcher).prepareReconciliation({
    operationReference: id(1),
    orderReference: id(2),
    observationReference: id(6),
    auditReference: id(7),
  });
  await expect(intent.execute("a".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(intent.execute("a".repeat(43))).resolves.toEqual({
    status: "ReconciliationRecorded",
    receipt: { status: "Existing", version: 1, kind: "Original" },
  });
  expect(fetcher.mock.calls.every(([url]) => url === "/merchant/payments/refunds/reconcile")).toBe(
    true,
  );
});
