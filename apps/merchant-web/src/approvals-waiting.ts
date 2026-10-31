import { useEffect, useMemo, useState } from "react";
import { createRefundApprovalClient } from "./refund-approval-client.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { createDiningSessionClient } from "./dining-session-client.js";

/** WP-2423 Q35: how often the waiting refund approvals are read while a page is visible. */
export const APPROVALS_WAITING_REFRESH_MS = 60_000;

/** What the approver still has to do: approve, or send a refund already approved. */
export interface ApprovalsWaiting {
  readonly awaiting: number;
  readonly approvedNotSent: number;
}

export function summarizeApprovalsWaiting(
  entries: readonly { readonly state: "AwaitingApproval" | "Approved" }[],
): ApprovalsWaiting {
  return {
    awaiting: entries.filter((entry) => entry.state === "AwaitingApproval").length,
    approvedNotSent: entries.filter((entry) => entry.state === "Approved").length,
  };
}

/**
 * WP-2423 Q35: refunds at the selected Store waiting for an approver, read while the page is
 * visible and the sign-in is live, so a manager away from the counter sees them on any page.
 * `null` until read, when not permitted, or when the read fails (nothing is guessed).
 */
export function useApprovalsWaiting(
  enabled: boolean,
  fetcher?: typeof fetch,
): ApprovalsWaiting | null {
  const client = useMemo(() => createRefundApprovalClient(fetcher), [fetcher]);
  const live = useStaffSessionLive();
  const [waiting, setWaiting] = useState<ApprovalsWaiting | null>(null);
  useEffect(() => {
    if (!enabled || !live || typeof window === "undefined") {
      setWaiting(null);
      return;
    }
    let controller: AbortController | null = null;
    const read = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      client
        .approvals(current.signal)
        .then((view) => {
          if (!current.signal.aborted) setWaiting(summarizeApprovalsWaiting(view.entries));
        })
        .catch(() => {
          if (!current.signal.aborted) setWaiting(null);
        });
    };
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, APPROVALS_WAITING_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [client, enabled, live]);
  return waiting;
}

/** WP-2423 Q28: how often the guests waiting for staff are counted while a page is visible. */
export const STAFF_CALLS_WAITING_REFRESH_MS = 30_000;

/**
 * WP-2423 Q28 DEC-DINING-STAFF-CALL: how many guests at the selected Store asked staff to come to
 * their table and wait, counted on every page for staff with the Tables page. `null` until read,
 * when not permitted, or when the read fails.
 */
export function useStaffCallsWaiting(csrf: string | null, enabled: boolean): number | null {
  const live = useStaffSessionLive();
  const [waiting, setWaiting] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || csrf === null || !live || typeof window === "undefined") {
      setWaiting(null);
      return;
    }
    const client = createDiningSessionClient();
    let controller: AbortController | null = null;
    const read = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      client
        .staffCallCount(csrf, current.signal)
        .then((open) => {
          if (!current.signal.aborted) setWaiting(open);
        })
        .catch(() => {
          if (!current.signal.aborted) setWaiting(null);
        });
    };
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, STAFF_CALLS_WAITING_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [csrf, enabled, live]);
  return waiting;
}
