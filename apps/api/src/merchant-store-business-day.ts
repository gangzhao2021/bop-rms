import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreBusinessDaySource,
  createStoreConfigurationPublicationHash,
  type StoreBusinessDay,
} from "@rms/store";
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
}): (tx: Transaction, at: string) => Promise<StoreBusinessDay> {
  const setupSnapshotReferences = {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
  };
  const hashContent = createStoreConfigurationPublicationHash(setupSnapshotReferences);
  return createPostgresStoreBusinessDaySource({
    brandReference: options.brandReference,
    storeReference: options.storeReference,
    timeZone: options.timeZone,
    authorize: async (tx) => (await options.authorize(tx)) === true,
    publicationProof: async (tx, candidate, at) => {
      const published = await createPostgresCurrentStorePublicationProof({
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
}

/** What the browser receives: the day and its boundaries, no configuration identity. */
export function merchantBusinessDayView(day: {
  readonly businessDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly observedAt: string;
}) {
  return Object.freeze({
    businessDate: String(day.businessDate),
    startsAt: String(day.startsAt),
    endsAt: String(day.endsAt),
    timeZone: day.timeZone,
    observedAt: String(day.observedAt),
  });
}
