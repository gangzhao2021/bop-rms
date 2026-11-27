import { storeConfigurationProofHashing } from "./merchant-store-configuration-proof-hash.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresAsPublishedStorePublicationProof,
  createPostgresStoreBusinessDateConfigurationSource,
  createPostgresStoreClosedBusinessDateWindowSource,
  readStoreFirstConfigurationGoverningFrom,
  resolveStoreBusinessDate,
  resolveStoreBusinessDay,
  StoreBusinessDateBeforeRecordsError,
} from "@rms/store";
import { readStorePaymentTakenBefore } from "@rms/payment";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** One Store business day as a UTC window; "Open" means the day has not ended yet. */
export interface MerchantBusinessDayWindow {
  readonly businessDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly status: "Closed" | "Open";
  /**
   * WP-2423 M160: on the Store's first business day, when it started using the system (inside the
   * day); null on every other day. The window still spans the whole day.
   */
  readonly opensAt: string | null;
}
const unavailable = (): never => {
  throw new Error("MERCHANT_BUSINESS_DAY_WINDOW_UNAVAILABLE");
};
/** WP-2423 M160: the asked business day is before the Store's records begin (an answer). */
export const merchantBusinessDayBeforeRecords = "MERCHANT_BUSINESS_DAY_BEFORE_RECORDS" as const;
export class MerchantBusinessDayBeforeRecordsError extends Error {
  readonly code = merchantBusinessDayBeforeRecords;
  constructor(readonly firstBusinessDate: string) {
    super(merchantBusinessDayBeforeRecords);
    this.name = "MerchantBusinessDayBeforeRecordsError";
  }
}
/**
 * WP-2423 M160: a payment recorded as taken before the Store's first business day. Every report and
 * settlement starts at that day, so such a payment would be in none of them: the reads refuse
 * (and the failure is logged under this code) instead of leaving it out.
 */
export const merchantPaymentBeforeStoreRecords = "MERCHANT_PAYMENT_BEFORE_STORE_RECORDS" as const;
interface FirstDay {
  readonly businessDate: string;
  readonly startsAt: string;
  /** The instant the Store's first configuration began to govern. */
  readonly opensAt: string;
}

/**
 * WP-2423 P1/Q14: a Store business day's window by the Store owner's as-published business-day
 * configuration — the current day runs until now ("Open"), a past day uses every configuration in
 * force on it ("Closed"). The day-end settlement and the sales reports share this one definition.
 * `authorize` rechecks the caller's scope in the same transaction.
 */
