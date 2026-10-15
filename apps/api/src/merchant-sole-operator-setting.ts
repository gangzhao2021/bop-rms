import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresCurrentWorkforceMfaSource,
  createPostgresLatestWorkforceStepUpSource,
  parseOpaqueUuidV7,
  readClosedRecord,
  resolveRecentWorkforceMfaAt,
} from "@bop/identity";
import { listStoreMembers } from "@bop/membership";
import {
  createPostgresSoleOperatorSettingSource,
  createPostgresSoleOperatorSettingStore,
  SoleOperatorApprovalError,
  soleOperatorSettingReasons,
} from "@bop/tenant";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  approvalDerivedReference,
  businessTransaction,
} from "./merchant-ordinary-refund-approval.js";
import {
  createMerchantApprovalHolders,
  type ResolveContext,
  type StoreScope,
} from "./merchant-sole-operator.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export class MerchantSoleOperatorError extends Error {
  constructor(
    /**
     * NotOwner: a current staff member of the selected Store who is not the Brand Owner (the read
     * answers "nothing to show"; a change is refused like Denied).
     */
    readonly code:
      "Denied" | "NotOwner" | "NeedsReverification" | "VersionConflict" | "NoChange" | "Invalid",
  ) {
    super("Sole operator setting was not changed");
    this.name = "MerchantSoleOperatorError";
  }
}
type Configuration = (
  tx: ConsumerTransaction,
  scope: StoreScope & { actorReference: string },
  authority: {
    readonly context: Awaited<ReturnType<ReturnType<typeof createMerchantStoreScope>>>["context"];
    authorize(): Promise<boolean>;
  },
) => Promise<{ workforce: { resolveContext: ResolveContext } }>;

/**
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): Brand settings section. Only a Brand Owner (Brand-scope
 * `organization.brand.manage`) reads the setting and its history and turns it on or off with a
 * reason, after re-verifying their second factor (at most 15 minutes old). The read also says
 * whether it is in effect for the Owner's refund approval at the selected Store, and if not, who
 * else holds refund approval there (by the name the Store keeps for them).
 */
