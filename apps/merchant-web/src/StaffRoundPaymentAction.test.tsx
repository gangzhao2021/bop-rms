import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { cardMachineRoundsText } from "./CurrentOrderQueuePage.js";
import { StaffRoundPaymentAction } from "./StaffRoundPaymentAction.js";

type Order = Parameters<typeof cardMachineRoundsText>[0];
const order = (amounts: (string | null)[]) =>
  ({
    batches: amounts.map((amountMinor) => ({
      staffRound:
        amountMinor === undefined
          ? null
          : {
              recordedAfterOutage: false,
              paidOnCardMachine:
                amountMinor === null ? null : { amountMinor, takenAt: "2026-10-15T18:00:00.000Z" },
              amountDueMinor: null,
            },
    })),
  }) as unknown as Order;

it("WP-2423 D5: shows what the table's staff rounds took on the card machine, apart from online", () => {
  expect(cardMachineRoundsText(order(["2486", null, "1200"]))).toBe("Paid on card machine $36.86");
  expect(cardMachineRoundsText(order([null]))).toBeNull();
  expect(cardMachineRoundsText({ batches: [{ staffRound: null }] } as unknown as Order)).toBeNull();
});

it("WP-2423 D5: offers the card-machine payment of an unpaid staff round on Orders", () => {
  const html = renderToStaticMarkup(
    <StaffRoundPaymentAction
      csrf={"a".repeat(43)}
      orderReference="0198a7c0-0000-7000-8000-000000000001"
      orderBatchReference="0198a7c0-0000-7000-8000-000000000002"
      amountDueMinor="2486"
      recordedAfterOutage={false}
      onRecorded={() => undefined}
    />,
  );
  expect(html).toContain("Record card-machine payment · $24.86");
  expect(html).not.toMatch(/0198a7c0|undefined/u);
});

it("WP-2423 D5: the Orders list leaves the amount out; it is read when the form is opened", () => {
  const html = renderToStaticMarkup(
    <StaffRoundPaymentAction
      csrf={"a".repeat(43)}
      orderReference="0198a7c0-0000-7000-8000-000000000001"
      orderBatchReference="0198a7c0-0000-7000-8000-000000000002"
      amountDueMinor={null}
      loadAmountDue={async () => "2486"}
      recordedAfterOutage={false}
      onRecorded={() => undefined}
    />,
  );
  expect(html).toContain("Record card-machine payment</button>");
  expect(html).not.toMatch(/\$|0198a7c0|undefined|null/u);
});
