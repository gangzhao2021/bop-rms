import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { OrderAmendmentScreen, OrderAmendmentState } from "./OrderAmendmentPage.js";
import { parseOrderAmendmentView } from "./order-amendment-page.js";
const id = (n: number) => `018f9d00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fixture = () => ({
  screenId: "OPS-ORDER-AMEND",
  orderReference: id(1),
  orderNumber: "10042",
  expectedOrderVersion: 4,
  asOfUtc: "2026-08-13T23:00:00.000Z",
  reasonOptions: ["GUEST_REQUEST", "ITEM_UNAVAILABLE"],
  eligibleItems: [
    {
      orderItemReference: id(2),
      label: "Synthetic entrée",
      quantity: 2,
      configurationSummary: "Size M · no substitutions",
    },
  ],
  currencyCode: "CAD",
  originalTotalMinor: "2500",
  revisedTotalMinor: "2800",
  taxDeltaMinor: "39",
  kitchenImpact: "Pending Kitchen confirmation after work starts",
  fulfillmentImpact: "No confirmed Fulfillment change",
  paymentRefundConsequence: "Additional Payment action required",
  customerNotice: "Notice required after application",
  approvalStatus: "Required",
});
const render = (value: React.JSX.Element) =>
  renderToStaticMarkup(<MemoryRouter>{value}</MemoryRouter>);
describe("OPS-ORDER-AMEND", () => {
  it("strictly parses the complete Store-scoped impact view", () => {
    expect(parseOrderAmendmentView(fixture())).toMatchObject({
      screenId: "OPS-ORDER-AMEND",
      expectedOrderVersion: 4,
      approvalStatus: "Required",
    });
    expect(() => parseOrderAmendmentView({ ...fixture(), revisedTotalMinor: "$28.00" })).toThrow();
    expect(() =>
      parseOrderAmendmentView({ ...fixture(), customerNotice: "https://unsafe.invalid" }),
    ).toThrow();
  });
  it("renders reason, item, repricing, domain impacts and disabled actions", () => {
    const html = render(<OrderAmendmentScreen view={parseOrderAmendmentView(fixture())} />);
    for (const text of [
      "Controlled Order Amendment",
      "Expected Version 4",
      "Repricing",
      "Kitchen",
      "Payment / refund consequence",
      "Customer notice",
      "Submit Amendment",
      "cannot enter price",
    ])
      expect(html).toContain(text);
    expect(html).toContain("disabled");
  });
  it("covers every mandatory recovery state", () => {
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(render(<OrderAmendmentState state={state} />)).toMatch(
        /status|Loading|denied|unavailable|disabled|stale|changed|failed|Offline/u,
      );
  });
  it("renders the Empty state when no item is eligible", () => {
    const html = render(
      <OrderAmendmentScreen view={parseOrderAmendmentView({ ...fixture(), eligibleItems: [] })} />,
    );
    expect(html).toContain("No eligible Order items");
  });
});
