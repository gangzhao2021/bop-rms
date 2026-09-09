import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  assertGuestSessionUsable,
  createGuestSession,
  parseCanonicalInstant,
  readClosedRecord,
  type GuestBindingOwnerPort,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import { createActiveCartLifecycle } from "../../domain/cart-lifecycle.js";
import {
  createPostgresCartQueryStore,
  type CartQueryTransaction,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";

type Prepare = Parameters<GuestBindingOwnerPort["prepare"]>[0];
type Completion = Parameters<GuestBindingOwnerPort["activate"]>[0];
export interface PickupCartBindingOptions {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly policy: {
    readonly policyVersionReference: string;
    readonly policyDigest: string;
    readonly idleTimeoutSeconds: number;
    readonly absoluteTimeoutSeconds: number;
    readonly validFrom: string;
    readonly validUntil: string;
  };
  readonly sourceChannel: "Qr" | "Web";
  readonly generateReference: () => string;
  readonly now: () => unknown;
  readonly audit: (input: {
    readonly action: "Prepared" | "Activated";
    readonly operationReference: string;
    readonly cartReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly occurredAt: string;
  }) => unknown;
}
export interface PickupCartBindingStore extends GuestBindingOwnerPort {
  /** Current Identity authorization is required; this internal aggregate is never an HTTP DTO. */
  current(session: GuestSession, observedAt: unknown): Promise<CartAggregate | null>;
}
interface Binding {
  readonly intent: Omit<Prepare, "observedAt">;
  readonly preparedAt: string;
  readonly activatedAt: string | null;
}
function fail(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, fields: readonly string[]) {
  return readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
}
function rows(value: unknown): unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  )
    fail();
  return value.rows;
}
function intent(value: unknown): Omit<Prepare, "observedAt"> {
  const raw = closed(value, [
    "operationReference",
    "targetReference",
    "sessionReference",
    "predecessorSessionReference",
    "brandReference",
    "storeReference",
    "acknowledgedAt",
    "validUntil",
  ]);
  const parsed = {
    operationReference: parseOrderingReference(raw.operationReference),
    targetReference: parseOrderingReference(raw.targetReference),
    sessionReference: parseOrderingReference(raw.sessionReference),
    predecessorSessionReference: parseOrderingReference(raw.predecessorSessionReference),
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
    acknowledgedAt: parseCanonicalInstant(raw.acknowledgedAt),
    validUntil: parseCanonicalInstant(raw.validUntil),
  };
  if (
    parsed.sessionReference === parsed.predecessorSessionReference ||
    Date.parse(parsed.validUntil) <= Date.parse(parsed.acknowledgedAt) ||
    Date.parse(parsed.validUntil) - Date.parse(parsed.acknowledgedAt) > 900_000
  )
    fail();
  return Object.freeze(parsed);
}
const selectBinding = `SELECT jsonb_build_object(
 'operationReference',operation_id,'targetReference',cart_id,'sessionReference',guest_session_id,
 'predecessorSessionReference',predecessor_session_id,'brandReference',brand_id,'storeReference',store_id,
 'acknowledgedAt',to_char(acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'validUntil',to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS intent,
 to_char(prepared_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "preparedAt",
 to_char(activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "activatedAt"
 FROM rms_ordering.cart_binding_record
 WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 ORDER BY revision DESC LIMIT 1`;

