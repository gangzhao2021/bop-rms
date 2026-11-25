/**
 * F27 fix-up (decided rule): which of an order's recorded refunds make up the money shown as
 * "Refunded" under the Orders refund totals, so each can be said with its own way, time and reason.
 *
 * A line may name a way, time or reason only when the assignment is provably unique: every refund
 * listed by name above (a round or order cancellation, each cancelled item's refund) is matched to
 * exactly one record refund of the same way AND amount (AND time when the listed refund knows it),
 * one-to-one; the cancelled items are matched item by item, never as one sum. When any listed
 * refund is not in the record, or which record refund it is could change what is left over, or
 * what is left over is not exactly the money to show, the answer is null and the caller shows that
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
}

const instant = (at: string) => Date.parse(at);
const sameWayAndAmount = (refund: RecordedRefund, part: ListedRefundPart) =>
  refund.method === part.method && BigInt(refund.amountMinor) === part.amountMinor;
const sameTime = (a: string, b: string) => instant(a) === instant(b);

export function refundsBehindRefunded<R extends RecordedRefund>(
  record: readonly R[],
  listed: readonly ListedRefundPart[],
  refundedMinor: bigint,
): readonly R[] | null {
  if (refundedMinor <= 0n || record.length === 0) return null;
  const rest = [...record];
  // Listed refunds that know their time first: they can only be that one record refund.
  const timed = listed.filter((part) => part.at != null);
  const untimed = listed.filter((part) => part.at == null);
  for (const part of timed) {
    const candidates = rest.filter(
      (refund) => sameWayAndAmount(refund, part) && sameTime(refund.at, part.at as string),
    );
    const one = candidates[0];
    // Identical record refunds (way, amount and time) cannot be told apart, so any one will do.
    if (one === undefined) return null;
    rest.splice(rest.indexOf(one), 1);
  }
  // The rest by way and amount, as groups: k listed refunds of a way and amount take k record
  // refunds of it. What is left over is certain only when all k are taken or they all look alike.
  const groups = new Map<string, number>();
  for (const part of untimed) {
    const key = `${part.method}:${part.amountMinor}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of groups) {
    const [method, amount] = key.split(":") as [RefundWay, string];
    const part = { method, amountMinor: BigInt(amount) };
    const candidates = rest.filter((refund) => sameWayAndAmount(refund, part));
    if (candidates.length < count) return null;
    if (candidates.length > count) {
      const first = candidates[0] as R;
      if (!candidates.every((refund) => sameTime(refund.at, first.at))) return null;
    }
    for (const taken of candidates.slice(0, count)) rest.splice(rest.indexOf(taken), 1);
  }
  const left = rest.reduce((total, refund) => total + BigInt(refund.amountMinor), 0n);
  if (rest.length === 0 || left !== refundedMinor) return null;
  return rest;
}
