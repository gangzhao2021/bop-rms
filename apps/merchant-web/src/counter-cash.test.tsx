import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CashTenderFields, cashTender } from "./CashTenderFields.js";
import { cardMachinePaymentText } from "./CurrentOrderQueuePage.js";
import { paidNoteText, payErrorText } from "./counter-payment.js";
import { CounterOrderClientError, createCounterOrderClient } from "./staff-order-entry.js";

const id = (n: number) => "01a7e562-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("counter cash (WP-2423 M52)", () => {
  it("rounds the cash total to 5 cents and shows the change, by the table's rules", () => {
    expect(cashTender(2247n, "30")).toMatchObject({
      cashDueMinor: 2245n,
      receivedMinor: 3000n,
      changeMinor: 755n,
      ready: true,
    });
    expect(cashTender(2243n, "22.45")).toMatchObject({ changeMinor: 0n, ready: true });
    expect(cashTender(2243n, "22.40")).toMatchObject({ changeMinor: -5n, ready: false });
    expect(cashTender(2243n, "")).toMatchObject({ receivedMinor: null, ready: false });
    const markup = renderToStaticMarkup(
      <CashTenderFields
        idPrefix="t"
        dueMinor={2247n}
        received="30.00"
        onReceived={() => undefined}
        disabled={false}
      />,
    );
    expect(markup).toContain("Cash total $22.45 (rounded to 5 cents)");
    expect(markup).toContain("Exact $22.45");
    expect(markup).toContain("Change $7.55");
  });

  it("sends the cash handed over and reads the change the server worked out", async () => {
    let sent: unknown = null;
    const client = createCounterOrderClient("a".repeat(43), (async (
      _url: string,
      init: RequestInit,
    ) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          status: "Recorded",
          orderReference: id(20),
          orderBatchReference: id(21),
          amountMinor: "2247",
          recordingReason: "AtCounter",
          takenAt: "2026-11-11T18:01:00.000Z",
          recordedAt: "2026-11-11T18:01:00.000Z",
          cash: {
            cashTotalMinor: "2245",
            roundingMinor: "-2",
            tenderedMinor: "3000",
            changeMinor: "755",
          },
          acceptance: "Accepted",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);
    const paid = await client.recordPayment({
      operationReference: id(1),
      orderReference: id(20),
      orderBatchReference: id(21),
      expectedTotalMinor: "2247",
      slipReference: null,
      takenAt: null,
      tenderedMinor: "3000",
    });
    expect(sent).toMatchObject({ tenderedMinor: "3000", slipReference: null });
    expect(paid.cash).toEqual({
      cashTotalMinor: "2245",
      tenderedMinor: "3000",
      changeMinor: "755",
    });
    const short = createCounterOrderClient(
      "a".repeat(43),
      (async () =>
        new Response(JSON.stringify({ error: "cash_tender_short" }), {
          status: 409,
        })) as unknown as typeof fetch,
    );
    const refused = await short
      .recordPayment({
        operationReference: id(1),
        orderReference: id(20),
        orderBatchReference: id(21),
        expectedTotalMinor: "2247",
        slipReference: null,
        takenAt: null,
        tenderedMinor: "2000",
      })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "CashShort" });
    expect(payErrorText(refused as CounterOrderClientError)).toBe(
      "The cash received is less than the cash total.",
    );
  });

  it("tells the cashier the change to give, and Orders shows the cash taken", () => {
    expect(
      paidNoteText({
        tableMode: false,
        recordedAfterOutage: false,
        acceptance: "Accepted",
        cash: { changeMinor: "755" },
      }),
    ).toBe("Cash recorded. Give $7.55 change. Sent to the kitchen.");
    expect(cardMachinePaymentText(2245n, 0n, 0n, { changeMinor: "755" })).toBe(
      "Paid in cash $22.45 · change $7.55",
    );
    expect(cardMachinePaymentText(2245n, 435n, 0n, { changeMinor: "0" })).toBe(
      "Paid in cash $22.45 · $4.35 given back",
    );
    expect(cardMachinePaymentText(2245n, 0n)).toBe("Paid on card machine $22.45");
  });
});
