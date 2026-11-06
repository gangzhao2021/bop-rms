import type { GuestSession } from "@bop/identity";
import type { CustomerEntryPresentedTable } from "./customer-entry.js";

/**
 * WP-2423 shared-table-checkout (b): the table the browser's own Guest cookie is seated at now.
 * `resolve` must be the Guest Session read that also checks the Dining binding (participant still
 * at the table, the table's party unchanged); it throws for anything else. Read only (Background:
 * the idle expiry is not renewed). A context-only, pickup or no-longer-current session gives null,
 * and the scan continues as an ordinary entry (a phone staff removed joins again, subject to the
 * table's scan pause).
 */
export function createCustomerEntryPresentedTable(sessions: {
  resolve(input: {
    readonly sessionCredential: unknown;
    readonly activity: "Background";
    readonly observedAt: unknown;
  }): Promise<GuestSession>;
}): (sessionCredential: string, observedAt: string) => Promise<CustomerEntryPresentedTable | null> {
  return async (sessionCredential, observedAt) => {
    const session = await sessions
      .resolve({ sessionCredential, activity: "Background", observedAt })
      .catch(() => null);
    if (
      session === null ||
      session.status !== "Active" ||
      session.diningState !== "DiningBound" ||
      session.channel !== "DineIn" ||
      session.publicTableReference === null
    )
      return null;
    return Object.freeze({
      publicStoreReference: String(session.publicStoreReference),
      publicTableReference: String(session.publicTableReference),
      qrReference: String(session.qrReference),
      qrRevocationVersion: session.qrRevocationVersion,
    });
  };
}
