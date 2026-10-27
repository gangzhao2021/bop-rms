import {
  DiningSessionError,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
} from "../../domain/dining-session.js";
import {
  parseDiningPaymentTiming,
  parseStoreDiningPaymentTimingCommand,
  storeDiningPaymentTimingIntent,
  type DiningPaymentTiming,
  type StoreDiningPaymentTiming,
} from "../../domain/dining-payment-timing.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import type { DiningTableStoreScope, DiningTableTransaction } from "./dining-table-store.js";

export type StoreDiningPaymentTimingResult =
  | { readonly status: "Changed" | "AlreadyChanged"; readonly timing: StoreDiningPaymentTiming }
  /** Someone changed it since the staff member read it: nothing was written. */
  | { readonly status: "Conflict"; readonly timing: StoreDiningPaymentTiming };

const fail = (): never => {
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
};
function rows(value: unknown, maximum = 1): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return fail();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > maximum) return fail();
  return copied as Record<string, unknown>[];
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return fail();
}
const instantSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
async function staffAllowed(authorize: () => Promise<boolean> | boolean): Promise<void> {
  if ((await authorize()) !== true)
    throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: the Store's dine-in payment timing (append-only versions) and the
 * timing each table was opened with (recorded by the database when the Session starts). Staff
 * methods borrow an authorized merchant transaction; `authorize` is the merchant guard, checked
 * before and re-checked after the work.
 */
export function createPostgresDiningPaymentTimingStore(options: {
  readonly scope: DiningTableStoreScope;
  hashIntent(value: string): string;
  equals(a: string, b: string): boolean;
}) {
  const tenant = parseDiningReference(options.scope.tenantReference);
  const brand = parseDiningReference(options.scope.brandReference);
  const store = parseDiningReference(options.scope.storeReference);
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const current = async (tx: DiningTableTransaction): Promise<StoreDiningPaymentTiming> => {
    const row = rows(
      await tx.query(
        `SELECT payment_timing AS timing,version,actor_id AS actor,${instantSql("changed_at")} AS at FROM rms_dining.store_dining_payment_timing WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 ORDER BY version DESC LIMIT 1`,
        [tenant, brand, store],
      ),
    )[0];
    if (row === undefined)
      return Object.freeze({
        paymentTiming: "PayFirst" as const,
        version: 0,
        changedAt: null,
        changedByActorReference: null,
      });
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) return fail();
    return Object.freeze({
      paymentTiming: parseDiningPaymentTiming(row.timing),
      version,
      changedAt: parseDiningInstant(row.at),
      changedByActorReference: parseDiningReference(row.actor),
    });
  };
  return Object.freeze({
    /** Staff: the Store's current choice (PayFirst, version 0, while it never chose). */
    async load(
      tx: DiningTableTransaction,
      authorize: () => Promise<boolean> | boolean,
    ): Promise<StoreDiningPaymentTiming> {
      await staffAllowed(authorize);
      await context(tx);
      const timing = await current(tx);
      await staffAllowed(authorize);
      return timing;
    },

    /**
     * Staff: change it. A replay of the same operation returns what it did; a change made by
     * someone else since `expectedVersion` is a conflict and writes nothing. Only tables opened
     * after the change take it.
     */
    async change(
      tx: DiningTableTransaction,
      value: unknown,
      authorize: () => Promise<boolean> | boolean,
    ): Promise<StoreDiningPaymentTimingResult> {
      const command = parseStoreDiningPaymentTimingCommand(value);
      const intent = parseDiningHash(options.hashIntent(storeDiningPaymentTimingIntent(command)));
      await staffAllowed(authorize);
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `StoreDiningPaymentTiming:${brand}:${store}`,
      ]);
      const prior = rows(
        await tx.query(
          "SELECT intent_hash AS intent,version FROM rms_dining.store_dining_payment_timing WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
          [tenant, brand, store, command.operationReference],
        ),
      )[0];
      const latest = await current(tx);
      let result: StoreDiningPaymentTimingResult;
      if (prior !== undefined) {
        if (options.equals(String(prior.intent), intent) !== true)
          throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
        result = Object.freeze({ status: "AlreadyChanged" as const, timing: latest });
      } else if (latest.version !== command.expectedVersion) {
        result = Object.freeze({ status: "Conflict" as const, timing: latest });
      } else if (latest.paymentTiming === command.paymentTiming && latest.version > 0) {
        // Choosing what is already set records nothing new.
        result = Object.freeze({ status: "AlreadyChanged" as const, timing: latest });
      } else {
        changed(
          await tx.query(
            "INSERT INTO rms_dining.store_dining_payment_timing (tenant_id,brand_id,store_id,version,payment_timing,operation_id,intent_hash,actor_id,changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              tenant,
              brand,
              store,
              latest.version + 1,
              command.paymentTiming,
              command.operationReference,
              intent,
              command.actorReference,
              command.observedAt,
            ],
          ),
        );
        result = Object.freeze({ status: "Changed" as const, timing: await current(tx) });
      }
      await staffAllowed(authorize);
      return result;
    },

    /**
     * The timing each listed table was opened with. A Session started before this record existed
     * has none and was opened PayFirst.
     */
    async loadSessionTimings(
      tx: DiningTableTransaction,
      sessions: readonly string[],
    ): Promise<ReadonlyMap<string, DiningPaymentTiming>> {
      if (sessions.length > 500) return fail();
      const references = sessions.map((session) => parseDiningReference(session));
      if (references.length === 0) return new Map();
      await context(tx);
      const found = rows(
        await tx.query(
          "SELECT session_id AS session,payment_timing AS timing FROM rms_dining.dining_session_payment_timing WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=ANY($4::uuid[]) LIMIT 501",
          [tenant, brand, store, references],
        ),
        501,
      );
      const timings = new Map<string, DiningPaymentTiming>();
      for (const reference of references) timings.set(reference, "PayFirst");
      for (const row of found)
        timings.set(parseDiningReference(row.session), parseDiningPaymentTiming(row.timing));
      return timings;
    },
  });
}
