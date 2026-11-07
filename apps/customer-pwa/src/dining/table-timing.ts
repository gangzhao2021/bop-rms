import { useEffect, useState } from "react";
import { getTablePaymentTiming } from "../session/customer-transaction-context.js";
import {
  createHttpDiningSessionClient,
  type DiningSessionClient,
} from "./dining-session-client.js";

/** "Other": pays first, pickup, or not known (the server says if the table pays at the end). */
export type TableTimingAnswer = "PayLater" | "Other" | "Loading";

const answerFor = (timing: "PayFirst" | "PayLater") =>
  timing === "PayLater" ? "PayLater" : "Other";

/**
 * WP-2423 item 6 (DEC-DINE-IN-PAY-LATER): how this table pays, for a page that asks differently. The
 * table is read only when it isn't known yet (the menu has usually read it); a failed read means
 * "Other", which behaves as before and lets the server decide.
 */
export function useTablePaymentTiming(
  dineIn: boolean,
  client?: DiningSessionClient,
): TableTimingAnswer {
  const [read, setRead] = useState<TableTimingAnswer | null>(null);
  const known = getTablePaymentTiming();
  useEffect(() => {
    if (!dineIn || known !== null) return;
    const controller = new AbortController();
    (client ?? createHttpDiningSessionClient())
      .load(controller.signal)
      .then((view) => {
        if (!controller.signal.aborted) setRead(answerFor(view.paymentTiming));
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead("Other");
      });
    return () => controller.abort();
  }, [dineIn, known, client]);
  if (!dineIn) return "Other";
  return known !== null ? answerFor(known) : (read ?? "Loading");
}
