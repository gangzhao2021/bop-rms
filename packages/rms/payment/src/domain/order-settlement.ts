/** Payment-owned monetary settlement rule. Inputs are server-composed owner facts;
 * a decision is not itself a persisted finality reference or authority to close. */
export interface OrderSettlementInput {
  readonly refundAllocation?: {
    readonly orderMinor: bigint;
    readonly tipMinor: bigint;
    readonly unallocatedMinor: bigint;
  };
  readonly currencyCode: "CAD";
  readonly pricedOrderTotalMinor: bigint;
  readonly capturedMinor: bigint;
  readonly capturedOrderAllocationMinor: bigint;
  readonly capturedTipMinor: bigint;
  readonly confirmedRefundMinor: bigint;
  readonly pendingRefundMinor: bigint;
  readonly unresolvedAttemptCount: number;
  readonly pendingAmendmentCount: number;
}
export function assessOrderSettlement(input: OrderSettlementInput) {
  const fields = [
    "currencyCode",
    "pricedOrderTotalMinor",
    "capturedMinor",
    "capturedOrderAllocationMinor",
    "capturedTipMinor",
    "confirmedRefundMinor",
    "pendingRefundMinor",
    "unresolvedAttemptCount",
    "pendingAmendmentCount",
  ];
  const fail = (): never => {
    throw new Error("ORDER_SETTLEMENT_EVIDENCE_INVALID");
  };
  if (input !== null && typeof input === "object" && Object.hasOwn(input, "refundAllocation"))
    fields.push("refundAllocation");
  if (
    input === null ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== fields.length ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key) ||
        !Object.getOwnPropertyDescriptor(input, key)?.enumerable ||
        !("value" in (Object.getOwnPropertyDescriptor(input, key) ?? {})),
    )
  )
    return fail();
  if (input.currencyCode !== "CAD") return fail();
  for (const amount of [
    input.pricedOrderTotalMinor,
    input.capturedMinor,
    input.capturedOrderAllocationMinor,
    input.capturedTipMinor,
    input.confirmedRefundMinor,
    input.pendingRefundMinor,
  ])
    if (typeof amount !== "bigint" || amount < 0n || amount > 9223372036854775807n) return fail();
  for (const count of [input.unresolvedAttemptCount, input.pendingAmendmentCount])
    if (!Number.isSafeInteger(count) || count < 0) return fail();
  if (
    input.capturedOrderAllocationMinor + input.capturedTipMinor !== input.capturedMinor ||
    input.confirmedRefundMinor + input.pendingRefundMinor > input.capturedMinor
  )
    return fail();
  const allocation = input.refundAllocation;
  if (allocation !== undefined) {
    const keys = ["orderMinor", "tipMinor", "unallocatedMinor"];
    if (
      allocation === null ||
      typeof allocation !== "object" ||
      Object.getPrototypeOf(allocation) !== Object.prototype ||
      Reflect.ownKeys(allocation).length !== keys.length ||
      keys.some((key) => {
        const field = Object.getOwnPropertyDescriptor(allocation, key);
        return (
          !field?.enumerable ||
          !("value" in field) ||
          typeof field.value !== "bigint" ||
          field.value < 0n ||
          field.value > 9223372036854775807n
        );
      })
    )
      return fail();
    if (
      allocation.orderMinor + allocation.tipMinor + allocation.unallocatedMinor !==
        input.confirmedRefundMinor ||
      allocation.orderMinor > input.capturedOrderAllocationMinor ||
      allocation.orderMinor > input.pricedOrderTotalMinor ||
      allocation.tipMinor > input.capturedTipMinor
    )
      return fail();
  }
  const reasons: string[] = [];
  if (input.unresolvedAttemptCount > 0) reasons.push("PAYMENT_RESULT_UNRESOLVED");
  if (input.pendingAmendmentCount > 0) reasons.push("ORDER_REPRICING_PENDING");
  if (input.pendingRefundMinor > 0) reasons.push("REFUND_PENDING");
  if (
    input.confirmedRefundMinor > 0 &&
    (allocation === undefined || allocation.unallocatedMinor > 0n)
  )
    reasons.push("REFUND_ALLOCATION_RECONCILIATION_REQUIRED");
  const difference = input.pricedOrderTotalMinor - input.capturedOrderAllocationMinor;
  if (difference > 0n) reasons.push("ORDER_BALANCE_UNPAID");
  if (difference < 0n) reasons.push("ORDER_OVERPAYMENT_UNRESOLVED");
  return Object.freeze({
    classification:
      reasons.length === 0
        ? ("Settled" as const)
        : reasons.length === 1 && reasons[0] === "ORDER_BALANCE_UNPAID"
          ? ("Unpaid" as const)
          : ("Indeterminate" as const),
    allocationDifferenceMinor: difference,
    reasons: Object.freeze(reasons),
  });
}
