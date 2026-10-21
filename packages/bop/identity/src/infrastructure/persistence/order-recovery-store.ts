import type { OrderRecoveryStorePort } from "../../application/order-recovery-service.js";
import { OrderRecoveryError } from "../../application/order-recovery-service.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex32 = /^[0-9a-f]{64}$/u;
const unavailable = (): never => {
  throw new OrderRecoveryError("ORDER_RECOVERY_UNAVAILABLE");
};
const rows = (value: unknown): readonly Record<string, unknown>[] => {
  const found: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")?.value
      : undefined;
  return Array.isArray(found) ? (found as Record<string, unknown>[]) : unavailable();
};
const rowCount = (value: unknown): number => {
  const count: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")?.value
      : undefined;
  return typeof count === "number" ? count : unavailable();
};
const candidateArrays = (
  candidates: readonly { readonly tokenHash: string; readonly pepperVersion: number }[],
) => {
  if (
    candidates.length < 1 ||
    candidates.length > 4 ||
    candidates.some(
      (c) =>
        !hex32.test(c.tokenHash) || !Number.isSafeInteger(c.pepperVersion) || c.pepperVersion < 1,
    )
  )
    return unavailable();
  return [candidates.map((c) => c.tokenHash), candidates.map((c) => c.pepperVersion)];
};

const matching = `SELECT a.authorization_id::text AS authorization_id, a.order_id::text AS order_id,
 a.guest_session_id::text AS guest_session_id
FROM bop_identity.order_recovery_authorization a
JOIN unnest($3::text[], $4::integer[]) AS c(token_hex, pepper_version)
 ON a.token_hash = decode(c.token_hex, 'hex') AND a.pepper_version = c.pepper_version
WHERE a.brand_id = $1 AND a.store_id = $2 AND a.purpose = 'OrderResume' AND a.expires_at > $5
 AND a.issued_at <= $5
 AND NOT EXISTS (SELECT 1 FROM bop_identity.order_recovery_consumption x
  WHERE x.authorization_id = a.authorization_id)`;

/**
 * DEC-PILOT-NOTIFICATIONS R1: Identity-owned order recovery persistence for one Store scope. Mint
 * and consume each run in their own transaction (the runner commits before resolving).
 */
