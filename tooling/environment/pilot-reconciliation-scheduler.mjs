import { createHash } from "node:crypto";
import {
  parsePaymentReference,
  parsePaymentInstant,
  parsePaymentReconciliationRunResult,
} from "../../packages/rms/payment/src/index.ts";
/** Resumable minute/page identity; no due work means no new empty reconciliation record. */
export function createOperationalReconciliationScheduler({ scope, now, readRun, hasDue, execute }) {
  const brand = String(parsePaymentReference(scope.brandReference)),
    store = String(parsePaymentReference(scope.storeReference));
  let slot = null,
    page = 0,
    complete = false,
    running = false;
  const fail = () => {
    throw Error("RECONCILIATION_SCHEDULE_UNAVAILABLE");
  };
  return async () => {
    if (running) return fail();
    running = true;
    try {
      const current = Math.floor(Date.parse(parsePaymentInstant(now())) / 60000) * 60000;
      if (slot === null || (complete && current > slot)) {
        slot = current;
        page = 0;
        complete = false;
      }
      if (current < slot) return fail();
      if (complete) return { status: "Idle", checkCount: 0 };
      if (page > 10000) return fail();
      const stamp = slot.toString(16).padStart(12, "0"),
        h = createHash("sha256")
          .update(JSON.stringify(["BOP_INTERNAL_RECONCILIATION_SLOT_V1", brand, store, slot, page]))
          .digest("hex");
      const runReference = String(
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
      );
      const scheduledAt = new Date(slot).toISOString(),
        run = {
          runReference,
          brandReference: brand,
          storeReference: store,
          actorReference: null,
          mode: "Operational",
          purpose: "ReconcilePayments",
          scheduledAt,
          cutoffAt: scheduledAt,
          maxCandidates: 100,
        };
      const existing = await readRun({ runReference });
      if (existing === null) {
        const due = await hasDue({ cutoffAt: scheduledAt });
        if (typeof due !== "boolean") return fail();
        if (!due) {
          complete = true;
          return { status: "Idle", checkCount: 0 };
        }
      }
      const outcome = await execute(run),
        result = parsePaymentReconciliationRunResult(outcome.result);
      if (
        !["Created", "Duplicate"].includes(outcome.status) ||
        Object.keys(run).some((k) => run[k] !== result.run[k])
      )
        return fail();
      if (result.checks.length === 100) page++;
      else complete = true;
      return { status: outcome.status, checkCount: result.checks.length };
    } finally {
      running = false;
    }
  };
}
