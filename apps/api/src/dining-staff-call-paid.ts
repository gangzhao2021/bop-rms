import { createHash } from "node:crypto";
import { createPostgresDiningStaffCallStore } from "@rms/dining";

const intentHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A table bill is paid in full: one whole payment, or every part of its split. */
export function diningTableBillPaidInFull(bill: {
  readonly settlement: unknown;
  readonly split: { readonly paidInFull: boolean } | null;
}): boolean {
  return bill.settlement !== null || bill.split?.paidInFull === true;
}

/**
 * b39 (v15 b38 dinner sweep): staff kept seeing "Ready to pay" on a table the guests had already
 * paid, and had to tap "Handled". Once a payment completes the table's bill, the table's open
 * "ready to pay" call is closed in that same transaction — recorded by Dining as kind "Paid", with
 * the payment's operation and whoever took it (null: the guest paid on their phone). Any other
 * call stays open for staff. The caller holds the payment's authorization; `authorize` re-checks it.
 */
export async function closeReadyToPayCallWhenPaid(
  tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  bill: Parameters<typeof diningTableBillPaidInFull>[0],
  input: {
    readonly diningSessionReference: string;
    readonly operationReference: string;
    readonly actorReference: string | null;
    readonly observedAt: string;
  },
  authorize: () => Promise<boolean> | boolean,
): Promise<boolean> {
  if (!diningTableBillPaidInFull(bill)) return false;
  return createPostgresDiningStaffCallStore(
    { run: (work) => work(tx as never) },
    {
      scope: {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
      hashIntent: intentHash,
      equals: (a, b) => a === b,
      // Guest commands never run through this store.
      authorize: async () => false,
    },
  ).closeReadyToPayOnPaid(tx as never, input, authorize);
}
