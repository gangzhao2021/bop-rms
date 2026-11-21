// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionPaymentClientError } from "../payment/session-payment-client.js";
import type { SessionPaymentResult } from "../payment/session-payment-result-client.js";
import {
  setCheckoutSessionReference,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

const read = vi.fn<(session: string) => Promise<SessionPaymentResult>>();
vi.mock("../payment/session-payment-result-client.js", () => ({
  createSessionPaymentResultClient: () => ({ read, reconcile: read }),
}));
vi.mock("../payment/ResumePaymentPanel.js", () => ({
  ResumePaymentPanel: () => <p>Finish paying panel</p>,
}));
const { FinishPickupPayment } = await import("./FinishPickupPayment.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => "01909992-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const session = id(1),
  order = id(2);
const open: SessionPaymentResult = {
  checkoutSessionReference: session,
  paymentIntentReference: id(3),
  orderReference: order,
  status: "Pending",
  total: { amountMinor: "1130", currency: "CAD" },
  payBy: "2026-11-06T20:30:00.000Z",
  failure: null,
};
const elsewhere = "Finish paying on the phone you ordered with";
const unchecked = "Couldn’t check your payment. Try again.";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  setCustomerCsrfCredential("a".repeat(43));
  setCheckoutSessionReference(session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCheckoutSessionReference(null);
  read.mockReset();
});
const flush = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
const mount = async () => {
  act(() =>
    root.render(
      <MemoryRouter>
        <FinishPickupPayment orderReference={order} />
      </MemoryRouter>,
    ),
  );
  await flush();
};

it("WP-2423 M18 review: a failed read of the payment is a retryable outage, never another phone", async () => {
  read.mockRejectedValueOnce(new SessionPaymentClientError("unknown")).mockResolvedValueOnce(open);
  await mount();
  expect(container.textContent).toContain(unchecked);
  expect(container.textContent).not.toContain(elsewhere);
  const button = container.querySelector("button");
  if (!button) throw new Error("no Try again");
  expect(button.textContent).toBe("Try again");
  act(() => button.click());
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Finish paying panel");
  expect(container.textContent).not.toContain(unchecked);
});

it("WP-2423 M18 review: back online after a failed read, the payment is read again by itself", async () => {
  read.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(open);
  await mount();
  expect(container.textContent).toContain(unchecked);
  act(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Finish paying panel");
});

it("WP-2423 M18: a checkout the server says is not this phone's still points to the ordering phone", async () => {
  read.mockRejectedValueOnce(new SessionPaymentClientError("denied"));
  await mount();
  expect(container.textContent).toContain(elsewhere);
  expect(container.textContent).not.toContain(unchecked);
});
