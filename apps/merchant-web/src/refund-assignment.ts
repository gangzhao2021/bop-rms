/**
 * F27 fix-up (decided rule): which of an order's recorded refunds make up the money shown as
 * "Refunded" under the Orders refund totals, so each can be said with its own way, time and reason.
 *
 * A line may name a way, time or reason only when the assignment is provably unique: every refund
 * listed by name above that the record holds (a round or order cancellation given back on the card
 * machine or in cash) is matched to exactly one record refund of the same way AND amount (AND time
 * when the listed refund knows it), one-to-one, each part on its own and never as one sum. A listed
 * refund the record never holds (a cancelled item's refund or a cancellation refund to the guest's
 * card: the server does not put those in the order's record) takes no record refund. When which
 * record refund a listed one is could change what is left over, or what is left over is not exactly
 * the money to show, or a refund to the guest's card left over may still be on its way (the record
 * holds those once sent, before the Provider answers), the answer is null and the caller shows that
 * money as plain "Refunded $X". The caller always shows the full amount either way.
 */
export type RefundWay = "CardMachine" | "Cash" | "Online";

export interface RecordedRefund {
  readonly method: RefundWay;
  readonly amountMinor: string;
  readonly at: string;
}

/** One refund listed by name above "Refunded" (one cancelled item, one cancellation). */
export interface ListedRefundPart {
  readonly method: RefundWay;
  readonly amountMinor: bigint;
  /** When the refund's own time is known; null matches any time. */
  readonly at?: string | null;
  /**
   * Whether the order's record holds this refund: false for a cancelled item's refund and an
   * online cancellation refund, which the server never records there.
   */
  readonly inRecord: boolean;
}

export interface RefundAssignmentContext {
  /**
   * Money to the guest's card may still be on its way (sent, not answered): the record already
   * holds such a refund, so no record refund to the card can be said as given back.
   */
  readonly onlineMayBeOnItsWay: boolean;
}

const instant = (at: string) => Date.parse(at);
const sameWayAndAmount = (
  refund: RecordedRefund,
  part: { readonly method: RefundWay; readonly amountMinor: bigint },
) => refund.method === part.method && BigInt(refund.amountMinor) === part.amountMinor;
const sameTime = (a: string, b: string) => instant(a) === instant(b);

export function refundsBehindRefunded<R extends RecordedRefund>(
  record: readonly R[],
  listed: readonly ListedRefundPart[],
  refundedMinor: bigint,
  context: RefundAssignmentContext,
): readonly R[] | null {
  if (refundedMinor <= 0n || record.length === 0) return null;
  const rest = [...record];
  const held = listed.filter((part) => part.inRecord);
  // Listed refunds that know their time first: they can only be that one record refund.
  for (const part of held.filter((part) => part.at != null)) {
    const one = rest.find(
      (refund) => sameWayAndAmount(refund, part) && sameTime(refund.at, part.at as string),
    );
    // Identical record refunds (way, amount and time) cannot be told apart, so any one will do.
    if (one === undefined) return null;
    rest.splice(rest.indexOf(one), 1);
  }
  // The rest by way and amount, as groups: k listed refunds of a way and amount take k record
  // refunds of it. What is left over is certain only when all k are taken or they all look alike.
  const groups = new Map<string, { method: RefundWay; amountMinor: bigint; count: number }>();
  for (const part of held.filter((part) => part.at == null)) {
    const key = `${part.method}:${part.amountMinor}`;
    const group = groups.get(key) ?? {
      method: part.method,
      amountMinor: part.amountMinor,
      count: 0,
    };
    group.count += 1;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const candidates = rest.filter((refund) => sameWayAndAmount(refund, group));
    if (candidates.length < group.count) return null;
    if (candidates.length > group.count) {
      const first = candidates[0] as R;
      if (!candidates.every((refund) => sameTime(refund.at, first.at))) return null;
    }
    for (const taken of candidates.slice(0, group.count)) rest.splice(rest.indexOf(taken), 1);
  }
  if (rest.length === 0) return null;
  if (context.onlineMayBeOnItsWay && rest.some((refund) => refund.method === "Online")) return null;
  const left = rest.reduce((total, refund) => total + BigInt(refund.amountMinor), 0n);
  return left === refundedMinor ? rest : null;
}
