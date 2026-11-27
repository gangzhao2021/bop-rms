import { useEffect } from "react";
import { useNavigate } from "react-router";
import { saidTable, t } from "../i18n/i18n.js";
import {
  forgetKeptUnseatedTableWait,
  getUnseatedTableWait,
  keepUnseatedTableWait,
  setTableOpenedWhileAway,
  type UnseatedTableWait,
} from "../session/customer-transaction-context.js";
import {
  tableWaitBusyLongestWaitSeconds,
  tableWaitCheckDelaysSeconds,
  tableWaitLimitedEntryGapSeconds,
  watchTableOpening,
} from "./table-open-recheck.js";

/**
 * "This table isn't open yet": the start page's heading, also on the other tabs (batch 42), so the
 * guest reads the same words wherever they look.
 */
export function tableNotOpenHeading(
  storeDisplayName: string,
  tableLabel: string | null | undefined,
): string {
  return tableLabel === null || tableLabel === undefined
    ? t("This table at {storeDisplayName} isn’t open yet", { storeDisplayName })
    : t("Table {table} at {storeDisplayName} isn’t open yet", {
        table: saidTable(tableLabel),
        storeDisplayName,
      });
}

/** What the start page says the guest waits for (while its checks run). */
export function tableNotOpenWaitText(): string {
  return t(
    "Ask staff to seat you. This page goes on by itself a few seconds after staff open the table.",
  );
}

/** The link back to the start page that waits for staff. */
export function backToWaitingText(): string {
  return t("Back to the waiting page");
}

/** The table this phone waits at, when it is one staff have not opened yet (else null). */
export function tableWaitingToOpen(): UnseatedTableWait | null {
  const wait = getUnseatedTableWait();
  return wait?.kind === "NotOpen" ? wait : null;
}

/**
 * Batch 42: while a tab shows "this table isn't open yet", it asks the scan's cheap "is it open
 * now?" on the start page's schedule (only in front), and once staff open the table it goes back
 * to the start page, which asks the scan again and offers the join. A refused check stops the
 * checks (the start page says the code can't be used); a busy one waits as the start page does.
 */
export function useGoOnWhenTableOpens(active: boolean): void {
  const navigate = useNavigate();
  useEffect(() => {
    const check = active ? tableWaitingToOpen()?.check : null;
    if (check === null || check === undefined || typeof document === "undefined") return;
    let failures = 0;
    let stopped = false;
    const watcher = watchTableOpening({
      check: async () => {
        const answer = await check();
        if (stopped) return false;
        if (answer.kind === "Waiting") {
          failures = 0;
          // Batch 43: still waiting, so a reload from here keeps waiting as long as the checks do.
          keepUnseatedTableWait();
          return true;
        }
        if (answer.kind === "Changed") {
          setTableOpenedWhileAway(true);
          void navigate("/");
          return false;
        }
        if (answer.kind === "Refused") {
          // The waiting scan is gone or its code doesn't work: a reload no longer waits for it.
          forgetKeptUnseatedTableWait();
          return "Paused";
        }
        failures += 1;
        return {
          waitSeconds:
            answer.retryAfterSeconds ??
            (answer.kind === "Limited"
              ? tableWaitLimitedEntryGapSeconds
              : Math.min(tableWaitBusyLongestWaitSeconds, 3 * 2 ** failures)),
        };
      },
      visible: () => document.visibilityState === "visible",
      onVisible: (listener) => {
        const handler = () => {
          if (document.visibilityState === "visible") listener();
        };
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
      now: () => performance.now(),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      delaysSeconds: tableWaitCheckDelaysSeconds,
      minimumGapSeconds: 3,
    });
    return () => {
      stopped = true;
      watcher.stop();
    };
  }, [active, navigate]);
}
