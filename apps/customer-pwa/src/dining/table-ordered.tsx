import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  createHttpDiningSessionClient,
  type DiningSessionClient,
  type DiningSessionView,
} from "./dining-session-client.js";

/**
 * WP-2423 item 8 ③ (Owner decision 13): while a guest at a table chooses dishes, the menu says
 * "This table already ordered 2" for a dish anyone at the table ordered, so two phones don't
 * order the same dish by mistake. Counted from the table's own rounds (cancelled dishes left
 * out); nobody's name is shown. Read once when the menu opens; nothing is said when it can't be
 * read.
 */
export type TableOrderedCounts = ReadonlyMap<string, number>;

const TableOrdered = createContext<TableOrderedCounts>(new Map());

/** How many of each menu item the table ordered, by menu item. */
export function tableOrderedCounts(view: DiningSessionView): TableOrderedCounts {
  const counts = new Map<string, number>();
  for (const round of view.rounds)
    for (const item of round.items)
      if (!item.cancelled && item.orderAgain !== undefined)
        counts.set(
          item.orderAgain.sellableReference,
          (counts.get(item.orderAgain.sellableReference) ?? 0) + item.quantity,
        );
  return counts;
}

export function TableOrderedProvider({
  enabled,
  client,
  initial,
  children,
}: {
  readonly enabled: boolean;
  readonly client?: DiningSessionClient | undefined;
  /** Counts known before the read (tests). */
  readonly initial?: TableOrderedCounts | undefined;
  readonly children: ReactNode;
}) {
  const [counts, setCounts] = useState<TableOrderedCounts>(() => initial ?? new Map());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    (client ?? createHttpDiningSessionClient())
      .load(controller.signal)
      .then((view) => {
        if (!controller.signal.aborted) setCounts(tableOrderedCounts(view));
      })
      .catch(() => {
        /* Not known: the menu says nothing rather than a guessed count. */
      });
    return () => controller.abort();
  }, [enabled, client]);
  return <TableOrdered.Provider value={counts}>{children}</TableOrdered.Provider>;
}

/** The table's count for a dish (all its sizes); 0 when none or not known. */
export function useTableOrderedCount(sellableReferences: readonly string[]): number {
  const counts = useContext(TableOrdered);
  return sellableReferences.reduce((sum, reference) => sum + (counts.get(reference) ?? 0), 0);
}
