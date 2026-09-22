import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CartError,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import { assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import { prepareDiningCartReplacement } from "../../domain/dining-cart-replacement.js";
import {
  createPostgresCartQueryStore,
  type CartQueryTransaction,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";
import type { DiningCartSelectionStoreOptions } from "./dining-cart-selection-store.js";

const referenceFields = [
  "operationReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "guestSessionReference",
  "participantReference",
  "previousCartReference",
] as const;
export interface DiningCartReplacementCommand {
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly diningSessionReference: string;
  readonly guestSessionReference: string;
  readonly participantReference: string;
  readonly previousCartReference: string;
  readonly expectedCartVersion: number;
  readonly observedAt: string;
}
export interface DiningCartReplacementOptions {
  readonly scope: DiningCartSelectionStoreOptions["scope"];
  readonly policy: DiningCartSelectionStoreOptions["policy"];
  readonly generateReference: () => string;
  readonly now: () => unknown;
  /** Must establish and retain current Identity/Dining Host authority in this transaction.
   * Replays also require current authority. Acquire any outer Dining fences before Cart locks. */
  readonly authorizeAndFence: (
    tx: CartQueryTransaction,
    command: DiningCartReplacementCommand,
  ) => Promise<boolean>;
  /** Complete allocation history and authoritative settlement, under retained Cart lock.
   * Missing/unknown outcomes are not clearance. Never acquire OrderDisposition after Cart. */
  readonly settlementClear: (
    tx: CartQueryTransaction,
    cart: CartAggregate,
    observedAt: string,
  ) => Promise<boolean>;
  readonly audit: (input: {
    readonly operationReference: string;
    readonly cartReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly occurredAt: string;
  }) => unknown;
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function conflict(): never {
  throw new CartError("CART_IDEMPOTENCY_CONFLICT");
}
function rows(result: unknown): unknown[] {
  if (!result || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return unavailable();
  return descriptor.value;
}
function parseCommand(value: unknown): DiningCartReplacementCommand {
  const raw = readClosedRecord(value, [...referenceFields, "expectedCartVersion", "observedAt"]);
  const references = {
    operationReference: parseOrderingReference(raw.operationReference),
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
    diningSessionReference: parseOrderingReference(raw.diningSessionReference),
    guestSessionReference: parseOrderingReference(raw.guestSessionReference),
    participantReference: parseOrderingReference(raw.participantReference),
    previousCartReference: parseOrderingReference(raw.previousCartReference),
  };
  if (
    typeof raw.expectedCartVersion !== "number" ||
    !Number.isSafeInteger(raw.expectedCartVersion) ||
    raw.expectedCartVersion < 1 ||
    raw.expectedCartVersion > 2147483647
  )
    throw new CartError("CART_INPUT_INVALID");
  return Object.freeze({
    ...references,
    expectedCartVersion: raw.expectedCartVersion,
    observedAt: parseOrderingInstant(raw.observedAt),
  });
}
const priorSql = `SELECT intent_digest AS "intentDigest", cart_id AS "cartReference",
 to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
 to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
 FROM rms_ordering.dining_cart_replacement WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`;
const currentSql = `SELECT cart_id AS "cartReference", aggregate_version AS "cartVersion"
 FROM rms_ordering.cart AS candidate WHERE brand_id=$1 AND store_id=$2 AND dining_session_id=$3
 AND order_type='DineIn' AND source_channel IN ('Qr','Web')
 AND NOT EXISTS(SELECT 1 FROM rms_ordering.dining_cart_replacement AS replacement
 WHERE replacement.brand_id=candidate.brand_id AND replacement.store_id=candidate.store_id
 AND replacement.dining_session_id=candidate.dining_session_id AND replacement.previous_cart_id=candidate.cart_id)
 ORDER BY cart_id LIMIT 2 FOR UPDATE OF candidate`;

/** Transaction runner must roll back every thrown error. Not a standalone authorization surface. */
export function createPostgresDiningCartReplacementStore(
  runner: CartQueryTransactionRunner,
  options: DiningCartReplacementOptions,
) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const policy = Object.freeze({ ...options.policy });
  const { now, generateReference, authorizeAndFence, settlementClear, audit: makeAudit } = options;
  if (
    [now, generateReference, authorizeAndFence, settlementClear, makeAudit].some(
      (value) => typeof value !== "function",
    )
  )
    throw new CartError("CART_INPUT_INVALID");
  return Object.freeze({
    async replace(value: unknown) {
      let command: DiningCartReplacementCommand;
      try {
        command = parseCommand(value);
        if (
          command.brandReference !== scope.brandReference ||
          command.storeReference !== scope.storeReference
        )
          throw new Error("scope");
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      const digest =
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              ...referenceFields.map((key) => command[key]),
              command.expectedCartVersion,
            ]),
          )
          .digest("hex");
      let previous = command.observedAt;
      const tick = () => {
        const at = parseOrderingInstant(now());
        if (at < previous) return unavailable();
        previous = at;
        return at;
      };
      try {
        return await runner.run(async (tx) => {
          tick();
          await tx.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [scope.brandReference, scope.storeReference],
          );
          if ((await authorizeAndFence(tx, command)) !== true) return unavailable();
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `ordering.dining-cart.operation:${scope.brandReference}:${scope.storeReference}:${command.operationReference}`,
          ]);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `ordering.dining-cart.session:${scope.brandReference}:${scope.storeReference}:${command.diningSessionReference}`,
          ]);
          const prior = rows(
            await tx.query(priorSql, [
              scope.brandReference,
              scope.storeReference,
              command.operationReference,
            ]),
          );
          if (prior.length > 1) return unavailable();
          if (prior.length === 1) {
            const stored = readClosedRecord(prior[0], [
              "intentDigest",
              "cartReference",
              "occurredAt",
              "expiresAt",
            ]);
            const occurredAt = parseOrderingInstant(stored.occurredAt),
              expiresAt = parseOrderingInstant(stored.expiresAt),
              cartReference = parseOrderingReference(stored.cartReference);
            const at = tick();
            if (
              stored.intentDigest !== digest ||
              at < occurredAt ||
              at >= expiresAt ||
              Date.parse(expiresAt) - Date.parse(occurredAt) !== 86400000 ||
              cartReference === command.previousCartReference
            )
              return conflict();
            if ((await authorizeAndFence(tx, command)) !== true) return unavailable();
            if (tick() >= expiresAt) return conflict();
            return Object.freeze({
              operationReference: command.operationReference,
              previousCartReference: command.previousCartReference,
              cartReference,
              occurredAt,
              expiresAt,
            });
          }
          const current = rows(
            await tx.query(currentSql, [
              scope.brandReference,
              scope.storeReference,
              command.diningSessionReference,
            ]),
          );
          if (current.length !== 1) return unavailable();
          const header = readClosedRecord(current[0], ["cartReference", "cartVersion"]);
          if (
            header.cartReference !== command.previousCartReference ||
            header.cartVersion !== command.expectedCartVersion
          )
            throw new CartError("CART_VERSION_CONFLICT");
          const cart = await createPostgresCartQueryStore(
            { run: async (action) => action(tx) },
            scope,
          ).load(command.previousCartReference);
          if (cart === null) return unavailable();
          const occurredAt = tick();
          const decision = prepareDiningCartReplacement({
            previousCart: cart,
            expectedCartVersion: command.expectedCartVersion,
            ...scope,
            diningSessionReference: command.diningSessionReference,
            guestSessionReference: command.guestSessionReference,
            participantReference: command.participantReference,
            observedAt: occurredAt,
            creation: {
              cartReference: generateReference(),
              sourceChannel: cart.sourceChannel,
              policy,
            },
          });
          if ((await settlementClear(tx, cart, tick())) !== true) return unavailable();
          if ((await authorizeAndFence(tx, command)) !== true) return unavailable();
          const successor = decision.cart,
            lifecycle = successor.lifecycle;
          if (lifecycle === null) return unavailable();
          const fresh = () => {
            const at = tick();
            assertCartLifecycleActive(lifecycle, at);
            if (at < policy.validFrom || at >= policy.validUntil)
              throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
          };
          const rawAudit = readClosedRecord(
            makeAudit({
              ...scope,
              operationReference: command.operationReference,
              cartReference: successor.cartReference,
              occurredAt,
            }),
            [
              "auditId",
              "brandId",
              "storeId",
              "actor",
              "actionCode",
              "targetType",
              "targetId",
              "reasonCode",
              "correlationId",
              "occurredAt",
              "sourceChannel",
              "dataClassification",
              "retentionPolicyCode",
              "retentionPolicyVersion",
            ],
          );
          const actor = readClosedRecord(rawAudit.actor, ["type"]);
          if (actor.type !== "System") return unavailable();
          const audit = validateAuditRecord(
            { ...rawAudit, actor: { type: "System" } },
            Date.parse(occurredAt),
          );
          if (
            audit.brandId !== scope.brandReference ||
            audit.storeId !== scope.storeReference ||
            audit.actionCode !== "ORDERING_DINING_CART_REPLACE" ||
            audit.targetType !== "OrderingCart" ||
            audit.targetId !== successor.cartReference ||
            audit.reasonCode !== "AUTHORIZED_CART_REPLACEMENT" ||
            audit.correlationId !== command.operationReference ||
            audit.occurredAt !== occurredAt ||
            audit.sourceChannel !== "CUSTOMER_PWA" ||
            audit.dataClassification !== "Restricted"
          )
            return unavailable();
          fresh();
          const inserted = rows(
            await tx.query(
              `INSERT INTO rms_ordering.cart
 (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
 VALUES($1,$2,$3,'DineIn',$4,$5,$6,1,$7,$7,'Active',$8,$9,$10,$11,$12,$13) RETURNING cart_id`,
              [
                successor.cartReference,
                scope.brandReference,
                scope.storeReference,
                successor.sourceChannel,
                command.diningSessionReference,
                command.guestSessionReference,
                occurredAt,
                lifecycle.policyVersionReference,
                lifecycle.policyDigest,
                lifecycle.idleTimeoutSeconds,
                lifecycle.absoluteTimeoutSeconds,
                lifecycle.idleExpiresAt,
                lifecycle.absoluteExpiresAt,
              ],
            ),
          );
          if (
            inserted.length !== 1 ||
            readClosedRecord(inserted[0], ["cart_id"]).cart_id !== successor.cartReference
          )
            return unavailable();
          const expiresAt = new Date(Date.parse(occurredAt) + 86400000).toISOString();
          const association = rows(
            await tx.query(
              `INSERT INTO rms_ordering.dining_cart_replacement
 (brand_id,store_id,operation_id,dining_session_id,previous_cart_id,cart_id,previous_cart_version,guest_session_id,participant_id,intent_digest,occurred_at,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING operation_id`,
              [
                scope.brandReference,
                scope.storeReference,
                command.operationReference,
                command.diningSessionReference,
                command.previousCartReference,
                successor.cartReference,
                command.expectedCartVersion,
                command.guestSessionReference,
                command.participantReference,
                digest,
                occurredAt,
                expiresAt,
              ],
            ),
          );
          if (
            association.length !== 1 ||
            readClosedRecord(association[0], ["operation_id"]).operation_id !==
              command.operationReference
          )
            return unavailable();
          await appendAuditRecordInTransaction(tx, audit);
          if ((await authorizeAndFence(tx, command)) !== true) return unavailable();
          fresh();
          return Object.freeze({
            operationReference: command.operationReference,
            previousCartReference: command.previousCartReference,
            cartReference: successor.cartReference,
            occurredAt,
            expiresAt,
          });
        });
      } catch (error) {
        if (
          error instanceof CartError &&
          [
            "CART_REPLACEMENT_FORBIDDEN",
            "CART_IDEMPOTENCY_CONFLICT",
            "CART_VERSION_CONFLICT",
            "CART_LIFECYCLE_UNAVAILABLE",
            "CART_EXPIRED",
          ].includes(error.code)
        )
          throw error;
        return unavailable();
      }
    },
  });
}
