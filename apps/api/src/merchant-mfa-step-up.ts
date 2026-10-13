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
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Why the step-up is made; recorded as evidence, never a grant by itself. */
const purposes = {
  RefundRequest: "PAYMENT_REFUND_REQUEST",
  RefundApproval: "PAYMENT_REFUND_APPROVAL",
  // WP-2423 Q19: turning the Brand's sole-operator setting on or off.
  SoleOperatorSetting: "ORGANIZATION_SOLE_OPERATOR_SETTING",
} as const;
export class MerchantStepUpError extends Error {
  constructor(readonly code: "Denied" | "NotSetUp") {
    super("Verification could not be recorded");
    this.name = "MerchantStepUpError";
  }
}

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
      raw.purpose !== "SoleOperatorSetting"
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
      return await options.persistence.transactions.run(async (tx) => {
        const current = await resolve(
          tx,
          input.sessionCookie,
          "merchant.access",
          authenticated.sessionReference,
        );
        if (!(await current.allowed())) throw new MerchantStepUpError("Denied");
        const binding = {
          brandReference: String(current.context.brand.brandReference),
          storeReference: String(current.store.storeReference),
          actorReference: String(current.actorReference),
          sessionReference: String(current.sessionReference),
        };
        const record = createPostgresWorkforceMfaStepUpStore({
          method: options.method,
          verify: options.verify,
          authorize: async (_tx, query) =>
            query.brandReference === binding.brandReference &&
            query.storeReference === binding.storeReference &&
            query.actorReference === binding.actorReference &&
            query.sessionReference === binding.sessionReference &&
            (await current.allowed()),
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
      });
    } catch (error) {
      if (error instanceof MerchantStepUpError) throw error;
      if (error instanceof WorkforceStepUpError && error.code === "WORKFORCE_STEP_UP_UNAVAILABLE")
        throw new MerchantStepUpError("NotSetUp");
      throw new MerchantStepUpError("Denied");
    }
  };
  /** The signed-in member's current verification at this Store: the same Identity recency
   * (enrollment or latest step-up) refund approval uses. validUntil null: verify again. */
  const status = async (input: { sessionCookie: unknown }) =>
    options.persistence.transactions.run(async (tx) => {
      const current = await resolve(tx, input.sessionCookie, "merchant.access");
      if (!(await current.allowed())) throw new MerchantStepUpError("Denied");
      const actorReference = String(current.actorReference);
      const brandReference = String(current.context.brand.brandReference);
      const storeReference = String(current.store.storeReference);
      const observedAt = String(current.context.resolvedAt);
      const own = async (_tx: unknown, actor: string) =>
        actor === actorReference && (await current.allowed());
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
          until !== null && until > Date.parse(observedAt) ? new Date(until).toISOString() : null,
      });
    });
  return Object.assign(record, { status });
}
