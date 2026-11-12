// @vitest-environment jsdom
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { RefundRecoveryView } from "./ordinary-refund-client.js";
import { MoneyTakenBack } from "./RefundPaymentPage.js";
import { buttonNamed, click, mount, typeInto } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";

afterEach(() => {
  document.body.replaceChildren();
  setLanguageForTest("en");
  vi.restoreAllMocks();
});

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
// A counter cash order: $3.67 refunded, $3.65 given back from the drawer.
const cash = {
  paymentIntentReference: id(1),
  paymentAttemptReference: id(2),
  orderReference: id(3),
  orderBatchReference: id(4),
  observedAt: "2026-11-11T17:52:00.000Z",
  paymentState: "Captured" as const,
  paymentMethod: "CardMachine" as const,
  paidInCash: true,
  cashLeftMinor: "0" as string | null,
  currencyCode: "CAD" as const,
  capturedAmountMinor: "367",
  confirmedRefundMinor: "367",
  pendingRefundMinor: "0",
  canRequest: true,
  requestBlocked: null,
  canSend: true,
  canRecover: true,
  recoveries: [] as RefundRecoveryView[],
  cashTakeBackLeftMinor: "365" as string | null,
};
const open = async (context: typeof cash) => {
  const { container } = await mount(
    <MemoryRouter>
      <MoneyTakenBack context={context} csrf="c" onRecorded={() => undefined} />
    </MemoryRouter>,
  );
  await click(buttonNamed(container, /Take money back|收回多退的钱/u));
  return container;
};
const status = (container: HTMLElement) => container.querySelector("[role=status]")?.textContent;

// b10 cash-refund-approvals: the guest can only hand back the cash the drawer gave them, never
// "charged on the card machine", and never more than that cash.
it("b10: money taken back on a cash order is cash only, in whole nickels, up to the cash given back", async () => {
  const sent = vi.spyOn(globalThis, "fetch");
  const container = await open(cash);
  expect(container.textContent).not.toContain("Charged on the card machine");
  expect(container.querySelector("input[type=radio]")).toBeNull();
  expect(container.textContent).toContain(
    "Paid in cash: the guest hands back cash, in whole nickels.",
  );
  expect(container.querySelector("label[for=recovery-amount]")?.textContent).toBe(
    "Cash handed back (up to $3.65)",
  );
  const field = container.querySelector("#recovery-amount");
  const record = () => click(buttonNamed(container, "Record money taken back"));
  await typeInto(field, "3.67");
  await record();
  expect(status(container)).toBe("Cash comes back in whole nickels, for example 3.65.");
  await typeInto(field, "3.70");
  await record();
  expect(status(container)).toBe("That is more than the $3.65 given back in cash.");
  expect(sent).not.toHaveBeenCalled();
});

it("b10: any other order keeps cash and the card machine, up to its confirmed refunds", async () => {
  const container = await open({
    ...cash,
    paidInCash: false,
    cashLeftMinor: null,
    cashTakeBackLeftMinor: null,
  });
  expect(container.textContent).toContain("Charged on the card machine");
  expect(container.querySelector("label[for=recovery-amount]")?.textContent).toBe(
    "Amount (up to $3.67)",
  );
});

it("b10: the cash-only form reads in Chinese with no card machine", async () => {
  setLanguageForTest("zh-Hans");
  const container = await open(cash);
  expect(container.querySelector("label[for=recovery-amount]")?.textContent).toBe(
    "还回的现金（最多 $3.65）",
  );
  expect(container.textContent).toContain("这单用现金付款：顾客还回现金，按 5 分取整。");
  expect(container.textContent).not.toContain("刷卡机");
});
