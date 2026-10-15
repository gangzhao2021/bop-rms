import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { cardMachinePaymentText, cardMachineRoundsText } from "./CurrentOrderQueuePage.js";
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

it("WP-2423: card-machine rounds show what was refunded on the machine, as the settlement counts it", () => {
  const round = (
    amountMinor: string,
    refundedMinor: string,
    staffCancellation: unknown = null,
  ) => ({
    staffRound: {
      recordedAfterOutage: false,
      paidOnCardMachine: { amountMinor, takenAt: "2026-10-15T18:00:00.000Z", refundedMinor },
      amountDueMinor: null,
    },
    staffCancellation,
  });
  const of = (...batches: unknown[]) => cardMachineRoundsText({ batches } as unknown as Order);
  // v15: every card-machine round cancelled by staff and refunded on the machine.
  expect(of(round("2486", "2486"), round("2195", "2195"))).toBe(
    "Paid on card machine $46.81 · refunded in full",
  );
  expect(of(round("2486", "1200"), round("2195", "0"))).toBe(
    "Paid on card machine $46.81 · $12.00 refunded",
  );
  // A staff cancellation whose card-machine refund is not recorded yet.
  expect(
    of(
      round("2486", "0", {
        refundMethod: "CardMachine",
        refundStatus: "Pending",
        refundAmountMinor: "2486",
      }),
    ),
  ).toBe("Paid on card machine $24.86 · $24.86 to refund on the card machine");
  expect(cardMachinePaymentText(672n, 0n)).toBe("Paid on card machine $6.72");
  expect(cardMachinePaymentText(672n, 672n)).toBe("Paid on card machine $6.72 · refunded in full");
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
