import { loadDiningSessionPhones } from "@rms/dining";
import { listStaffDiningRoundAdmissions } from "@rms/ordering";

type Transaction = Parameters<typeof loadDiningSessionPhones>[0];
type Scope = Parameters<typeof loadDiningSessionPhones>[1];

/**
 * v15 2026-11-03: the guests' phones at a table. Staff entering a round join the table through its
 * own guest path, with a session of their own, which is no phone: staff were told "Phone 1 just
 * joined" for their own round, and a one-phone table stopped counting as one phone.
 */
export async function loadDiningGuestPhones(
  tx: Transaction,
  scope: Scope,
  diningSessionReference: string,
) {
  return loadDiningSessionPhones(tx, scope, diningSessionReference, {
    excludeAdmissions: await listStaffDiningRoundAdmissions(
      tx as never,
      scope,
      diningSessionReference,
    ),
  });
}
