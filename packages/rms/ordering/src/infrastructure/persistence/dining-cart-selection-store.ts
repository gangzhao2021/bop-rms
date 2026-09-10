import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CartError, parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import {
  assertCartLifecycleActive,
  createActiveCartLifecycle,
} from "../../domain/cart-lifecycle.js";
import {
  decideInitialDiningCartSelection,
  parseDiningCartSelectionReceipt,
  type DiningCartSelectionReceipt,
  type DiningCartSelectionCommand,
} from "../../domain/dining-cart-selection.js";
import {
  createPostgresCartQueryStore,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";

export interface DiningCartSelectionStoreOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly sourceChannel: "Qr" | "Web";
  readonly policy: {
    readonly policyVersionReference: string;
    readonly policyDigest: string;
    readonly idleTimeoutSeconds: number;
    readonly absoluteTimeoutSeconds: number;
    readonly validFrom: string;
    readonly validUntil: string;
  };
  readonly generateReference: () => string;
  readonly now: () => unknown;
  readonly audit: (input: {
    readonly action: "Create" | "Select";
    readonly operationReference: string;
    readonly cartReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly occurredAt: string;
  }) => unknown;
}
export interface DiningCartSelectionStore {
  /** Trusted owner port: require current Identity/Dining authorization before every call/replay. */
  select(input: DiningCartSelectionCommand): Promise<DiningCartSelectionReceipt>;
}
const intentFields = [
  "operationReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "guestSessionReference",
  "participantReference",
] as const;
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function conflict(): never {
  throw new CartError("CART_IDEMPOTENCY_CONFLICT");
}
function rows(result: unknown): unknown[] {
  if (result === null || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return unavailable();
  return descriptor.value;
}
const selectOperation = `SELECT jsonb_build_object(
 'operationReference',operation_id,'brandReference',brand_id,'storeReference',store_id,
 'diningSessionReference',dining_session_id,'guestSessionReference',guest_session_id,
 'participantReference',participant_id,'action',action_code,'cartReference',cart_id,
 'cartVersion',cart_version,
 'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'expiresAt',to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS receipt
 FROM rms_ordering.dining_cart_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`;
const selectHistory = `SELECT cart_id AS "cartReference",aggregate_version AS "cartVersion"
 FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND dining_session_id=$3
 AND order_type='DineIn' AND source_channel IN ('Qr','Web')
 ORDER BY cart_id LIMIT 2 FOR SHARE`;

/** Owner-local transaction only; a stored receipt is historical, never a current membership lease. */
export function createPostgresDiningCartSelectionStore(
  runner: CartQueryTransactionRunner,
  options: DiningCartSelectionStoreOptions,
): DiningCartSelectionStore {
  let captured: DiningCartSelectionStoreOptions;
  try {
    const raw = readClosedRecord(options, [
      "scope",
      "sourceChannel",
      "policy",
      "generateReference",
      "now",
      "audit",
    ]);
    const scope = readClosedRecord(raw.scope, ["brandReference", "storeReference"]);
    const policy = readClosedRecord(raw.policy, [
      "policyVersionReference",
      "policyDigest",
      "idleTimeoutSeconds",
      "absoluteTimeoutSeconds",
      "validFrom",
      "validUntil",
    ]);
    const validFrom = parseOrderingInstant(policy.validFrom);
    const validUntil = parseOrderingInstant(policy.validUntil);
    const lifecycle = createActiveCartLifecycle({
      policyVersionReference: policy.policyVersionReference,
      policyDigest: policy.policyDigest,
      idleTimeoutSeconds: policy.idleTimeoutSeconds,
      absoluteTimeoutSeconds: policy.absoluteTimeoutSeconds,
      startedAt: validFrom,
    });
    if (
      validUntil <= validFrom ||
      (raw.sourceChannel !== "Qr" && raw.sourceChannel !== "Web") ||
      typeof raw.generateReference !== "function" ||
      typeof raw.now !== "function" ||
      typeof raw.audit !== "function"
    )
      throw new Error("configuration");
    captured = Object.freeze({
      scope: Object.freeze({
        brandReference: parseOrderingReference(scope.brandReference),
        storeReference: parseOrderingReference(scope.storeReference),
      }),
      sourceChannel: raw.sourceChannel,
      policy: Object.freeze({
        policyVersionReference: lifecycle.policyVersionReference,
        policyDigest: lifecycle.policyDigest,
        idleTimeoutSeconds: lifecycle.idleTimeoutSeconds,
        absoluteTimeoutSeconds: lifecycle.absoluteTimeoutSeconds,
        validFrom,
        validUntil,
      }),
      generateReference:
        raw.generateReference as DiningCartSelectionStoreOptions["generateReference"],
      now: raw.now as DiningCartSelectionStoreOptions["now"],
      audit: raw.audit as DiningCartSelectionStoreOptions["audit"],
    });
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
  const { brandReference: brand, storeReference: store } = captured.scope;
  return Object.freeze({
    async select(value: DiningCartSelectionCommand): Promise<DiningCartSelectionReceipt> {
      let command: DiningCartSelectionCommand;
      try {
        const raw = readClosedRecord(value, [...intentFields, "observedAt"]);
        command = Object.freeze({
          operationReference: parseOrderingReference(raw.operationReference),
          brandReference: parseOrderingReference(raw.brandReference),
          storeReference: parseOrderingReference(raw.storeReference),
          diningSessionReference: parseOrderingReference(raw.diningSessionReference),
          guestSessionReference: parseOrderingReference(raw.guestSessionReference),
          participantReference: parseOrderingReference(raw.participantReference),
          observedAt: parseOrderingInstant(raw.observedAt),
        });
        if (command.brandReference !== brand || command.storeReference !== store)
          throw new Error("scope");
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      let previous = command.observedAt;
      const tick = () => {
        const next = parseOrderingInstant(captured.now());
        if (next < previous) return unavailable();
        previous = next;
        return next;
      };
      try {
        tick();
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `ordering.dining-cart.operation:${brand}:${store}:${command.operationReference}`,
          ]);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `ordering.dining-cart.session:${brand}:${store}:${command.diningSessionReference}`,
          ]);
          const priorRows = rows(
            await tx.query(selectOperation, [brand, store, command.operationReference]),
          );
          if (priorRows.length > 1) return unavailable();
          if (priorRows.length === 1) {
            const prior = parseDiningCartSelectionReceipt(
              readClosedRecord(priorRows[0], ["receipt"]).receipt,
            );
            const at = tick();
            if (
              intentFields.some((key) => prior[key] !== command[key]) ||
              at < prior.occurredAt ||
              at >= prior.expiresAt
            )
              return conflict();
            return prior;
          }
          const headers = rows(
            await tx.query(selectHistory, [brand, store, command.diningSessionReference]),
          );
          if (headers.length > 1) return unavailable();
          const history = [];
          if (headers.length === 1) {
            const header = readClosedRecord(headers[0], ["cartReference", "cartVersion"]);
            const cartReference = parseOrderingReference(header.cartReference);
            const cart = await createPostgresCartQueryStore(
              { run: async (action) => action(tx) },
              captured.scope,
            ).load(cartReference);
            if (cart === null || cart.aggregateVersion !== header.cartVersion) return unavailable();
            history.push(cart);
          }
          const creation =
            history.length === 0
              ? {
                  cartReference: parseOrderingReference(captured.generateReference()),
                  sourceChannel: captured.sourceChannel,
                  policy: captured.policy,
                }
              : null;
          const occurredAt = tick();
          const decision = decideInitialDiningCartSelection({
            brandReference: brand,
            storeReference: store,
            diningSessionReference: command.diningSessionReference,
            guestSessionReference: command.guestSessionReference,
            participantReference: command.participantReference,
            observedAt: occurredAt,
            history,
            creation,
          });
          const receipt = parseDiningCartSelectionReceipt({
            operationReference: command.operationReference,
            brandReference: brand,
            storeReference: store,
            diningSessionReference: command.diningSessionReference,
            guestSessionReference: command.guestSessionReference,
            participantReference: command.participantReference,
            action: decision.action,
            cartReference: decision.cart.cartReference,
            cartVersion: decision.cart.aggregateVersion,
            occurredAt,
            expiresAt: new Date(Date.parse(occurredAt) + 86_400_000).toISOString(),
          });
          const rawAudit = readClosedRecord(
            captured.audit(
              Object.freeze({
                action: receipt.action,
                operationReference: receipt.operationReference,
                cartReference: receipt.cartReference,
                brandReference: brand,
                storeReference: store,
                occurredAt,
              }),
            ),
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
          if (
            actor.type !== "System" ||
            Object.entries(rawAudit).some(
              ([key, value]) =>
                key !== "actor" && key !== "retentionPolicyVersion" && typeof value !== "string",
            )
          )
            return unavailable();
          const audit = validateAuditRecord(
            Object.freeze({ ...rawAudit, actor: Object.freeze({ type: "System" as const }) }),
            Date.parse(occurredAt),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== store ||
            audit.actor.type !== "System" ||
            audit.actionCode !== `ORDERING_DINING_CART_${receipt.action.toUpperCase()}` ||
            audit.targetType !== "OrderingCart" ||
            audit.targetId !== receipt.cartReference ||
            audit.reasonCode !== "AUTHORIZED_CART_SELECTION" ||
            audit.correlationId !== receipt.operationReference ||
            audit.occurredAt !== occurredAt ||
            audit.sourceChannel !== "CUSTOMER_PWA" ||
            audit.dataClassification !== "Restricted" ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined ||
            audit.deviceNetworkReference !== undefined
          )
            return unavailable();
          const stillCurrent = () => {
            const at = tick();
            assertCartLifecycleActive(decision.cart.lifecycle, at);
            if (
              receipt.action === "Create" &&
              (at < captured.policy.validFrom || at >= captured.policy.validUntil)
            )
              throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
          };
          stillCurrent();
          if (receipt.action === "Create") {
            const lifecycle = decision.cart.lifecycle;
            if (lifecycle === null) return unavailable();
            const inserted = rows(
              await tx.query(
                `INSERT INTO rms_ordering.cart
              (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,
              lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
              VALUES($1,$2,$3,'DineIn',$4,$5,$6,1,$7,$7,'Active',$8,$9,$10,$11,$12,$13) RETURNING cart_id`,
                [
                  receipt.cartReference,
                  brand,
                  store,
                  captured.sourceChannel,
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
              readClosedRecord(inserted[0], ["cart_id"]).cart_id !== receipt.cartReference
            )
              return unavailable();
          }
          const inserted = rows(
            await tx.query(
              `INSERT INTO rms_ordering.dining_cart_operation
            (brand_id,store_id,operation_id,dining_session_id,guest_session_id,participant_id,action_code,cart_id,cart_version,occurred_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING operation_id`,
              [
                brand,
                store,
                receipt.operationReference,
                receipt.diningSessionReference,
                receipt.guestSessionReference,
                receipt.participantReference,
                receipt.action,
                receipt.cartReference,
                receipt.cartVersion,
                receipt.occurredAt,
                receipt.expiresAt,
              ],
            ),
          );
          if (
            inserted.length !== 1 ||
            readClosedRecord(inserted[0], ["operation_id"]).operation_id !==
              receipt.operationReference
          )
            return unavailable();
          await appendAuditRecordInTransaction(tx, audit);
          stillCurrent();
          return receipt;
        });
      } catch (error) {
        if (
          error instanceof CartError &&
          [
            "CART_IDEMPOTENCY_CONFLICT",
            "CART_EXPIRED",
            "CART_ABANDONED",
            "CART_LIFECYCLE_UNAVAILABLE",
          ].includes(error.code)
        )
          throw error;
        return unavailable();
      }
    },
  });
}

export type { DiningCartSelectionCommand } from "../../domain/dining-cart-selection.js";
