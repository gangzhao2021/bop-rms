import { useEffect, useState } from "react";
import {
  createHttpDiningSessionClient,
  type DiningSessionClient,
} from "./dining-session-client.js";

export interface TableMove {
  readonly from: string;
  readonly table: string;
}

/**
 * WP-2423 (table-move-payment review, 2026-11-06): the table staff moved this phone's party from,
 * for a page other than the table page (the order page the paying phone lands on). Read once from
 * the table; no move, a failed read or a non-table order shows nothing.
 */
export function useTableMove(dineIn: boolean, client?: DiningSessionClient): TableMove | null {
  const [move, setMove] = useState<TableMove | null>(null);
  useEffect(() => {
    if (!dineIn) return;
    const controller = new AbortController();
    (client ?? createHttpDiningSessionClient())
      .load(controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        setMove(
          view.movedFromTableLabel !== undefined && view.tableLabel
            ? Object.freeze({ from: view.movedFromTableLabel, table: view.tableLabel })
            : null,
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [dineIn, client]);
  return dineIn ? move : null;
}
