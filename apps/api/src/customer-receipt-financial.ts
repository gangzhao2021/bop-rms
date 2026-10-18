import type { ConsumerTransaction } from "@bop/eventing";
import { DigitalReceiptError } from "@rms/ordering";
import { createPostgresOrderFinancialPosition } from "@rms/payment";
export type CustomerReceiptFinancialOptions = Omit<
  Parameters<typeof createPostgresOrderFinancialPosition>[0],
  "authorize"
>;
export interface CustomerReceiptFinancialView {
  readonly observedAt: string;
  readonly currencyCode: string;
  readonly capturedMinor: bigint;
  readonly confirmedRefundMinor: bigint;
  readonly pendingRefundMinor: bigint;
  readonly unresolvedAttemptCount: number;
  /**
   * WP-2423 (v15 3cd0f8dd H1): of `capturedMinor`, what was paid online and what staff took on the
   * Store's card machine (a dine-in table can pay rounds both ways).
   */
  readonly paidOnlineMinor: bigint;
  readonly paidOnCardMachineMinor: bigint;
}
/** Optional current evidence, separate from immutable receipt history. */
export async function readCustomerReceiptFinancial(
  transaction: ConsumerTransaction,
  options: CustomerReceiptFinancialOptions,
  input: { orderReference: string; observedAt: string },
  stillAuthorized: () => Promise<boolean>,
): Promise<CustomerReceiptFinancialView | null> {
  const authorize = async () => {
    if (!(await stillAuthorized()))
      throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
    return true;
  };
  await authorize();
  await transaction.query("SAVEPOINT customer_receipt_financial", []);
  let result: CustomerReceiptFinancialView | null = null;
  try {
    const position = await createPostgresOrderFinancialPosition({
      ...options,
      authorize: async (_tx, query) =>
        query.orderReference === input.orderReference && (await authorize()),
    })(transaction, input);
    // WP-2423 (v15 3cd0f8dd H1): what the order was paid and refunded across both tenders (the
    // settlement figures staff reconcile), not the online payments alone.
    result = {
      observedAt: position.observedAt,
      currencyCode: position.currencyCode,
      capturedMinor: position.settlement.capturedMinor,
      confirmedRefundMinor: position.settlement.confirmedRefundMinor,
      pendingRefundMinor: position.settlement.pendingRefundMinor,
      unresolvedAttemptCount: position.unresolvedAttemptCount,
      paidOnlineMinor: position.capturedMinor,
      paidOnCardMachineMinor: position.settlement.capturedMinor - position.capturedMinor,
    };
  } catch {
    await transaction.query("ROLLBACK TO SAVEPOINT customer_receipt_financial", []);
  }
  await transaction.query("RELEASE SAVEPOINT customer_receipt_financial", []);
  await authorize();
  return result;
}
