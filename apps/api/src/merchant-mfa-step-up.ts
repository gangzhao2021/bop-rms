import {
  createPostgresCurrentWorkforceMfaSource,
  createPostgresLatestWorkforceStepUpSource,
  resolveRecentWorkforceMfaAt,
  workforceStepUpRecencyMilliseconds,
  createPostgresWorkforceMfaStepUpStore,
  parseOpaqueUuidV7,
  readClosedRecord,
  WorkforceStepUpError,
  type WorkforceStepUpMethod,
} from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Why the step-up is made; recorded as evidence, never a grant by itself. */
const purposes = {
  RefundRequest: "PAYMENT_REFUND_REQUEST",
  RefundApproval: "PAYMENT_REFUND_APPROVAL",
  // WP-2423 Q19: turning the Brand's sole-operator setting on or off.
  SoleOperatorSetting: "ORGANIZATION_SOLE_OPERATOR_SETTING",
  // WP-2423 Q19 step 2: approving one's own work alone at a Brand gate (sole operator).
  SoleOperatorApproval: "ORGANIZATION_SOLE_OPERATOR_APPROVAL",
  // WP-2423 Q18 option A: a staff member signed in with a PIN confirms it is them before a
  // sensitive action (refunds, price, staff and role changes, tablets and PINs).
  PinSessionElevation: "IDENTITY_PIN_SESSION_ELEVATION",
} as const;
/** The recorded purpose code of a step-up purpose the merchant screens ask for, or null. */
export function merchantStepUpPurposeCode(purpose: unknown): string | null {
  return typeof purpose === "string" && Object.hasOwn(purposes, purpose)
    ? purposes[purpose as keyof typeof purposes]
    : null;
}
export class MerchantStepUpError extends Error {
  constructor(readonly code: "Denied" | "NotSetUp") {
    super("Verification could not be recorded");
    this.name = "MerchantStepUpError";
  }
}
const denied = (): never => {
  throw new MerchantStepUpError("Denied");
};

/**
 * WP-2423 Q5: the signed-in staff member re-verifies their second factor at the selected Store.
 * Only the current session's own actor can verify; the code goes to the verifier port only. A
 * rejected or locked attempt still commits (it bounds further tries) and is reported, not thrown.
 */
export function createMerchantMfaStepUp(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  method: WorkforceStepUpMethod;
  verify: Parameters<typeof createPostgresWorkforceMfaStepUpStore>[0]["verify"];
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const record = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, ["purpose", "code"]);
    if (
      raw.purpose !== "RefundRequest" &&
      raw.purpose !== "RefundApproval" &&
      raw.purpose !== "SoleOperatorSetting" &&
      raw.purpose !== "SoleOperatorApproval" &&
      raw.purpose !== "PinSessionElevation"
    )
      throw new MerchantStepUpError("Denied");
    const purposeCode = purposes[raw.purpose];
    const stepUpReference = String(
      parseOpaqueUuidV7(options.newReference(), "ACTOR_REFERENCE_INVALID"),
    );
    const auditReference = String(
      parseOpaqueUuidV7(options.newReference(), "ACTOR_REFERENCE_INVALID"),
    );
    try {
      // WP-2423: one authorized run. The caller is resolved in full once at the start and once
      // more before the commit (inside this transaction, so a step-up by a Session that ended
      // meanwhile never commits — the property the owner store's closing authorize check was
      // asking for); the owner store's checks in between, taken while the actor's advisory lock
      // is held, use the run's no-query guard. The second factor itself is still verified fresh
      // by the verifier port on every attempt.
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const resolved = await resolve(
                tx,
                input.sessionCookie,
                "merchant.access",
                authenticated.sessionReference,
              );
              if ((await resolved.allowed()) !== true) return denied();
              return resolved;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied,
          },
          async (authority) => {
            const current = authority.scope;
            const binding = {
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
              actorReference: String(current.actorReference),
              sessionReference: String(current.sessionReference),
            };
            const record = createPostgresWorkforceMfaStepUpStore({
              method: options.method,
              verify: options.verify,
              authorize: async (ownerTransaction, query) =>
                query.brandReference === binding.brandReference &&
                query.storeReference === binding.storeReference &&
                query.actorReference === binding.actorReference &&
                query.sessionReference === binding.sessionReference &&
                (await authority.guard(ownerTransaction)),
              retentionPolicyCode: options.retentionPolicyCode,
              retentionPolicyVersion: options.retentionPolicyVersion,
            });
            return record(tx, {
              ...binding,
              stepUpReference,
              auditReference,
              purposeCode,
              code: raw.code,
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantStepUpError) throw error;
      if (error instanceof WorkforceStepUpError && error.code === "WORKFORCE_STEP_UP_UNAVAILABLE")
        throw new MerchantStepUpError("NotSetUp");
      throw new MerchantStepUpError("Denied");
    }
  };
  return Object.assign(record, { status: createMerchantStepUpStatus(options.persistence) });
}

/** The signed-in member's current verification at this Store: the same Identity recency
 * (enrollment or latest step-up) refund approval uses. validUntil null: verify again.
 * WP-2423 DEC-COGNITO-STORE-STAFF: shared by the authenticator-code and the sign-in step-up. */
export function createMerchantStepUpStatus(persistence: PersistentMerchantBffOptions) {
  const options = { persistence };
  const resolve = createMerchantStoreScope(persistence);
  return async (input: { sessionCookie: unknown }) =>
    // WP-2423: resolved in full at the start and before the reply; the two owner reads take the
    // run's no-query guard.
    options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const resolved = await resolve(tx, input.sessionCookie, "merchant.access");
            if ((await resolved.allowed()) !== true) return denied();
            return resolved;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const current = authority.scope;
          const actorReference = String(current.actorReference);
          const brandReference = String(current.context.brand.brandReference);
          const storeReference = String(current.store.storeReference);
          const observedAt = String(current.context.resolvedAt);
          const own = async (ownerTransaction: unknown, actor: string) =>
            actor === actorReference && (await authority.guard(ownerTransaction));
          const mfa = await createPostgresCurrentWorkforceMfaSource({
            authorize: (t, actor) => own(t, actor),
          })(tx, { actorReference, observedAt });
          const latestStepUpAt = await createPostgresLatestWorkforceStepUpSource({
            authorize: (t, query) => own(t, query.actorReference),
          })(tx, { brandReference, storeReference, actorReference, observedAt });
          const recent = resolveRecentWorkforceMfaAt({
            status: mfa.status,
            verifiedAt: mfa.verifiedAt,
            resetAt: mfa.resetAt,
            latestStepUpAt,
          });
          const until =
            recent === null ? null : Date.parse(recent) + workforceStepUpRecencyMilliseconds;
          return Object.freeze({
            observedAt,
            validUntil:
              until !== null && until > Date.parse(observedAt)
                ? new Date(until).toISOString()
                : null,
          });
        },
      ),
    );
}
