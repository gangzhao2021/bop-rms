import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PickupCodePanel } from "./PickupCodePanel.js";
import type { PickupCodeController, PickupCodeState } from "./pickup-code-controller.js";

const id = (n: number) => `018f7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function controller(state: PickupCodeState): PickupCodeController {
  return {
    getState: () => state,
    reveal: async () => undefined,
    refresh: async () => undefined,
    close: () => undefined,
    setOnline: () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
  };
}

function render(state: PickupCodeState): string {
  return renderToStaticMarkup(
    <PickupCodePanel orderReference={id(1)} orderNumber="1001" controller={controller(state)} />,
  );
}

describe("CUST-PICKUP-CODE contextual screen", () => {
  it("starts with no proof and requires an explicit readiness check", () => {
    const html = render({ status: "hidden" });
    expect(html).toContain("Check pickup readiness");
    expect(html).toContain("stays hidden");
    expect(html).not.toContain("123456");
  });

  it("renders a synthetic Ready Human Code with an accessible alternative", () => {
    const html = render({
      status: "ready",
      refreshing: false,
      view: {
        schemaVersion: 1,
        status: "Ready",
        orderReference: id(1),
        orderNumber: "1001",
        storeDisplayName: "Synthetic Harbour Store",
        pickupInstruction: "Show this proof at the pickup counter.",
        generation: 1,
        proofKind: "HumanCode",
        proofValue: "123456",
        observedAt: "2026-08-11T13:55:00.000Z",
        expiresAt: "2026-08-11T14:30:00.000Z",
      },
    });
    expect(html).toContain("Ready for pickup");
    expect(html).toContain("123456");
    expect(html).toContain("Pickup proof 1 2 3 4 5 6");
    expect(html).toContain("does not complete the Order by itself");
  });

  it.each([
    ["loading", "Checking pickup readiness"],
    ["not-ready", "Pickup is not ready yet"],
    ["permission-denied", "access was denied"],
    ["not-found", "No authorized pickup proof"],
    ["feature-disabled", "disabled for this journey"],
    ["conflict", "Pickup proof changed"],
    ["unavailable", "No proof was retained"],
    ["offline", "has been cleared"],
    ["expired", "expired and has been cleared"],
  ] as const)("renders the %s state without a raw proof", (status, message) => {
    const html = render({ status });
    expect(html).toContain(message);
    expect(html).not.toContain("123456");
  });
});
