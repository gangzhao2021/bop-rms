import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreBusinessDaySource,
  createStoreConfigurationPublicationHash,
  describeStoreUpcomingHours,
  resolveStoreLocalInstant,
  resolveStoreOperatingLocalFields,
  type StoreBusinessDay,
} from "@rms/store";
import { parseCanonicalInstant } from "@bop/tenant";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

/**
 * WP-2423 Q21: the selected Store's current business day — its date, start and end — from the
 * Store owner's published time zone and business-day start, verified against the current
 * publication like the workspace's Business Date. Every merchant "today" (the workspace, the
 * settlement day picker, a sold-out-for-today mark) uses this one read, never the calendar day.
 * The caller resolves the scope and supplies an authorization that rechecks it in this transaction.
 */
export function createMerchantStoreBusinessDay(options: {
  readonly publication: PersistentMerchantBffOptions["publication"];
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly timeZone: string;
  authorize(tx: Transaction): Promise<boolean>;
}): (
  tx: Transaction,
  at: string,
) => Promise<StoreBusinessDay & { readonly lastOrdersAt: string | null }> {
  const setupSnapshotReferences = {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
  };
  const hashContent = createStoreConfigurationPublicationHash(setupSnapshotReferences);
  let published:
    Awaited<ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>> | undefined;
  const read = createPostgresStoreBusinessDaySource({
    brandReference: options.brandReference,
    storeReference: options.storeReference,
    timeZone: options.timeZone,
    authorize: async (tx) => (await options.authorize(tx)) === true,
    publicationProof: async (tx, candidate, at) => {
      published = await createPostgresCurrentStorePublicationProof({
        ...options.publication,
        tenantReference: options.tenantReference,
        brandReference: options.brandReference,
        storeReference: options.storeReference,
        configurationReference: candidate.configurationReference,
        authorize: async () => (await options.authorize(tx)) === true,
        hashContent,
        setupSnapshotReferences,
      })(tx, at);
      return {
        contentDigest: published.contentDigest,
        businessDayStartSource: published.businessDayStartSource,
      };
    },
  });
  return async (tx, at) => {
    published = undefined;
    const day = await read(tx, at);
    return Object.freeze({
      ...day,
      lastOrdersAt: lastOrdersInstant(published, options.timeZone, at),
    });
  };
}

/**
 * WP-2423 item 8 ③ follow-up (v15 2026-10-28): when the current service period stops taking guest
 * orders (its published cut-off), as an instant, so staff are warned before it on the Tables page;
 * null between periods or when no cut-off is set. From the same verified publication.
 */
function lastOrdersInstant(
  published:
    | { readonly configuration: { readonly weeklySchedule: unknown; readonly exceptions: unknown } }
    | undefined,
  timeZone: string,
  at: string,
): string | null {
  if (published === undefined) return null;
  try {
    const local = resolveStoreOperatingLocalFields(parseCanonicalInstant(at), timeZone);
    const hours = describeStoreUpcomingHours({
      localDate: String(local.localDate),
      localTime: String(local.localTime),
      weeklySchedule: published.configuration.weeklySchedule as Parameters<
        typeof describeStoreUpcomingHours
      >[0]["weeklySchedule"],
      exceptions: published.configuration.exceptions as Parameters<
        typeof describeStoreUpcomingHours
      >[0]["exceptions"],
      days: 0,
    });
    return hours.lastOrders === null
      ? null
      : String(
          resolveStoreLocalInstant({
            timeZone,
            localDate: hours.lastOrders.localDate,
            localTime: hours.lastOrders.localTime,
          }).instant,
        );
  } catch {
    return null;
  }
}

/** What the browser receives: the day and its boundaries, no configuration identity. */
export function merchantBusinessDayView(day: {
  readonly businessDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly observedAt: string;
  readonly lastOrdersAt?: string | null;
}) {
  return Object.freeze({
    businessDate: String(day.businessDate),
    startsAt: String(day.startsAt),
    endsAt: String(day.endsAt),
    timeZone: day.timeZone,
    observedAt: String(day.observedAt),
    lastOrdersAt: day.lastOrdersAt ?? null,
  });
}
