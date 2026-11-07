import type { ConsumerTransaction } from "@bop/eventing";
import { listStoreOrderRoundSubmissions, type StoreOrderRoundSubmission } from "@rms/ordering";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** The Store business day an instant was resolved into: its date and when it started. */
export interface ResolvedStoreBusinessDay {
  readonly businessDate: string;
  readonly startsAt: string;
}

/**
 * WP-2423 D4: the business date a round (Order batch) belongs to. A table's Order keeps the
 * business date of its first round (order numbers restart every business day), but a later round
 * is work of the day it was submitted on: a round added today to a table opened on an earlier
 * day is today's work in the kitchen, on the Orders page and in the reports.
 *
 * The first round uses the date the Store resolved when the Order was submitted. A later round
 * submitted at or after the start of the current business day is today's; null means the round
 * is from before today and its date must be resolved at its own submission time.
 */
export function knownRoundBusinessDate(
  round: Pick<StoreOrderRoundSubmission, "initial" | "submittedAt" | "orderBusinessDate">,
  today: ResolvedStoreBusinessDay | null,
): string | null {
  if (round.initial) return round.orderBusinessDate;
  if (today !== null && Date.parse(round.submittedAt) >= Date.parse(today.startsAt))
    return today.businessDate;
  return null;
}

/**
 * WP-2423 D4: runs an optional read inside a savepoint; when it fails (for example the Store's
 * business-date publication cannot be read), its statements are undone and `fallback` is returned,
 * so the screen still answers with the Order's own business date instead of failing as a whole.
 */
export async function withOptionalRead<T>(
  tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  work: () => Promise<T>,
  fallback: T,
): Promise<T> {
  await tx.query("SAVEPOINT merchant_round_business_date", []);
  try {
    const value = await work();
    await tx.query("RELEASE SAVEPOINT merchant_round_business_date", []);
    return value;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT merchant_round_business_date", []);
    await tx.query("RELEASE SAVEPOINT merchant_round_business_date", []);
    return fallback;
  }
}

/**
 * WP-2423 D4: each given round's business date, from Ordering's record of when it was submitted
 * and the Store owner's published IANA time zone and business-day start — the same as-published
 * resolution the day-end settlement and the sales reports use (merchant-business-day-window). The
 * current day is resolved once and only when a later round is present; a later round from before
 * today is resolved at its own submission time. `authorize` rechecks the caller's scope in the
 * same transaction. Rounds this Store does not have are left out.
 */
export function createMerchantRoundBusinessDates(options: {
  readonly persistence: Pick<PersistentMerchantBffOptions, "publication" | "now">;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly timeZone: string;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const days = createMerchantBusinessDayWindows(options);
  const owner = {
    brandReference: options.scope.brandReference,
    storeReference: options.scope.storeReference,
  };
  return async (
    tx: ConsumerTransaction,
    orderBatchReferences: readonly string[],
  ): Promise<ReadonlyMap<string, string>> => {
    const unique = [...new Set(orderBatchReferences)];
    const rounds = new Map<string, StoreOrderRoundSubmission>();
    for (let start = 0; start < unique.length; start += 100)
      for (const [batch, round] of await listStoreOrderRoundSubmissions(
        tx,
        owner,
        unique.slice(start, start + 100),
      ))
        rounds.set(batch, round);
    const dates = new Map<string, string>();
    for (const [batch, round] of rounds)
      if (round.initial) dates.set(batch, round.orderBusinessDate);
    if (dates.size === rounds.size) return dates;
    // Later rounds: by the Store's published business day. If it cannot be read, those rounds
    // are left out and callers show the Order's own business date (the earlier behaviour).
    return withOptionalRead(
      tx,
      async () => {
        const today = await days.today(tx, options.persistence.now());
        const resolved = new Map(dates);
        for (const [batch, round] of rounds) {
          if (round.initial) continue;
          resolved.set(
            batch,
            knownRoundBusinessDate(round, today) ??
              (await days.today(tx, round.submittedAt)).businessDate,
          );
        }
        return resolved;
      },
      dates,
    );
  };
}
