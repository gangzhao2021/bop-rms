import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";
import {
  parsePublicStoreProfileCandidateShape,
  type PublicStoreProfileCandidate,
} from "../../contracts/public-store-profile.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (): never => {
  throw new Error("STORE_PROFILE_PERSISTENCE_UNAVAILABLE");
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (!result || typeof result !== "object") return fail();
  const value = Object.getOwnPropertyDescriptor(result, "rows");
  if (!value || !("value" in value) || !Array.isArray(value.value)) return fail();
  return value.value;
}
/** Caller retains this transaction and Tenant/Brand association/purpose fences.
 * verifyCurrent must verify current Publishing, effective-period and Media authority.
 * The saved candidate is immutable history, not proof that its release is current.
 */
export function createPostgresPublicStoreProfileStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  verifyCurrent(
    tx: Transaction,
    profile: PublicStoreProfileCandidate,
    at: string,
  ): Promise<boolean>;
  hashSnapshot(profile: PublicStoreProfileCandidate): string;
  appendAudit(
    tx: Transaction,
    input: {
      profile: PublicStoreProfileCandidate;
      actorReference: string;
      auditReference: string;
      payloadDigest: string;
      recordedAt: string;
    },
  ): Promise<void>;
}) {
  const brand = parseBrandReference(options.brandReference),
    store = parseStoreReference(options.storeReference);
  const authority = async (tx: Transaction, at: string) => {
    if ((await options.authorize(tx, at)) !== true) return fail();
  };
  const fence = async (tx: Transaction, at: string, write: boolean) => {
    await authority(tx, at);
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query(
      write
        ? "LOCK TABLE rms_store.public_store_profile_version IN SHARE ROW EXCLUSIVE MODE"
        : "LOCK TABLE rms_store.public_store_profile_version IN SHARE MODE",
      [],
    );
  };
  const parse = (value: unknown) => {
    const initial = parsePublicStoreProfileCandidateShape(value);
    const profile = parsePublicStoreProfileCandidateShape(JSON.parse(JSON.stringify(initial)));
    if (profile.brandReference !== brand || profile.storeReference !== store) return fail();
    const digest = options.hashSnapshot(profile);
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return fail();
    return { profile, digest };
  };
  const load = async (tx: Transaction, reference: string, version: number) => {
    if (!Number.isSafeInteger(version) || version < 1) return fail();
    const result = rows(
      await tx.query(
        "SELECT profile_json,payload_digest,actor_reference,audit_reference,recorded_at FROM rms_store.public_store_profile_version WHERE brand_id=$1 AND store_id=$2 AND profile_id=$3 AND profile_version=$4",
        [brand, store, parseStoreAdministrationReference(reference), version],
      ),
    );
    if (result.length > 1) return fail();
    return result[0] ?? null;
  };
  return Object.freeze({
    async append(
      tx: Transaction,
      input: {
        profile: unknown;
        actorReference: string;
        auditReference: string;
        recordedAt: string;
      },
    ) {
      const at = parseCanonicalInstant(input.recordedAt);
      const actor = parseStoreAdministrationReference(input.actorReference),
        audit = parseStoreAdministrationReference(input.auditReference);
      const { profile, digest } = parse(input.profile);
      await fence(tx, at, true);
      if ((await options.verifyCurrent(tx, profile, at)) !== true) return fail();
      const prior = await load(tx, profile.profileReference, profile.profileVersion);
      if (prior) {
        const saved = parse(prior.profile_json);
        if (
          saved.digest !== digest ||
          prior.payload_digest !== digest ||
          prior.actor_reference !== actor ||
          prior.audit_reference !== audit
        )
          return fail();
        await authority(tx, at);
        return "Existing" as const;
      }
      await tx.query(
        "INSERT INTO rms_store.public_store_profile_version (brand_id,store_id,profile_id,profile_version,payload_digest,profile_json,actor_reference,audit_reference,recorded_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)",
        [
          brand,
          store,
          profile.profileReference,
          profile.profileVersion,
          digest,
          JSON.stringify(profile),
          actor,
          audit,
          at,
        ],
      );
      await options.appendAudit(tx, {
        profile,
        actorReference: actor,
        auditReference: audit,
        payloadDigest: digest,
        recordedAt: at,
      });
      await authority(tx, at);
      return "Created" as const;
    },
    /**
     * WP-2423 store name (DEC-STORE-CUSTOMER-NAME): the Store's current published profile — the
     * newest saved version whose release is still the current Publishing release and whose timing
     * is effective now. An Owner publication supersedes earlier versions, so customers, the pickup
     * panel and new receipts all follow it without an operator pin. `null` when none is current.
     */
    async loadLatestCurrent(tx: Transaction, observedAt: string) {
      const at = parseCanonicalInstant(observedAt);
      await fence(tx, at, false);
      const found = rows(
        await tx.query(
          "SELECT profile_id,profile_version,profile_json,payload_digest,recorded_at FROM rms_store.public_store_profile_version WHERE brand_id=$1 AND store_id=$2 AND recorded_at<=$3 ORDER BY recorded_at DESC,profile_version DESC LIMIT 8",
          [brand, store, at],
        ),
      );
      for (const row of found) {
        const { profile, digest } = parse(row.profile_json);
        if (
          row.payload_digest !== digest ||
          row.profile_id !== profile.profileReference ||
          row.profile_version !== profile.profileVersion ||
          !(row.recorded_at instanceof Date)
        )
          return fail();
        if ((await options.verifyCurrent(tx, profile, at)) === true) {
          await authority(tx, at);
          return profile;
        }
      }
      await authority(tx, at);
      return null;
    },
    /** Highest saved version of one profile (0 when none), so a new version never collides. */
    async highestVersion(tx: Transaction, reference: string, observedAt: string) {
      const at = parseCanonicalInstant(observedAt);
      await fence(tx, at, true);
      const found = rows(
        await tx.query(
          "SELECT coalesce(max(profile_version),0)::int AS version FROM rms_store.public_store_profile_version WHERE brand_id=$1 AND store_id=$2 AND profile_id=$3",
          [brand, store, parseStoreAdministrationReference(reference)],
        ),
      );
      const version = found[0]?.version;
      if (found.length !== 1 || typeof version !== "number" || !Number.isSafeInteger(version))
        return fail();
      await authority(tx, at);
      return version;
    },
    /**
     * One publication per Store at a time, held until the caller's transaction ends. The write
     * lock is taken first, before any Publishing or timing lock, so readers (which lock this table
     * before Publishing) wait instead of deadlocking with the publication.
     */
    async lockPublication(tx: Transaction, observedAt: string) {
      const at = parseCanonicalInstant(observedAt);
      await authority(tx, at);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StorePublicProfilePublication:" + brand + ":" + store,
      ]);
      await fence(tx, at, true);
    },
    async loadExact(tx: Transaction, reference: string, version: number, observedAt: string) {
      const at = parseCanonicalInstant(observedAt);
      await fence(tx, at, false);
      const row = await load(tx, reference, version);
      if (!row) {
        await authority(tx, at);
        return null;
      }
      const { profile, digest } = parse(row.profile_json);
      if (
        row.payload_digest !== digest ||
        profile.profileReference !== reference ||
        profile.profileVersion !== version ||
        !(row.recorded_at instanceof Date) ||
        row.recorded_at.toISOString() > at ||
        (await options.verifyCurrent(tx, profile, at)) !== true
      )
        return fail();
      await authority(tx, at);
      return profile;
    },
  });
}
