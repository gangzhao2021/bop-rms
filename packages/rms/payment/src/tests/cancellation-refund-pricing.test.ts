import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import {
  cancellationRequestFixture,
  ordinaryRefundRequestFixture,
  must,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";

const mocks = vi.hoisted(() => ({ allocate: vi.fn() }));
vi.mock("@rms/ordering", () => ({
  createPostgresOrderRefundBasisReader: () => ({
    load: async () => ({
      quoteVersion: 1,
      cartReference: "cart",
      cartVersion: 1,
      quoteInputDigest: "sha256:" + "a".repeat(64),
      items: [
        {
          orderItemReference: "01909980-0000-7000-8000-00000000000e",
          quoteLineReference: "line-1",
          quantity: 1,
          subtotalMinor: 5000n,
          discountMinor: 0n,
          taxMinor: 500n,
          feeMinor: 0n,
          totalMinor: 5500n,
        },
      ],
    }),
  }),
}));
vi.mock("@rms/pricing", () => ({
  createPostgresPriceQuoteHistoryReader: () => ({
    load: async () => ({
      cartReference: "cart",
      cartVersion: 1,
      inputDigest: "sha256:" + "a".repeat(64),
      total: { amountMinor: 6000n },
      createdAt: "2026-09-13T08:00:00.000Z",
      lines: [
        {
          lineReference: "line-1",
          quantity: 1,
          subtotal: { amountMinor: 5000n },
          discount: { amountMinor: 0n },
          tax: { amountMinor: 500n },
          fee: { amountMinor: 0n },
          total: { amountMinor: 5500n },
        },
      ],
    }),
  }),
  createPostgresConfiguredPriceQuoteHistoryReader: () => ({ load: async () => null }),
  allocateOrdinaryRefundFromQuote: mocks.allocate,
}));
const { createPostgresOrdinaryRefundPricingSource } =
  await import("../infrastructure/ordinary-refund-pricing-source.js");

const validate = createPostgresOrdinaryRefundPricingSource({
  scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  authorize: async () => true,
});
async function reproduce(value: unknown) {
  const request = parseOrdinaryRefundRequest(value);
  const payment = must(request.payments[0]);
  mocks.allocate.mockImplementation((_quote, input: { tipAmountMinor: bigint }) => ({
    sourceReference: payment.sourceReference,
    sourceDigest: payment.sourceDigest,
    items: payment.items.map((item) => ({
      orderItemReference: item.orderItemReference,
      refundQuantity: item.refundUnitOrdinals.length,
      refundUnitOrdinals: item.refundUnitOrdinals,
      components: { ...item.components, tipAmountMinor: input.tipAmountMinor === 0n ? 0n : 500n },
    })),
  }));
  const result = await validate({ query: vi.fn() } as unknown as ConsumerTransaction, {
    request,
    payment,
    history: [],
    preparation: {
      orderReference: id(4),
      brandReference: id(2),
      storeReference: id(3),
      orderBatchReference: id(90),
      submissionReference: id(91),
      quoteReference: id(92),
      committedAt: "2026-09-13T09:00:00.000Z",
      orderAllocation: { amountMinor: 6000n },
      tip: { amountMinor: 500n },
    } as never,
  });
  return {
    result,
    tip: (mocks.allocate.mock.lastCall?.[1] as { tipAmountMinor: bigint }).tipAmountMinor,
  };
}

it("reproduces a Cancellation claim with tip = 0 from the original quote", async () => {
  await expect(reproduce(cancellationRequestFixture())).resolves.toEqual({
    result: true,
    tip: 0n,
  });
});

it("keeps ordinary reproduction with the captured tip", async () => {
  await expect(reproduce(ordinaryRefundRequestFixture())).resolves.toEqual({
    result: true,
    tip: 500n,
  });
});
