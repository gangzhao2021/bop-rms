import { createHash } from "node:crypto";
import {
  parsePaymentReference,
  parsePaymentInstant,
} from "../../packages/rms/payment/src/index.ts";

/**
 * The reference of the settlement run that closes one Store business day. The scheduler creates
 * the run under this reference (so a repeated schedule is idempotent) and the day-end page reads
 * it back by the same derivation; nothing guesses which run settled a day from its timestamps.
 * UUIDv7-shaped: the time part is the day's end, the rest a digest of the day's identity.
 */
export function dailySettlementRunReference({
  brandReference,
  storeReference,
  businessDate,
  startsAt,
  endsAt,
}) {
  const brand = String(parsePaymentReference(brandReference)),
    store = String(parsePaymentReference(storeReference)),
    from = parsePaymentInstant(startsAt),
    to = parsePaymentInstant(endsAt);
  if (
    typeof businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate) ||
    new Date(`${businessDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== businessDate ||
    from >= to
  )
    throw Error("DAILY_SETTLEMENT_WINDOW_INVALID");
  const key = JSON.stringify([brand, store, businessDate, from, to]);
  const stamp = Date.parse(to).toString(16).padStart(12, "0"),
    h = createHash("sha256")
      .update("BOP_INTERNAL_DAILY_SCHEDULE_V1:" + key)
      .digest("hex");
  return Object.freeze({
    key,
    runReference: String(
      parsePaymentReference(
        stamp.slice(0, 8) +
          "-" +
          stamp.slice(8) +
          "-7" +
          h.slice(0, 3) +
          "-" +
          (8 + (parseInt(h[3], 16) & 3)).toString(16) +
          h.slice(4, 7) +
          "-" +
          h.slice(7, 19),
      ),
    ),
  });
}