export function createMerchantBusinessDayWindows(options: {
  readonly persistence: Pick<PersistentMerchantBffOptions, "publication" | "now">;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly timeZone: string;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const { persistence, scope } = options;
  const configurationOptions = (): Parameters<
    typeof createPostgresStoreBusinessDateConfigurationSource
  >[0] => ({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    timeZone: options.timeZone,
    authorize: async (t) => options.authorize(t as ConsumerTransaction),
    // Past business days: verify against the as-published release.
    publicationProof: async (t, candidate, at) => {
      const proof = await createPostgresAsPublishedStorePublicationProof({
        ...persistence.publication,
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => options.authorize(t as ConsumerTransaction),
        configurationReference: candidate.configurationReference,
        ...storeConfigurationProofHashing,
      })(t, at);
      return {
        contentDigest: proof.contentDigest,
        businessDayStartSource: proof.businessDayStartSource,
      };
    },
  });
  const source = () => createPostgresStoreBusinessDateConfigurationSource(configurationOptions());
  /** The current business day: its date and when it started. */
  const today = async (tx: ConsumerTransaction, now: string) => {
    const day = resolveStoreBusinessDate({
      occurredAt: now,
      configuration: await source()(tx, now),
    });
    return {
      businessDate: String(day.businessDate),
      startsAt: String(day.businessDateBoundaryAt),
      timeZone: day.timeZone,
    };
  };
  /**
   * WP-2423 M160: the Store's first business day — the day its first published configuration
   * began to govern in; null when it has none yet. Read under the caller's authorization. A
   * payment taken before that day's start would fall outside every day, so it is refused loudly.
   */
  const firstDay = async (tx: ConsumerTransaction): Promise<FirstDay | null> => {
    if ((await options.authorize(tx)) !== true)
      throw new Error("MERCHANT_BUSINESS_DAY_WINDOW_DENIED");
    const opensAt = await readStoreFirstConfigurationGoverningFrom(tx, scope);
    if (opensAt === null) return null;
    // Read at that very instant: a version the source would not accept there is an outage.
    const day = resolveStoreBusinessDay({
      occurredAt: opensAt,
      configuration: await source()(tx, opensAt),
    });
    if (await readStorePaymentTakenBefore(tx, scope, String(day.startsAt)))
      throw new Error(merchantPaymentBeforeStoreRecords);
    return { businessDate: String(day.businessDate), startsAt: String(day.startsAt), opensAt };
  };
  /** A business day's window against an already resolved current and first day. */
  const windowOf = async (
    tx: ConsumerTransaction,
    businessDate: string | null,
    now: string,
    current: Awaited<ReturnType<typeof today>>,
    first: FirstDay,
  ): Promise<MerchantBusinessDayWindow> => {
    const open = (): MerchantBusinessDayWindow => ({
      businessDate: current.businessDate,
      startsAt: current.startsAt,
      endsAt: now,
      timeZone: current.timeZone,
      status: "Open",
      opensAt:
        first.businessDate === current.businessDate && first.opensAt > current.startsAt
          ? first.opensAt
          : null,
    });
    if (businessDate === current.businessDate) return open();
    if (businessDate !== null && businessDate > current.businessDate) return unavailable();
    let date = businessDate;
    if (date === null) {
      // v15 2026-11-01: a Store whose first configuration took effect today has no closed day
      // yet; its last day is today's, still open (store 2's owner was refused Settlement).
      if (first.businessDate >= current.businessDate) return open();
      date = (await today(tx, new Date(Date.parse(current.startsAt) - 1).toISOString()))
        .businessDate;
    }
    if (date < first.businessDate)
      throw new MerchantBusinessDayBeforeRecordsError(first.businessDate);
    // Every configuration in force on that day (UTC noon anchors the day's boundaries; the first
    // day is read from when the Store opened); versions may change within the day only with
    // identical boundaries.
    let window;
    try {
      window = await createPostgresStoreClosedBusinessDateWindowSource(configurationOptions())(tx, {
        businessDate: date,
        anchorAt: `${date}T12:00:00.000Z`,
        observedAt: now,
      });
    } catch (error) {
      if (error instanceof StoreBusinessDateBeforeRecordsError)
        throw new MerchantBusinessDayBeforeRecordsError(error.firstBusinessDate);
      throw error;
    }
    return {
      businessDate: String(window.businessDate),
      startsAt: String(window.startsAt),
      endsAt: String(window.endsAt),
      timeZone: window.timeZone,
      status: "Closed",
      opensAt: window.opensAt === null ? null : String(window.opensAt),
    };
  };
  const required = async (tx: ConsumerTransaction) => (await firstDay(tx)) ?? unavailable();
  return Object.freeze({
    today,
    /** WP-2423 M160: the Store's first business day (when its records begin); null: none yet. */
    async firstBusinessDate(tx: ConsumerTransaction): Promise<string | null> {
      return (await firstDay(tx))?.businessDate ?? null;
    },
    /**
     * WP-2423: the business day an instant falls in, with its end, by the configuration in force
     * at that instant (DEC-EXCEPTION-CONFIRMED-REFUND-DUE: a case is due when its day ends).
     */
    async dayOf(tx: ConsumerTransaction, at: string) {
      const day = resolveStoreBusinessDay({
        occurredAt: at,
        configuration: await source()(tx, at),
      });
      return {
        businessDate: String(day.businessDate),
        startsAt: String(day.startsAt),
        endsAt: String(day.endsAt),
      };
    },
    /**
     * A business day's window; null asks for the last closed day. Refuses a future date; a day
     * before the Store's records begin is MerchantBusinessDayBeforeRecordsError.
     */
    async window(
      tx: ConsumerTransaction,
      businessDate: string | null,
    ): Promise<MerchantBusinessDayWindow> {
      const now = persistence.now();
      const current = await today(tx, now);
      return windowOf(tx, businessDate, now, current, await required(tx));
    },
    /**
     * WP-2423 Q14: the windows of consecutive business dates, with the current day resolved once
     * for the whole range (not once per day); `resolved` reuses the caller's own `today` read at
     * `now`. Refuses a future date. WP-2423 M160: dates before the Store's first business day
     * have no records and are left out (the range starts at that day); a range wholly before it
     * is MerchantBusinessDayBeforeRecordsError.
     */
    async range(
      tx: ConsumerTransaction,
      businessDates: readonly string[],
      resolved?: { readonly now: string; readonly current: Awaited<ReturnType<typeof today>> },
    ): Promise<{
      readonly firstBusinessDate: string;
      readonly windows: readonly MerchantBusinessDayWindow[];
    }> {
      const now = resolved?.now ?? persistence.now();
      const current = resolved?.current ?? (await today(tx, now));
      const first = await required(tx);
      const covered = businessDates.filter((date) => date >= first.businessDate);
      if (covered.length === 0) throw new MerchantBusinessDayBeforeRecordsError(first.businessDate);
      const windows: MerchantBusinessDayWindow[] = [];
      for (const date of covered) windows.push(await windowOf(tx, date, now, current, first));
      return { firstBusinessDate: first.businessDate, windows };
    },
  });
}
