import { createDiningGuestTableClose } from "../../apps/api/dist/dining-guest-table-close.js";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";
import { reportUnexpected } from "./pilot-unexpected.mjs";

/** The System's closing of guest-started tables for this Store. */
export function createPilotGuestTableClose(
  resources,
  { providerAccountReference },
  { createDiningGuestTableClose: compose = createDiningGuestTableClose } = {},
) {
  const allowed = () =>
    isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil;
  return compose({
    scope: {
      ...resources.scope,
      tenantReference: resources.publicProfile.binding.tenantReference,
    },
    providerAccountReference,
    environment: pilotProviderEnvironment(),
    transactions: resources.transactions,
    // One snapshot of every owner: a table refused takes no lock anyone waits for.
    readTransactions: { run: (work) => resources.transactions.runSnapshot(work) },
    authorize: async () => allowed(),
    now: resources.now,
    newReference: resources.credentials.reference,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    orderAudit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
}

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: every minute the System frees guest-started tables its quiet
 * rule says are finished, up to 10 tables a cycle, one transaction each. It keeps running after the
 * switch is turned off, so a table already started is never orphaned. Staff-started tables never
 * come here. A table it can't close now is logged and passed; the next cycle reaches the others.
 */
export function createInternalGuestTableCloseWorkload(
  resources,
  onSnapshot,
  { providerAccountReference },
) {
  const closer = createPilotGuestTableClose(resources, { providerAccountReference });
  return createOutboxWorkload({
    dispatcher: {
      runOnce: () =>
        closer.runOnce({
          limit: 10,
          onFailure: (error) => reportUnexpected("GUEST_TABLE_CLOSE_FAILED", error),
        }),
      stop: async () => "drained",
    },
    pollIntervalMs: 60000,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