export function createMerchantSoleOperator(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration: Configuration;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolveStore = createMerchantStoreScope(options.persistence);
  const resolveBrand = createMerchantBrandScope(options.persistence);
  const ref = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  type Transaction = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  async function owner(transaction: Transaction, sessionCookie: unknown, sessionReference: string) {
    const current = await resolveStore(
      transaction,
      sessionCookie,
      "merchant.access",
      sessionReference,
    );
    if (!(await current.allowed())) throw new MerchantSoleOperatorError("Denied");
    const brand = await resolveBrand(transaction, sessionCookie, sessionReference).catch(() => {
      throw new MerchantSoleOperatorError("Denied");
    });
    const isOwner = async () =>
      (await current.allowed()) &&
      (await brand.authorizeAction("organization.brand.manage"))?.effect === "Allow";
    // WP-2423: current staff of the Store who are not the Brand Owner are told so (NotOwner)
    // rather than refused, so the Approvals page shows them nothing without a refused request.
    if (!(await isOwner()))
      throw new MerchantSoleOperatorError((await current.allowed()) ? "NotOwner" : "Denied");
    const scope = {
      tenantReference: current.selected.tenantReference,
      brandReference: String(current.context.brand.brandReference),
      storeReference: String(current.store.storeReference),
    };
    const actorReference = String(current.actorReference);
    return { current, scope, actorReference, isOwner };
  }
  async function recentMfaAt(
    tx: ConsumerTransaction,
    scope: StoreScope,
    actorReference: string,
    observedAt: string,
    allowed: () => Promise<boolean>,
  ) {
    const own = async (actor: string) => actor === actorReference && (await allowed());
    const mfa = await createPostgresCurrentWorkforceMfaSource({
      authorize: (_t, actor) => own(actor),
    })(tx, { actorReference, observedAt });
    const latestStepUpAt = await createPostgresLatestWorkforceStepUpSource({
      authorize: (_t, query) => own(query.actorReference),
    })(tx, {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      actorReference,
      observedAt,
    });
    return resolveRecentWorkforceMfaAt({
      status: mfa.status,
      verifiedAt: mfa.verifiedAt,
      resetAt: mfa.resetAt,
      latestStepUpAt,
    });
  }
  const read = async (input: { sessionCookie: unknown }) =>
    options.persistence.transactions.run(async (transaction) => {
      // A read: the session is the one the cookie names (no CSRF on GET).
      const session = await resolveStore(transaction, input.sessionCookie, "merchant.access");
      const { current, scope, actorReference, isOwner } = await owner(
        transaction,
        input.sessionCookie,
        String(session.sessionReference),
      );
      const tx = businessTransaction(transaction);
      const observedAt = String(current.context.resolvedAt);
      const setting = await createPostgresSoleOperatorSettingSource({
        authorize: async (_t, query) =>
          query.brandReference === scope.brandReference && (await isOwner()),
      })(tx, {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        observedAt,
        historyLimit: 10,
      });
      const configuration = await options.resolveConfiguration(
        tx,
        { ...scope, actorReference },
        Object.freeze({ context: current.context, authorize: current.allowed }),
      );
      const holders = await createMerchantApprovalHolders(configuration.workforce)(tx, {
        ...scope,
        permissionCode: "payment.refund.approve",
        observedAt,
      });
      const members = await listStoreMembers(tx, scope);
      const nameOf = (actor: string) =>
        members.find((member) => member.actorReference === actor)?.displayName ?? null;
      const others = holders.filter((holder) => holder !== actorReference);
      const youHold = holders.includes(actorReference);
      const refundApproval =
        setting.state !== "On"
          ? "NotSet"
          : youHold && others.length === 0
            ? "Effective"
            : "OtherApprovers";
      const mfaAt = await recentMfaAt(tx, scope, actorReference, observedAt, isOwner);
      if (!(await isOwner())) throw new MerchantSoleOperatorError("Denied");
      return Object.freeze({
        observedAt,
        state: setting.state ?? "Off",
        version: setting.version,
        history: setting.history.map((entry) =>
          Object.freeze({
            version: entry.version,
            state: entry.state,
            reasonCode: entry.reasonCode,
            recordedAt: entry.recordedAt,
            changedByYou: entry.actorReference === actorReference,
            changedByName: nameOf(entry.actorReference),
          }),
        ),
        refundApproval: Object.freeze({
          status: refundApproval,
          youHoldApproval: youHold,
          otherApprovers: Object.freeze(
            others.map((other) => Object.freeze({ displayName: nameOf(other) })),
          ),
        }),
        verifiedUntil:
          mfaAt === null || Date.parse(mfaAt) + 15 * 60 * 1000 <= Date.parse(observedAt)
            ? null
            : new Date(Date.parse(mfaAt) + 15 * 60 * 1000).toISOString(),
        reasons: soleOperatorSettingReasons,
      });
    });
  const command = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "state",
      "reasonCode",
      "expectedVersion",
      "operationReference",
    ]);
    if (
      (raw.state !== "On" && raw.state !== "Off") ||
      typeof raw.expectedVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      raw.expectedVersion < 0
    )
      throw new MerchantSoleOperatorError("Invalid");
    const state = raw.state;
    const expectedVersion = raw.expectedVersion;
    const operationReference = ref(raw.operationReference);
    const allowedReasons: readonly string[] = soleOperatorSettingReasons[state];
    if (typeof raw.reasonCode !== "string" || !allowedReasons.includes(raw.reasonCode))
      throw new MerchantSoleOperatorError("Invalid");
    const reasonCode = raw.reasonCode;
    // Derived from the operation so a retry of the same change finds the same record.
    const settingReference = approvalDerivedReference(operationReference, "sole-operator-setting");
    const auditReference = approvalDerivedReference(operationReference, "sole-operator-audit");
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const { current, scope, actorReference, isOwner } = await owner(
          transaction,
          input.sessionCookie,
          authenticated.sessionReference,
        );
        const tx = businessTransaction(transaction);
        const observedAt = String(current.context.resolvedAt);
        const actorMfaAt = await recentMfaAt(tx, scope, actorReference, observedAt, isOwner);
        const result = await createPostgresSoleOperatorSettingStore({
          authorize: async (_t, query) =>
            query.tenantReference === scope.tenantReference &&
            query.brandReference === scope.brandReference &&
            query.actorReference === actorReference &&
            (await isOwner()),
          appendAudit: async (t, record) => {
            await appendAuditRecordInTransaction(
              t as ConsumerTransaction,
              validateAuditRecord({
                ...record,
                actor: { ...record.actor },
                beforeSummary: { ...record.beforeSummary },
                afterSummary: { ...record.afterSummary },
              }),
            );
          },
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        })(tx, {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          actorReference,
          settingReference,
          operationReference,
          auditReference,
          state,
          reasonCode,
          expectedVersion,
          actorMfaAt,
        });
        return Object.freeze({
          status: result.status,
          state: result.record.state,
          version: result.record.version,
          recordedAt: result.record.recordedAt,
        });
      });
    } catch (error) {
      // A change by anyone but the Brand Owner is a refusal.
      if (error instanceof MerchantSoleOperatorError && error.code === "NotOwner")
        throw new MerchantSoleOperatorError("Denied");
      if (error instanceof SoleOperatorApprovalError) {
        if (error.code === "SOLE_OPERATOR_NEEDS_REVERIFICATION")
          throw new MerchantSoleOperatorError("NeedsReverification");
        if (error.code === "SOLE_OPERATOR_VERSION_CONFLICT")
          throw new MerchantSoleOperatorError("VersionConflict");
        if (error.code === "SOLE_OPERATOR_NO_CHANGE")
          throw new MerchantSoleOperatorError("NoChange");
        if (error.code === "SOLE_OPERATOR_DENIED") throw new MerchantSoleOperatorError("Denied");
      }
      throw error;
    }
  };
  return Object.assign(command, { read });
}
