import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPickupHandoffStore,
  parsePickupProofReference,
  PickupHandoffError,
  completePickupHandoffPermission,
  pickupCodeNotShownCauses,
} from "@rms/fulfillment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type StoreOptions = Parameters<typeof createPostgresPickupHandoffStore>[0];
function invalid(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}
/** Browser supplies intent only; current staff authority and saved proof stay server-owned. */
export function createMerchantPickupHandoff(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  store: Pick<
    StoreOptions,
    "deriveCompletionReference" | "sha256" | "validateCurrentSource" | "admit" | "appendAudit"
  >;
  installContext(
    transaction: ConsumerTransaction,
    scope: { brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    // WP-2423: staff verified the customer in person (proof expired, never issued, code checks
    // locked after five wrong codes, or a valid code the customer cannot show) instead of a
    // proof verification: the browser names only which identity check was made (and why the code
    // was not shown); the reason is decided here from the proof state.
    const inPerson =
      input.command !== null &&
      typeof input.command === "object" &&
      Object.prototype.hasOwnProperty.call(input.command, "identityCheck");
    // WP-2423: staff chose "Guest can't show the code" while the code is still valid, and named
    // why; the owner checks again under the lock that the code is still valid and unlocked.
    const codeNotShown =
      inPerson &&
      Object.prototype.hasOwnProperty.call(input.command as object, "codeNotShownCause");
    let intent: Readonly<Record<string, unknown>>;
    try {
      intent = readClosedRecord(input.command, [
        "orderReference",
        "storeReference",
        "fulfillmentReference",
        "expectedAggregateVersion",
        inPerson ? "identityCheck" : "verificationReference",
        ...(codeNotShown ? ["codeNotShownCause"] : []),
        "recipientType",
        "recipientDisplayMask",
        "pickupLocationReference",
        "deviceReference",
        "quantities",
        "idempotencyReference",
        "correlationReference",
      ]);
    } catch {
      return invalid();
    }
    const orderReference = parsePickupProofReference(intent.orderReference);
    const idempotencyReference = parsePickupProofReference(intent.idempotencyReference);
    const verificationReference = inPerson
      ? null
      : parsePickupProofReference(intent.verificationReference);
    if (
      inPerson &&
      intent.identityCheck !== "OrderNumberAndName" &&
      intent.identityCheck !== "OrderNumberAndPhoneLast4"
    )
      return invalid();
    const codeNotShownCause = codeNotShown
      ? pickupCodeNotShownCauses.find((cause) => cause === intent.codeNotShownCause)
      : undefined;
    if (codeNotShown && codeNotShownCause === undefined) return invalid();
    if (
      typeof intent.expectedAggregateVersion !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(intent.expectedAggregateVersion) ||
      BigInt(intent.expectedAggregateVersion) > 9223372036854775807n
    )
      return invalid();
    const expectedAggregateVersion = BigInt(intent.expectedAggregateVersion);
    const denied = (): never => {
      throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
    };
    // WP-2423: one authorized run. The caller and `fulfillment.pickup.complete` are resolved in
    // full once at the start and once more before the commit (inside this transaction, so a
    // withdrawn permission or ended Session never commits); the owner store's authorize callback,
    // which runs while the order is locked, takes the run's no-query guard.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolveScope(
              transaction,
              input.sessionCookie,
              completePickupHandoffPermission,
              session.sessionReference,
            );
            if (
              intent.storeReference !== resolved.store.storeReference ||
              (await resolved.allowed()) !== true
            )
              return denied();
            return resolved;
          },
          recheck: async (scope) => (await scope.allowed()) === true,
          denied,
        },
        async (authority) => {
          const scope = authority.scope;
          const tx: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await transaction.query(sql, values);
              if (!result || typeof result !== "object") return invalid();
              const rows = Object.getOwnPropertyDescriptor(result, "rows"),
                count = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (
                !rows ||
                !("value" in rows) ||
                !Array.isArray(rows.value) ||
                !count ||
                !("value" in count) ||
                (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
              )
                return invalid();
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };
          const selected = {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
          };
          authority.bind(tx);
          await options.installContext(tx, selected);
          const store = createPostgresPickupHandoffStore({
            ...options.store,
            ...selected,
            actorReference: scope.actorReference,
            now: options.persistence.now,
            authorize: async (ownerTransaction, access) =>
              access.actorReference === scope.actorReference &&
              access.orderReference === orderReference &&
              access.permission === completePickupHandoffPermission &&
              (await authority.guard(ownerTransaction)),
          });
          const current = await store.lockByOrder({ transaction: tx, orderReference });
          const prior = await store.resolveByIdempotency({
            transaction: tx,
            orderReference,
            idempotencyReference,
          });
          const correlationReference = parsePickupProofReference(intent.correlationReference);
          const recorded = inPerson
            ? current.inPerson.find(
                (value) => value.verificationReference === prior?.record.verificationReference,
              )
            : undefined;
          // A replay must repeat what staff chose: the same identity check and the same cause.
          if (
            recorded &&
            (recorded.identityCheck !== intent.identityCheck ||
              recorded.codeNotShownCause !== codeNotShownCause)
          )
            throw new PickupHandoffError("PICKUP_HANDOFF_VERSION_CONFLICT");
          const verification = inPerson
            ? // A replay reuses the recorded verification; a new one names this staff member and the
              // proof state the owner checks again (never issued, expired by now, locked, or still
              // valid while the customer cannot show it).
              (recorded ?? {
                verificationReference: options.nextReference(),
                correlationReference,
                fulfillmentReference: intent.fulfillmentReference,
                ...selected,
                verificationMethod: "InPerson" as const,
                identityCheck: intent.identityCheck,
                reason: codeNotShownCause
                  ? "CodeNotShown"
                  : current.capability === null
                    ? "ProofNotIssued"
                    : String(current.source.lockedAt) < String(current.capability.expiresAt) &&
                        current.codeChecksLocked
                      ? "CodeLocked"
                      : "ProofExpired",
                ...(codeNotShownCause ? { codeNotShownCause } : {}),
                verifiedByActorReference: scope.actorReference,
                verifiedAt: options.persistence.now(),
              })
            : current.verifications.find(
                (value) => value.verificationReference === verificationReference,
              );
          if (!verification) throw new PickupHandoffError("PICKUP_HANDOFF_VERIFICATION_FAILED");
          const result = await store.complete({
            transaction: tx,
            orderReference,
            command: {
              fulfillmentReference: intent.fulfillmentReference,
              ...selected,
              expectedAggregateVersion,
              purpose: "CompletePickupHandoff",
              actorReference: scope.actorReference,
              actorPermissions: [completePickupHandoffPermission],
              verification,
              recipientType: intent.recipientType,
              recipientDisplayMask: intent.recipientDisplayMask,
              pickupLocationReference: intent.pickupLocationReference,
              deviceReference: intent.deviceReference,
              quantities: intent.quantities,
              idempotencyReference,
              correlationReference,
              handoffReference: prior?.record.handoffReference ?? options.nextReference(),
              operationReference: prior?.operation.operationReference ?? options.nextReference(),
              auditReference: prior?.audit.auditReference ?? options.nextReference(),
              handedOverAt: prior?.record.handedOverAt ?? options.persistence.now(),
            },
          });
          return Object.freeze({
            status: result.status,
            handoffReference: result.effect.record.handoffReference,
            fulfillmentReference: result.effect.record.fulfillmentReference,
            nextAggregateVersion: result.effect.nextAggregateVersion.toString(),
            nextPhase: result.effect.nextPhase,
          });
        },
      ),
    );
  };
}