// This is a trusted owner port, not an authorization boundary. Identity's service supplies receipts
// only after current authorization and credential acknowledgement. No cross-owner SQL is permitted.
export function createPostgresPickupCartBindingStore(
  runner: CartQueryTransactionRunner,
  options: PickupCartBindingOptions,
): PickupCartBindingStore {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const rawPolicy = closed(options.policy, [
    "policyVersionReference",
    "policyDigest",
    "idleTimeoutSeconds",
    "absoluteTimeoutSeconds",
    "validFrom",
    "validUntil",
  ]);
  const policy = Object.freeze({
    policyVersionReference: parseOrderingReference(rawPolicy.policyVersionReference),
    policyDigest: parseOrderingHash(rawPolicy.policyDigest),
    idleTimeoutSeconds: rawPolicy.idleTimeoutSeconds,
    absoluteTimeoutSeconds: rawPolicy.absoluteTimeoutSeconds,
  });
  const validFrom = parseOrderingInstant(rawPolicy.validFrom);
  const validUntil = parseOrderingInstant(rawPolicy.validUntil);
  createActiveCartLifecycle({ ...policy, startedAt: validFrom });
  if (
    Date.parse(validUntil) <= Date.parse(validFrom) ||
    !["Qr", "Web"].includes(options.sourceChannel)
  )
    fail();
  const sourceChannel = options.sourceChannel;
  function inScope(value: { brandReference: string; storeReference: string }) {
    if (value.brandReference !== brand || value.storeReference !== store) fail();
  }
  function guest(value: unknown, at: string) {
    const session = assertGuestSessionUsable(createGuestSession(value), at);
    inScope(session);
    if (
      session.channel !== "Pickup" ||
      session.diningState !== "ContextOnly" ||
      Date.parse(at) < Date.parse(session.lastSeenAt)
    )
      fail();
    return session;
  }
  function policyCurrent(at: string) {
    if (Date.parse(at) < Date.parse(validFrom) || Date.parse(at) >= Date.parse(validUntil)) fail();
  }
  async function run<T>(action: (tx: CartQueryTransaction) => Promise<T>): Promise<T> {
    return runner.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
        [brand, store],
      );
      return action(tx);
    });
  }
  async function load(tx: CartQueryTransaction, operation: string): Promise<Binding | null> {
    const result = rows(await tx.query(selectBinding, [brand, store, operation]));
    if (result.length === 0) return null;
    if (result.length !== 1) fail();
    const raw = closed(result[0], ["intent", "preparedAt", "activatedAt"]);
    const parsed = {
      intent: intent(raw.intent),
      preparedAt: parseOrderingInstant(raw.preparedAt),
      activatedAt: raw.activatedAt === null ? null : parseOrderingInstant(raw.activatedAt),
    };
    inScope(parsed.intent);
    if (
      parsed.intent.operationReference !== operation ||
      Date.parse(parsed.preparedAt) < Date.parse(parsed.intent.acknowledgedAt) ||
      Date.parse(parsed.preparedAt) >= Date.parse(parsed.intent.validUntil) ||
      (parsed.activatedAt !== null &&
        (Date.parse(parsed.activatedAt) < Date.parse(parsed.preparedAt) ||
          Date.parse(parsed.activatedAt) >= Date.parse(parsed.intent.validUntil)))
    )
      fail();
    return parsed;
  }
  async function append(tx: CartQueryTransaction, binding: Binding, occurredAt: string) {
    const i = binding.intent;
    const inserted = rows(
      await tx.query(
        `INSERT INTO rms_ordering.cart_binding_record
      (operation_id,revision,brand_id,store_id,cart_id,guest_session_id,predecessor_session_id,
       acknowledged_at,prepared_at,valid_until,activated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING operation_id`,
        [
          i.operationReference,
          binding.activatedAt === null ? 1 : 2,
          brand,
          store,
          i.targetReference,
          i.sessionReference,
          i.predecessorSessionReference,
          i.acknowledgedAt,
          binding.preparedAt,
          i.validUntil,
          binding.activatedAt,
        ],
      ),
    );
    if (inserted.length === 0) return false;
    if (inserted.length !== 1) fail();
    const action = binding.activatedAt === null ? "Prepared" : "Activated";
    const audit = validateAuditRecord(
      options.audit({
        action,
        operationReference: i.operationReference,
        cartReference: i.targetReference,
        brandReference: brand,
        storeReference: store,
        occurredAt,
      }),
      Date.parse(occurredAt),
    );
    if (
      audit.brandId !== brand ||
      audit.storeId !== store ||
      audit.actor.type !== "System" ||
      audit.actionCode !== `ORDERING_CART_BINDING_${action.toUpperCase()}` ||
      audit.targetType !== "OrderingCart" ||
      audit.targetId !== i.targetReference ||
      audit.reasonCode !== "AUTHORIZED_CART_BINDING" ||
      audit.occurredAt !== occurredAt ||
      audit.sourceChannel !== "CUSTOMER_PWA" ||
      audit.dataClassification !== "Restricted" ||
      audit.beforeSummary !== undefined ||
      audit.afterSummary !== undefined
    )
      fail();
    await appendAuditRecordInTransaction(tx, audit);
    return true;
  }
  const evidence = (binding: Binding) =>
    Object.freeze({
      operationReference: binding.intent.operationReference,
      targetReference: binding.intent.targetReference,
      sessionReference: binding.intent.sessionReference,
      brandReference: brand,
      storeReference: store,
      bindingVersion: 1,
      preparedAt: parseCanonicalInstant(binding.preparedAt),
      validUntil: binding.intent.validUntil,
    });
  return Object.freeze({
    async reserveTarget(input: Parameters<GuestBindingOwnerPort["reserveTarget"]>[0]) {
      try {
        const raw = closed(input, ["operationReference", "session", "observedAt"]);
        const operationReference = parseOrderingReference(raw.operationReference);
        const at = parseCanonicalInstant(raw.observedAt);
        const session = guest(raw.session, at);
        policyCurrent(at);
        return await run(async (tx) => {
          const existing = rows(
            await tx.query(
              `SELECT operation_id FROM rms_ordering.cart_binding_record
            WHERE brand_id=$1 AND store_id=$2 AND revision=2
            AND (guest_session_id=$3 OR predecessor_session_id=$3) LIMIT 1`,
              [brand, store, session.sessionReference],
            ),
          );
          if (existing.length > 0) return null;
          return Object.freeze({
            operationReference,
            targetReference: parseOrderingReference(options.generateReference()),
            sessionReference: session.sessionReference,
            brandReference: brand,
            storeReference: store,
            expectedVersion: session.version,
            validUntil: parseCanonicalInstant(validUntil),
          });
        });
      } catch {
        return fail();
      }
    },
    async prepare(input: Prepare) {
      try {
        const raw = closed(input, [
          "operationReference",
          "targetReference",
          "sessionReference",
          "predecessorSessionReference",
          "brandReference",
          "storeReference",
          "acknowledgedAt",
          "validUntil",
          "observedAt",
        ]);
        const { observedAt, ...rest } = raw;
        const i = intent(rest);
        inScope(i);
        const at = parseOrderingInstant(observedAt);
        if (
          Date.parse(at) < Date.parse(i.acknowledgedAt) ||
          Date.parse(at) >= Date.parse(i.validUntil)
        )
          fail();
        return await run(async (tx) => {
          const replay = (prior: Binding) => {
            if (JSON.stringify(prior.intent) !== JSON.stringify(i)) fail();
            return evidence(prior);
          };
          const prior = await load(tx, i.operationReference);
          if (prior !== null) return replay(prior);
          policyCurrent(at);
          if (Date.parse(i.validUntil) > Date.parse(validUntil)) fail();
          const lifecycle = createActiveCartLifecycle({ ...policy, startedAt: at });
          // The append-only operation serializes contenders. Its Cart FK is checked at commit,
          // after the new Cart exists; existing Cart identity rules remain untouched.
          const binding = { intent: i, preparedAt: at, activatedAt: null };
          if (!(await append(tx, binding, at))) {
            const winner = await load(tx, i.operationReference);
            if (winner === null) fail();
            return replay(winner);
          }
          const inserted = rows(
            await tx.query(
              `INSERT INTO rms_ordering.cart
            (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at,
             lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
            VALUES ($1,$2,$3,'Pickup',$4,$5,1,$6,$6,'Active',$7,$8,$9,$10,$11,$12)
            RETURNING cart_id`,
              [
                i.targetReference,
                brand,
                store,
                sourceChannel,
                i.sessionReference,
                at,
                lifecycle.policyVersionReference,
                lifecycle.policyDigest,
                lifecycle.idleTimeoutSeconds,
                lifecycle.absoluteTimeoutSeconds,
                lifecycle.idleExpiresAt,
                lifecycle.absoluteExpiresAt,
              ],
            ),
          );
          if (inserted.length !== 1) fail();
          return evidence(binding);
        });
      } catch {
        return fail();
      }
    },
    async activate(input: Completion) {
      try {
        const raw = closed(input, [
          "operationReference",
          "targetReference",
          "sessionReference",
          "brandReference",
          "storeReference",
          "activatedAt",
        ]);
        const receipt = {
          operationReference: parseOrderingReference(raw.operationReference),
          targetReference: parseOrderingReference(raw.targetReference),
          sessionReference: parseOrderingReference(raw.sessionReference),
          brandReference: parseOrderingReference(raw.brandReference),
          storeReference: parseOrderingReference(raw.storeReference),
          activatedAt: parseOrderingInstant(raw.activatedAt),
        };
        inScope(receipt);
        const at = parseOrderingInstant(options.now());
        if (Date.parse(receipt.activatedAt) > Date.parse(at)) fail();
        return await run(async (tx) => {
          if (
            rows(
              await tx.query(
                `SELECT cart_id FROM rms_ordering.cart
            WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND order_type='Pickup'
            AND created_by_actor_id=$4 FOR UPDATE`,
                [brand, store, receipt.targetReference, receipt.sessionReference],
              ),
            ).length !== 1
          )
            fail();
          const prior = await load(tx, receipt.operationReference);
          if (
            prior === null ||
            prior.intent.targetReference !== receipt.targetReference ||
            prior.intent.sessionReference !== receipt.sessionReference ||
            Date.parse(receipt.activatedAt) < Date.parse(prior.preparedAt) ||
            Date.parse(receipt.activatedAt) >= Date.parse(prior.intent.validUntil)
          )
            fail();
          if (prior.activatedAt !== null) {
            if (prior.activatedAt !== receipt.activatedAt) fail();
          } else if (!(await append(tx, { ...prior, activatedAt: receipt.activatedAt }, at)))
            fail();
          return "Activated" as const;
        });
      } catch {
        return fail();
      }
    },
    async current(sessionValue: GuestSession, observedAt: unknown) {
      try {
        const at = parseOrderingInstant(observedAt);
        const session = guest(sessionValue, at);
        return await run(async (tx) => {
          const result = rows(
            await tx.query(
              `SELECT cart_id FROM rms_ordering.cart_binding_record
            WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3 AND revision=2 AND activated_at<=$4`,
              [brand, store, session.sessionReference, at],
            ),
          );
          if (result.length === 0) return null;
          if (result.length !== 1) fail();
          const cartReference = parseOrderingReference(closed(result[0], ["cart_id"]).cart_id);
          const cart = await createPostgresCartQueryStore(
            {
              run: async <T>(action: (borrowed: CartQueryTransaction) => Promise<T>) => action(tx),
            },
            { brandReference: brand, storeReference: store },
          ).load(cartReference);
          if (
            cart === null ||
            cart.orderType !== "Pickup" ||
            cart.createdByActorReference !== String(session.sessionReference)
          )
            fail();
          return cart;
        });
      } catch {
        return fail();
      }
    },
  });
}
