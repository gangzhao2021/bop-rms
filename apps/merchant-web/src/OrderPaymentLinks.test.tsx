import { expect, it } from "vitest";
import { createOrdinaryRefundClient } from "./ordinary-refund-client.js";
import { refundErrorText } from "./OrderPaymentLinks.js";

const order = "01909985-0000-7000-8000-000000000042";
const csrf = "a".repeat(43);
const answer = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })) as typeof fetch;

it("v15 751dd768 ②: staff without refund access are told who handles payments, in plain words", async () => {
  const error = await createOrdinaryRefundClient(answer(403, { error: "permission_denied" }))
    .items(order, csrf)
    .catch((value: unknown) => value);
  expect(refundErrorText(error)).toBe(
    "Payments and refunds for this order are handled by a manager. Ask a manager if the guest needs a refund.",
  );
  // A PIN sign-in that must be confirmed is not a missing permission.
  const pin = await createOrdinaryRefundClient(answer(403, { error: "full_sign_in_required" }))
    .items(order, csrf)
    .catch((value: unknown) => value);
  expect(refundErrorText(pin)).toMatch(/Confirm it's you/u);
});
