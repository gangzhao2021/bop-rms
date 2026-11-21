import { expect, it, vi } from "vitest";
import { orderQueryFixture } from "../../../packages/rms/ordering/src/tests/order-creation-query.fixture.js";
import { createCustomerIntactReservationPaymentAction } from "./customer-payment-workflow-action.js";

function options(paymentCommandCode: string) {
  const { record, scope } = orderQueryFixture();
  return {
    scope: { ...scope, tenantReference: "01909998-0000-7000-8000-000000000003" },
    currentOrder: record,
    quoteVersion: 1 as const,
    workflow: {
      purposeCode: "Synthetic",
      action: "CreatePaymentIntent",
      permissionCode: "synthetic.payment.create",
      paymentCommandCode,
      intactReservationRuleReference: "01909998-0000-7000-8000-000000000009",
    },
    authorize: vi.fn().mockResolvedValue(true),
    authorizeOverride: vi.fn().mockResolvedValue(false),
  };
}
it("constructs only the actual CreatePaymentIntent command capability", () => {
  expect(typeof createCustomerIntactReservationPaymentAction(options("CreatePaymentIntent"))).toBe(
    "function",
  );
});
it.each(["ConsumeInventory", "RefundPayment", "UnsupportedPaymentCommand"])(
  "cannot reinterpret %s as CreatePaymentIntent even if a Workflow used that configured name",
  (command) => {
    expect(() => createCustomerIntactReservationPaymentAction(options(command))).toThrow();
  },
);
