import { wordGap } from "./word-gap.js";
import { t } from "./i18n/i18n.js";
import { servableQuantity, type DiningProgress } from "./dining-progress-client.js";
import type { DiningServeReadyResult } from "./dining-serve-ready-client.js";

type Item = DiningProgress["items"][number];

/** Items staff can hand over now: kitchen-ready with something left to serve, at an open table. */
export function readyToServe(view: DiningProgress, batchSequence?: number): readonly Item[] {
  // A table checking out (Closing) is still served: its last dishes come before it closes.
  if (
    (view.sessionPhase !== "Active" && view.sessionPhase !== "Closing") ||
    view.closureStatus !== "Open"
  )
    return [];
  return view.items.filter(
    (item) =>
      item.phase === "Ready" &&
      // WP-2423 (2026-10-18): a portion the kitchen is remaking is not ready to serve.
      servableQuantity(item) >= 1 &&
      (batchSequence === undefined || item.batchSequence === batchSequence),
  );
}

const items = (count: number) => (count === 1 ? t("1 item") : t("{count} items", { count: count }));

/**
 * The result in staff words: what was served and what still needs a look.
 * Batch 67 (v15 b66 live, D66 A): "All served" under one round said "All 2 items marked served."
 * while the table's next round still had a dish to serve. With `table` (the whole table's dishes,
 * served and ordered, after this serve), a table with more to serve is said as such instead.
 */
export function serveReadySummary(
  result: DiningServeReadyResult,
  table?: { readonly served: number; readonly ordered: number } | null,
): string {
  const parts: string[] = [];
  const notServed = result.changed + result.failed;
  if (result.served > 0)
    parts.push(
      notServed === 0 && result.alreadyServed === 0
        ? table != null && table.served < table.ordered
          ? t("{served} of {ordered} items served.", {
              served: table.served,
              ordered: table.ordered,
            })
          : t("All {served} marked served.", { served: items(result.served) })
        : t("{served} served.", { served: result.served }),
    );
  if (result.alreadyServed > 0)
    parts.push(
      t("{alreadyServed} {value} already marked served by someone else.", {
        alreadyServed: result.alreadyServed,
        value: result.alreadyServed === 1 ? "was" : "were",
      }),
    );
  if (result.changed > 0)
    parts.push(
      t(
        "{changed} could not be served because {value} changed (cancelled, partly served or the table moved). Check {value2} and try again.",
        {
          changed: result.changed,
          value: result.changed === 1 ? "it" : "they",
          value2: result.changed === 1 ? "it" : "them",
        },
      ),
    );
  if (result.failed > 0)
    parts.push(
      t("{failed} could not be served right now. {value} still ready; try again.", {
        failed: result.failed,
        value: result.failed === 1 ? "It is" : "They are",
      }),
    );
  return parts.join(wordGap());
}
