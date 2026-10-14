import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresAsPublishedStorePublicationProof,
  createPostgresStoreBusinessDateConfigurationSource,
  createPostgresStoreClosedBusinessDateWindowSource,
  resolveStoreBusinessDate,
} from "@rms/store";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** One Store business day as a UTC window; "Open" means the day has not ended yet. */
export interface MerchantBusinessDayWindow {
  readonly businessDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly status: "Closed" | "Open";
}
const unavailable = (): never => {
  throw new Error("MERCHANT_BUSINESS_DAY_WINDOW_UNAVAILABLE");
};

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
        hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
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
  /** A business day's window against an already resolved current day. */
  const windowOf = async (
    tx: ConsumerTransaction,
    businessDate: string | null,
    now: string,
    current: Awaited<ReturnType<typeof today>>,
  ): Promise<MerchantBusinessDayWindow> => {
    if (businessDate === current.businessDate)
      return {
        businessDate: current.businessDate,
        startsAt: current.startsAt,
        endsAt: now,
        timeZone: current.timeZone,
        status: "Open",
      };
    if (businessDate !== null && businessDate > current.businessDate) return unavailable();
    let date = businessDate;
    if (date === null) {
      const priorAt = new Date(Date.parse(current.startsAt) - 1).toISOString();
      date = (await today(tx, priorAt)).businessDate;
    }
    // Every configuration in force on that day (UTC noon anchors the day's boundaries);
    // versions may change within the day only with identical boundaries.
    const window = await createPostgresStoreClosedBusinessDateWindowSource(configurationOptions())(
      tx,
      { businessDate: date, anchorAt: `${date}T12:00:00.000Z`, observedAt: now },
    );
    return {
      businessDate: String(window.businessDate),
      startsAt: String(window.startsAt),
      endsAt: String(window.endsAt),
      timeZone: window.timeZone,
      status: "Closed",
    };
  };
  return Object.freeze({
    today,
    /** A business day's window; null asks for the last closed day. Refuses a future date. */
    async window(
      tx: ConsumerTransaction,
      businessDate: string | null,
    ): Promise<MerchantBusinessDayWindow> {
      const now = persistence.now();
      return windowOf(tx, businessDate, now, await today(tx, now));
    },
    /**
     * WP-2423 Q14: the windows of consecutive business dates, with the current day resolved once
     * for the whole range (not once per day); `resolved` reuses the caller's own `today` read at
     * `now`. Refuses a future date.
     */
    async range(
      tx: ConsumerTransaction,
      businessDates: readonly string[],
      resolved?: { readonly now: string; readonly current: Awaited<ReturnType<typeof today>> },
    ): Promise<readonly MerchantBusinessDayWindow[]> {
      const now = resolved?.now ?? persistence.now();
      const current = resolved?.current ?? (await today(tx, now));
      const windows: MerchantBusinessDayWindow[] = [];
      for (const date of businessDates) windows.push(await windowOf(tx, date, now, current));
      return windows;
    },
  });
}