export function createPostgresOrderRecoveryStore(
  runner: { run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> },
  scope: { readonly brandReference: string; readonly storeReference: string },
): OrderRecoveryStorePort {
  if (!uuidV7.test(scope.brandReference) || !uuidV7.test(scope.storeReference))
    return unavailable();
  const brand = scope.brandReference,
    store = scope.storeReference;
  const scoped = (tx: Transaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  return Object.freeze<OrderRecoveryStorePort>({
    async appendAuthorization(input) {
      for (const value of [
        input.authorizationReference,
        input.orderReference,
        input.guestSessionReference,
        input.notificationAttemptReference,
      ])
        if (!uuidV7.test(value)) return unavailable();
      if (!hex32.test(input.tokenHash)) return unavailable();
      return runner.run(async (tx) => {
        await scoped(tx);
        // Serialize mints for one Order so the sibling limit holds under concurrency.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2423))", [
          `order-recovery:${brand}:${store}:${input.orderReference}`,
        ]);
        const active = rows(
          await tx.query(
            "SELECT count(*)::integer AS n FROM bop_identity.order_recovery_authorization a " +
              "WHERE a.brand_id=$1 AND a.store_id=$2 AND a.order_id=$3 AND a.expires_at > $4::timestamptz " +
              "AND NOT EXISTS (SELECT 1 FROM bop_identity.order_recovery_consumption x WHERE x.authorization_id=a.authorization_id)",
            [brand, store, input.orderReference, input.issuedAt],
          ),
        );
        const count = active[0]?.n;
        if (typeof count !== "number") return unavailable();
        if (count >= 2) return "SiblingLimit" as const;
        const inserted = await tx.query(
          "INSERT INTO bop_identity.order_recovery_authorization " +
            "(authorization_id,brand_id,store_id,order_id,guest_session_id,purpose,token_hash,pepper_version," +
            "notification_attempt_id,issued_at,expires_at) " +
            "VALUES ($1,$2,$3,$4,$5,'OrderResume',decode($6,'hex'),$7,$8,$9::timestamptz,$10::timestamptz)",
          [
            input.authorizationReference,
            brand,
            store,
            input.orderReference,
            input.guestSessionReference,
            input.tokenHash,
            input.pepperVersion,
            input.notificationAttemptReference,
            input.issuedAt,
            input.expiresAt,
          ],
        );
        if (rowCount(inserted) !== 1) return unavailable();
        return "Created" as const;
      });
    },

    async peekOrder(input) {
      const [hashes, versions] = candidateArrays(input.candidates);
      const found = await runner.run(async (tx) => {
        await scoped(tx);
        return rows(
          await tx.query(
            "SELECT a.order_id::text AS order_id FROM bop_identity.order_recovery_authorization a " +
              "JOIN unnest($3::text[], $4::integer[]) AS c(token_hex, pepper_version) " +
              "ON a.token_hash = decode(c.token_hex, 'hex') AND a.pepper_version = c.pepper_version " +
              "WHERE a.brand_id=$1 AND a.store_id=$2 LIMIT 1",
            [brand, store, hashes, versions],
          ),
        );
      });
      const order = found[0]?.order_id;
      return typeof order === "string" && uuidV7.test(order) ? order : null;
    },

    async consumeAndRekey(input) {
      const [hashes, versions] = candidateArrays(input.candidates);
      if (
        !uuidV7.test(input.rekeyOperationReference) ||
        !hex32.test(input.rekeyOperationIntentHash) ||
        !hex32.test(input.sessionSelectorHash) ||
        !hex32.test(input.csrfSelectorHash)
      )
        return unavailable();
      const observedAt = input.observedAt;
      try {
        return await runner.run(async (tx) => {
          await scoped(tx);
          const target = rows(
            await tx.query(matching, [brand, store, hashes, versions, observedAt]),
          );
          const authorization = target[0];
          if (target.length !== 1 || !authorization) throw new NotRedeemable();
          const authorizationId = String(authorization.authorization_id),
            orderId = String(authorization.order_id),
            sessionId = String(authorization.guest_session_id);
          // Serialize with mints and other consumes for this Order, then re-check with a fresh
          // snapshot that the authorization is still unconsumed (no row lock on append-only rows).
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2423))", [
            `order-recovery:${brand}:${store}:${orderId}`,
          ]);
          const still = rows(
            await tx.query(`${matching} AND a.authorization_id = $6`, [
              brand,
              store,
              hashes,
              versions,
              observedAt,
              authorizationId,
            ]),
          );
          if (still.length !== 1) throw new NotRedeemable();
          // The session must still be Active and inside its absolute and closure limits (§86).
          const session = rows(
            await tx.query(
              "SELECT version FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2 " +
                "AND guest_session_id=$3 AND status='Active' AND absolute_expires_at > $4::timestamptz " +
                "AND (closure_expires_at IS NULL OR closure_expires_at > $4::timestamptz) " +
                "AND last_seen_at <= $4::timestamptz FOR UPDATE",
              [brand, store, sessionId, observedAt],
            ),
          );
          const version = session[0]?.version;
          if (session.length !== 1 || typeof version !== "number") throw new NotRedeemable();
          const consumed = await tx.query(
            "INSERT INTO bop_identity.order_recovery_consumption " +
              "(authorization_id,brand_id,store_id,outcome,guest_session_id,rekey_operation_id,recorded_at) " +
              "VALUES ($1,$2,$3,'Consumed',$4,$5,$6::timestamptz) ON CONFLICT DO NOTHING",
            [authorizationId, brand, store, sessionId, input.rekeyOperationReference, observedAt],
          );
          // A concurrent consume of the same token committed first: uniform failure.
          if (rowCount(consumed) !== 1) throw new NotRedeemable();
          await tx.query(
            "INSERT INTO bop_identity.order_recovery_consumption " +
              "(authorization_id,brand_id,store_id,outcome,guest_session_id,rekey_operation_id,recorded_at) " +
              "SELECT a.authorization_id,a.brand_id,a.store_id,'Revoked',a.guest_session_id,NULL,$4::timestamptz " +
              "FROM bop_identity.order_recovery_authorization a WHERE a.brand_id=$1 AND a.store_id=$2 " +
              "AND a.order_id=$3 AND a.authorization_id <> $5 " +
              "AND NOT EXISTS (SELECT 1 FROM bop_identity.order_recovery_consumption x WHERE x.authorization_id=a.authorization_id)",
            [brand, store, orderId, observedAt, authorizationId],
          );
          const updated = await tx.query(
            "UPDATE bop_identity.guest_session SET session_selector_hash=decode($4,'hex'), " +
              "csrf_selector_hash=decode($5,'hex'), operation_id=$6, operation_intent_hash=decode($7,'hex'), " +
              "last_seen_at=$8::timestamptz, idle_expires_at=$8::timestamptz + interval '4 hours', version=version+1 " +
              "WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3 AND version=$9 AND status='Active'",
            [
              brand,
              store,
              sessionId,
              input.sessionSelectorHash,
              input.csrfSelectorHash,
              input.rekeyOperationReference,
              input.rekeyOperationIntentHash,
              observedAt,
              version,
            ],
          );
          if (rowCount(updated) !== 1) throw new NotRedeemable();
          // Keep the session's operation history complete (the snapshot names the re-key).
          const appended = await tx.query(
            "INSERT INTO bop_identity.guest_session_operation " +
              "(guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash," +
              "brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version," +
              "dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,order_closed_at," +
              "closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,version," +
              "dining_session_id,dining_participant_id) " +
              "SELECT guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash," +
              "brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version," +
              "dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,order_closed_at," +
              "closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,version," +
              "dining_session_id,dining_participant_id FROM bop_identity.guest_session " +
              "WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3",
            [brand, store, sessionId],
          );
          if (rowCount(appended) !== 1) throw new NotRedeemable();
          return Object.freeze({ orderReference: orderId });
        });
      } catch (error) {
        if (error instanceof NotRedeemable) return null;
        throw new OrderRecoveryError("ORDER_RECOVERY_UNAVAILABLE");
      }
    },
  });
}

/** Rolls the consume transaction back without distinguishing why (uniform failure). */
class NotRedeemable extends Error {}
