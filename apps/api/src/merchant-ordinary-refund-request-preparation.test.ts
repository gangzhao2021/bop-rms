import { expect, it, vi } from "vitest";
import {
  refundLegReference,
  withServerRefundPreparation,
} from "./merchant-ordinary-refund-request-preparation.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = { sessionCookie: "c", csrf: "x", command: { orderReference: id(1) } };
const recorded = (approvalRequired: boolean | null) => ({
  status: "Created",
  requestReference: id(2),
  approvalRequired,
  paymentAttemptReferences: [id(3), id(4)],
});

it("WP-2423 M16: a refund needing no approval is prepared with the request, with references the browser replays", async () => {
  const prepare = vi.fn(async (call: { command: unknown }) => {
    // The second payment was taken on the card machine: refunded there, never prepared here.
    if ((call.command as { paymentAttemptReference: string }).paymentAttemptReference === id(4))
      throw new Error("CARD_MACHINE");
    return { status: "Created" };
  });
  const result = await withServerRefundPreparation(async () => recorded(false), prepare)(input);
  const operation = refundLegReference(id(2), "operation:" + id(3));
  expect(result.prepared).toEqual([
    { paymentAttemptReference: id(3), operationReference: operation },
  ]);
  expect(prepare.mock.calls[0]?.[0]).toEqual({
    sessionCookie: "c",
    csrf: "x",
    command: {
      orderReference: id(1),
      requestReference: id(2),
      paymentAttemptReference: id(3),
      operationReference: operation,
      auditReference: refundLegReference(id(2), "operation-audit:" + id(3)),
      approvalReference: null,
    },
  });
  // The same request again derives the same operation (the prepare replays it).
  expect(refundLegReference(id(2), "operation:" + id(3))).toBe(operation);
  expect(operation).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});
it("WP-2423 M16: a refund waiting for approval, or whose need is unknown, is not prepared here", async () => {
  for (const approvalRequired of [true, null]) {
    const prepare = vi.fn();
    const result = await withServerRefundPreparation(
      async () => recorded(approvalRequired),
      prepare,
    )(input);
    expect(result.prepared).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  }
});
