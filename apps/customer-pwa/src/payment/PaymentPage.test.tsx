import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PaymentPage } from "./PaymentPage.js";
import type { PaymentController } from "./payment-controller.js";
import type { PaymentMode, PaymentState } from "./types.js";

const id = (n: number) => `018f7900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function controller(state: PaymentState): PaymentController {
  return {
    getState: () => state,
    load: async () => undefined,
    start: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
  };
}

function render(mode: PaymentMode, state: PaymentState): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PaymentPage mode={mode} controller={controller(state)} />
    </MemoryRouter>,
  );
}

describe("CUST-PAYMENT and CUST-CHECKOUT-RESULT contracts", () => {
  it("renders the Provider gate without a payment method or success claim", () => {
    const html = render("handoff", { status: "provider-unavailable" });
    expect(html).toContain("Payment is not available");
    expect(html).toContain("No Payment request was sent and no Order was created");
    expect(html).toContain("Cash, manual card entry, Staff Terminal");
    expect(html).not.toContain("Start secure payment");
  });

  it("keeps Unknown distinct and offers only same-operation verification", () => {
    const html = render("result", {
      status: "unknown",
      operationReference: id(1),
      canRetrySameOperation: true,
    });
    expect(html).toContain("Payment result unknown");
    expect(html).toContain("Neither success nor failure is assumed");
    expect(html).toContain("Verify the same payment operation");
  });

  it("renders the authoritative Order navigation only for Succeeded", () => {
    const html = render("result", {
      status: "succeeded",
      operationReference: id(1),
      orderReference: id(2),
    });
    expect(html).toContain("Payment confirmed");
    expect(html).toContain(`/orders/${id(2)}`);
    expect(html).toContain(id(1));
  });

  it("does not read URL or fragment callback claims", () => {
    const page = readFileSync(new URL("./PaymentPage.tsx", import.meta.url), "utf8");
    const controller = readFileSync(new URL("./payment-controller.ts", import.meta.url), "utf8");
    expect(`${page}\n${controller}`).not.toMatch(
      /useSearchParams|window\.location|location\.search|location\.hash|URLSearchParams/u,
    );
  });

  it.each([
    ["loading", "Verifying payment"],
    ["context-missing", "Payment context is missing"],
    ["offline", "Payment requires a connection"],
    ["pending", "Payment pending"],
    ["failed", "Payment failed"],
  ] as const)("renders the %s result state", (status, message) => {
    const state: PaymentState =
      status === "loading" || status === "context-missing" || status === "offline"
        ? { status }
        : status === "pending"
          ? { status, operationReference: id(1) }
          : { status, operationReference: id(1), safeReasonCode: "SYNTHETIC_DECLINE" };
    expect(render("result", state)).toContain(message);
  });
});
