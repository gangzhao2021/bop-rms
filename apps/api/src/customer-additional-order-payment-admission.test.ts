import { beforeEach, expect, it, vi } from "vitest";
import { createPaymentIntentCreationService } from "@rms/payment";
import {
  harness,
  command,
  at,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
import { createCustomerAdditionalOrderPaymentClaimAdmission } from "./customer-order-payment-admission.js";
const owner = vi.hoisted(() => vi.fn());
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresAdditionalDiningBatchHistoryReader: owner,
}));
beforeEach(() => owner.mockReset());
it.each(["valid", "batch", "query"])(
  "admits additional payment only with valid owner evidence: %s",
  async (mode) => {
    const h = harness();
    const payment = (await createPaymentIntentCreationService(h.ports).create(command())).record;
    const p = payment.intent.preparation;
    const transaction = {
      query: vi.fn().mockResolvedValue(mode === "query" ? { rows: [] } : { rows: [], rowCount: 0 }),
    };
    const downstream = vi.fn().mockResolvedValue({ validUntil: p.capacityExpiresAt });
    owner.mockImplementation((options) => ({
      withCurrentSubmission: async (
        _reference: string,
        _at: string,
        action: (...args: unknown[]) => Promise<unknown>,
      ) =>
        options.transactions.run(
          async (tx: { query(sql: string, values: unknown[]): Promise<unknown> }) => {
            await tx.query("SELECT synthetic_owner_probe", []);
            return action(
              tx,
              {
                snapshotVersion: 1,
                orderReference: p.orderReference,
                guestSessionReference: p.guestSessionReference,
                batch: {
                  orderBatchReference: mode === "batch" ? p.orderReference : p.orderBatchReference,
                  submissionReference: p.submissionReference,
                  sourceCartReference: p.sourceCartReference,
                  sourceCartVersion: p.sourceCartVersion,
                  quoteReference: p.quoteReference,
                  submittedAt: p.committedAt,
                },
              },
              {
                paymentOperationReference: payment.intent.paymentOperationReference,
                commitmentReference: p.capacityAllocationReference,
              },
            );
          },
        ),
    }));
    const admission = createCustomerAdditionalOrderPaymentClaimAdmission({
      scope: { brandReference: p.brandReference, storeReference: p.storeReference },
      quoteVersion: 1,
      authorizeHistory: async () => true,
      capacityForSubmission: () => ({ admit: downstream }),
    });
    const result = await admission.admit(transaction, payment, at);
    if (mode === "valid") {
      expect(result).toEqual({ validUntil: p.capacityExpiresAt });
      expect(downstream.mock.calls[0]?.[0]).toBe(transaction);
    } else {
      expect(result).toBe(false);
      expect(downstream).not.toHaveBeenCalled();
    }
    expect(transaction.query).toHaveBeenCalledWith("SELECT synthetic_owner_probe", []);
  },
);
