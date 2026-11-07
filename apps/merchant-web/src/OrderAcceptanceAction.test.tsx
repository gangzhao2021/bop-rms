// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { OrderAcceptanceAction } from "./OrderAcceptanceAction.js";
import { OrderAcceptanceClientError } from "./order-acceptance-client.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";
import { acceptanceCloseControl } from "./CurrentOrderQueuePage.js";

afterEach(() => document.body.replaceChildren());

type CloseWith = Parameters<typeof OrderAcceptanceAction>[0]["closeWith"];
const refusedAsRefunded = async (closeWith: CloseWith) => {
  const operation = (() => ({
    execute: async () => {
      throw new OrderAcceptanceClientError("Conflict", "FullyRefunded");
    },
  })) as unknown as Parameters<typeof OrderAcceptanceAction>[0]["operation"];
  const { container } = await mount(
    <OrderAcceptanceAction
      orderNumber="A12"
      csrf={"a".repeat(43)}
      operation={operation}
      onAccepted={() => undefined}
      onRejected={() => undefined}
      {...(closeWith === undefined ? {} : { closeWith })}
    />,
  );
  await click(buttonNamed(container, "Accept A12"));
  await settle();
  return container.querySelector('[role="status"]')?.textContent;
};

it("WP-2423 M10: an order refunded in full is closed with the control the reader actually has", async () => {
  // A manager or owner has the general cancel, so the panel shows Refuse and refund, not Can't make it.
  expect(await refusedAsRefunded("RefuseAndRefund")).toBe(
    "This order was refunded in full. Close it with Refuse and refund.",
  );
  expect(await refusedAsRefunded("CantMake")).toBe(
    "This order was refunded in full. Close it with Can't make it.",
  );
  expect(await refusedAsRefunded("RefundInstead")).toBe(
    "This order was refunded in full. Close it with Refund instead.",
  );
  // Nobody is sent to a button they don't have.
  expect(await refusedAsRefunded(undefined)).toBe(
    "This order was refunded in full. Ask a manager to close it.",
  );
});

it("WP-2423 M10: the close control follows what the order panel shows", () => {
  expect(acceptanceCloseControl({ canCancel: true, canCantMake: false })).toBe("RefuseAndRefund");
  expect(acceptanceCloseControl({ canCancel: false, canCantMake: true })).toBe("CantMake");
  expect(acceptanceCloseControl({ canCancel: false, canCantMake: false })).toBeNull();
});
