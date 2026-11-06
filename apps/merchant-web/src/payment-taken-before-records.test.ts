import { afterEach, expect, it } from "vitest";
import { payErrorText } from "./counter-payment.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { createCounterOrderClient } from "./staff-order-entry.js";
import { createTableCheckoutClient } from "./table-checkout-client.js";

const refused = (async () =>
  new Response(JSON.stringify({ error: "taken_before_records" }), {
    status: 409,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })) as unknown as typeof fetch;
const reference = "01909969-0000-7000-8000-000000000002";
afterEach(() => setLanguageForTest("en"));

/**
 * WP-2423 M160: a paid-at time entered after an outage that is before the store started recording
 * sales is refused by the server (it would be in no report or settlement); staff are told what to
 * check, in their language, with no code.
 */
it("WP-2423 M160: a card-machine paid-at time before the store's records is explained to staff", async () => {
  const failure = await createCounterOrderClient("c".repeat(43), refused)
    .recordPayment({
      operationReference: reference,
      orderReference: reference,
      orderBatchReference: reference,
      expectedTotalMinor: "1000",
      slipReference: "AUTH 1",
      takenAt: "2026-11-04T20:00:00.000Z",
    })
    .catch((error: unknown) => error);
  expect((failure as { code?: unknown }).code).toBe("TakenBeforeRecords");
  const text = payErrorText(failure as Parameters<typeof payErrorText>[0]);
  expect(text).toMatch(/before this store started recording sales/u);
  setLanguageForTest("zh-Hans");
  expect(payErrorText(failure as Parameters<typeof payErrorText>[0])).toBe(
    "这个付款时间早于本店开始在系统里记录销售的时间。请核对实际付款时间后重新填写。",
  );
});

it("WP-2423 M160: a table paid-at time before the store's records reads as its own refusal", async () => {
  const failure = await createTableCheckoutClient(refused)
    .settle("c".repeat(43), {
      operationReference: reference,
      diningSessionReference: reference,
      method: "Cash",
      tip: { kind: "None" },
      tenderedMinor: "2000",
      slipReference: null,
      takenAt: "2026-11-04T20:00:00.000Z",
    })
    .catch((error: unknown) => error);
  expect((failure as { code?: unknown }).code).toBe("TakenBeforeRecords");
});
