import type { ConsumerTransaction } from "@bop/eventing";
import type { TenantContext } from "@bop/tenant";
import {
  activeBrandMemberActors,
  listStoreMembers,
  MembershipContractError,
} from "@bop/membership";
import { brandActionHolders, type RoleAssignmentTransaction } from "@bop/permission";
import {
  createPostgresCurrentWorkforceMfaSource,
  createPostgresLatestWorkforceStepUpSource,
  resolveRecentWorkforceMfaAt,
} from "@bop/identity";
import {
  createPostgresSoleOperatorSettingSource,
  createSoleOperatorApprovalSource,
  holdBrandSingleStore,
  SoleOperatorApprovalError,
  type SoleOperatorSettingTransaction,
} from "@bop/tenant";
import { readStoreConfigurationSoleOperatorApproval } from "@rms/store";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";

export type ResolveContext = Parameters<
  typeof createMerchantWorkforcePermissionSource
>[0]["resolveContext"];
export interface StoreScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}

/**
 * WP-2423 Q19: every person who currently holds an approval permission at a Store. Candidates are
 * the Store's members (Membership owner read, a superset); each is evaluated by the Identity,
 * Membership and Permission owners exactly as an approval would be. A member whose membership or
 * Store assignment is not active is not a holder; any other failure to evaluate counts the person
 * as a holder (fail closed: the two-person rule then applies).
 */
export function createMerchantApprovalHolders(options: { resolveContext: ResolveContext }) {
  const permission = createMerchantWorkforcePermissionSource(options);
  return async (
    tx: ConsumerTransaction,
    query: StoreScope & { readonly permissionCode: string; readonly observedAt: string },
  ): Promise<readonly string[]> => {
    const members = await listStoreMembers(tx, {
      brandReference: query.brandReference,
      storeReference: query.storeReference,
    });
    const holders: string[] = [];
    for (const member of members) {
      if (member.membershipLifecycle !== "Active" || member.assignmentLifecycle !== "Active")
        continue;
      try {
        const result = await permission(tx, {
          tenantReference: query.tenantReference,
          brandReference: query.brandReference,
          storeReference: query.storeReference,
          actorReference: member.actorReference,
          observedAt: query.observedAt,
          permissionCode: query.permissionCode,
        });
        if (result.decision.effect === "Allow") holders.push(member.actorReference);
      } catch (error) {
        if (
          error instanceof MembershipContractError &&
          (error.code === "ACTIVE_MEMBERSHIP_NOT_FOUND" ||
            error.code === "ACTIVE_STORE_ASSIGNMENT_NOT_FOUND")
        )
          continue;
        holders.push(member.actorReference);
      }
    }
    return Object.freeze(holders);
  };
}

/**
 * WP-2423 Q19 step 2: every person who currently holds a Brand-level approval permission: the
 * Permission owner's Brand-level holders (roles without a Deny override, or an Allow override),
 * kept only while they hold an Active Brand Membership (Membership owner). A superset of who could
 * approve, so the waiver never applies while anyone else might.
 */
export async function merchantBrandApprovalHolders(
  tx: ConsumerTransaction,
  query: {
    readonly brandReference: string;
    readonly permissionCode: string;
    readonly observedAt: string;
  },
): Promise<readonly string[]> {
  const holders = await brandActionHolders(tx as unknown as RoleAssignmentTransaction, {
    brandReference: query.brandReference,
    action: query.permissionCode,
    at: query.observedAt,
  });
  return activeBrandMemberActors(tx as never, {
    brandReference: query.brandReference,
    actorReferences: holders,
    at: query.observedAt,
  });
}

/**
 * Organization public read `soleOperatorApproval`, composed with the holder reads above: a Store
 * gate (storeReference set) evaluates the Store's members and needs `resolveContext`; a Brand gate
 * (storeReference null) uses the Brand-level holder read. `authorize` must hold the caller's
 * current access to the Brand through the read.
 */
export function createMerchantSoleOperatorApproval(options: {
  resolveContext?: ResolveContext;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const storeHolders =
    options.resolveContext === undefined
      ? null
      : createMerchantApprovalHolders({ resolveContext: options.resolveContext });
  const source = createSoleOperatorApprovalSource({
    setting: createPostgresSoleOperatorSettingSource({
      authorize: async (tx) => options.authorize(tx as ConsumerTransaction),
    }),
    holders: async (tx, query) => {
      if (query.storeReference === null)
        return merchantBrandApprovalHolders(tx as ConsumerTransaction, query);
      if (storeHolders === null) throw new SoleOperatorApprovalError("SOLE_OPERATOR_UNAVAILABLE");
      return storeHolders(tx as ConsumerTransaction, {
        ...query,
        storeReference: query.storeReference,
      });
    },
  });
  return async (
    tx: ConsumerTransaction,
    query: Omit<StoreScope, "storeReference"> & {
      readonly storeReference: string | null;
      readonly permissionCode: string;
      readonly actorReference: string;
      readonly observedAt: string;
    },
  ) => source(tx as SoleOperatorSettingTransaction, query);
}

/** The actor's latest second-factor verification at the selected Store (Identity owner reads:
 * enrollment and step-ups), or null. `allowed` must hold the actor's current session. */
export async function merchantActorRecentMfaAt(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  actorReference: string,
  observedAt: string,
  allowed: () => Promise<boolean>,
): Promise<string | null> {
  const own = async (actor: string) => actor === actorReference && (await allowed());
  // No enrollment record (or a refusal) reads as "never verified": the gate then asks to verify.
  const mfa = await createPostgresCurrentWorkforceMfaSource({
    authorize: (_t, actor) => own(actor),
  })(tx, { actorReference, observedAt }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "WORKFORCE_MFA_SOURCE_DENIED")
      return { status: "Required" as const, verifiedAt: null, resetAt: null };
    throw error;
  });
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
export const soleOperatorMfaRecencyMilliseconds = 15 * 60 * 1000;
export function soleOperatorMfaRecent(mfaAt: string | null, at: string): boolean {
  if (mfaAt === null) return false;
  const age = Date.parse(at) - Date.parse(mfaAt);
  return age >= 0 && age <= soleOperatorMfaRecencyMilliseconds;
}

/** WP-2423 Q19: the signed-in actor's sole-operator status for refund approval at the selected
 * Store, for request admission and screens. Approval and sending recheck it themselves. */
export type MerchantRefundSoleOperatorResolver = (
  tx: ConsumerTransaction,
  query: StoreScope & { readonly actorReference: string; readonly observedAt: string },
  authority: { readonly context: TenantContext; authorize(): Promise<boolean> },
) => Promise<"Effective" | "NotSet" | "OtherApprovers">;
export function createMerchantRefundSoleOperatorResolver(
  resolveConfiguration: (
    tx: ConsumerTransaction,
    scope: StoreScope & { actorReference: string },
    authority: { readonly context: TenantContext; authorize(): Promise<boolean> },
  ) => Promise<{ readonly workforce: { readonly resolveContext: ResolveContext } }>,
): MerchantRefundSoleOperatorResolver {
  return async (tx, query, authority) => {
    const configuration = await resolveConfiguration(
      tx,
      {
        tenantReference: query.tenantReference,
        brandReference: query.brandReference,
        storeReference: query.storeReference,
        actorReference: query.actorReference,
      },
      authority,
    );
    return (
      await createMerchantSoleOperatorApproval({
        resolveContext: configuration.workforce.resolveContext,
        authorize: () => authority.authorize(),
      })(tx, { ...query, permissionCode: "payment.refund.approve" })
    ).status;
  };
}

/** WP-2423 Q19 step 2: why a Brand gate refused the author's own approval as sole operator. */
export class MerchantSoleOperatorGateError extends Error {
  constructor(
    readonly code: "NotInEffect" | "NeedsReverification",
    /** WP-2423: why it is not in effect — turned off, or someone else also holds the approval. */
    readonly reason?: "Off" | "OtherApprovers",
  ) {
    super("Sole operator approval was not accepted");
    this.name = "MerchantSoleOperatorGateError";
  }
}
/**
 * WP-2423 Q19 step 2: whether the signed-in actor may approve their own work alone at a Brand gate
 * now (Organization read in the caller's transaction), who else holds the gate's permission (by
 * the name the selected Store keeps, for the explanation) and their current second factor.
 */
export async function merchantBrandSoleOperatorGate(
  tx: ConsumerTransaction,
  input: {
    readonly tenantReference: string;
    readonly brandReference: string;
    /** The selected Store: step-ups are recorded there, and its names are shown. */
    readonly storeReference: string;
    readonly actorReference: string;
    readonly permissionCode: string;
    readonly observedAt: string;
    allowed(): Promise<boolean>;
  },
) {
  const decision = await createMerchantSoleOperatorApproval({ authorize: input.allowed })(tx, {
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    storeReference: null,
    permissionCode: input.permissionCode,
    actorReference: input.actorReference,
    observedAt: input.observedAt,
  });
  const actorMfaAt = await merchantActorRecentMfaAt(
    tx,
    { brandReference: input.brandReference, storeReference: input.storeReference },
    input.actorReference,
    input.observedAt,
    input.allowed,
  );
  const members =
    decision.otherHolderReferences.length === 0
      ? []
      : await listStoreMembers(tx, {
          brandReference: input.brandReference,
          storeReference: input.storeReference,
        });
  return Object.freeze({
    status: decision.status,
    otherApprovers: Object.freeze(
      decision.otherHolderReferences.map((actor) =>
        Object.freeze({
          displayName:
            members.find((member) => member.actorReference === actor)?.displayName ?? null,
        }),
      ),
    ),
    actorMfaAt,
    verifiedUntil:
      actorMfaAt !== null && soleOperatorMfaRecent(actorMfaAt, input.observedAt)
        ? new Date(Date.parse(actorMfaAt) + soleOperatorMfaRecencyMilliseconds).toISOString()
        : null,
  });
}
/** The same read for a command: throws unless in effect with a second factor ≤ 15 minutes old. */
export async function requireMerchantBrandSoleOperator(
  tx: ConsumerTransaction,
  input: Parameters<typeof merchantBrandSoleOperatorGate>[1],
): Promise<{ readonly actorMfaAt: string }> {
  const gate = await merchantBrandSoleOperatorGate(tx, input);
  if (gate.status !== "Effective")
    throw new MerchantSoleOperatorGateError(
      "NotInEffect",
      gate.status === "NotSet" ? "Off" : "OtherApprovers",
    );
  if (gate.actorMfaAt === null || !soleOperatorMfaRecent(gate.actorMfaAt, input.observedAt))
    throw new MerchantSoleOperatorGateError("NeedsReverification");
  return Object.freeze({ actorMfaAt: gate.actorMfaAt });
}

/**
 * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16): the same read for a Store gate
 * (Store configuration approval): the Store's members are evaluated with `resolveContext`, as an
 * approval would be; names are the Store's own. `allowed` must hold the caller's current access.
 */
export async function merchantStoreSoleOperatorGate(
  tx: ConsumerTransaction,
  input: StoreScope & {
    readonly actorReference: string;
    readonly permissionCode: string;
    readonly observedAt: string;
    readonly resolveContext: ResolveContext;
    allowed(): Promise<boolean>;
  },
) {
  const decision = await createMerchantSoleOperatorApproval({
    resolveContext: input.resolveContext,
    authorize: input.allowed,
  })(tx, {
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    permissionCode: input.permissionCode,
    actorReference: input.actorReference,
    observedAt: input.observedAt,
  });
  const actorMfaAt = await merchantActorRecentMfaAt(
    tx,
    { brandReference: input.brandReference, storeReference: input.storeReference },
    input.actorReference,
    input.observedAt,
    input.allowed,
  );
  const members =
    decision.otherHolderReferences.length === 0
      ? []
      : await listStoreMembers(tx, {
          brandReference: input.brandReference,
          storeReference: input.storeReference,
        });
  return Object.freeze({
    status: decision.status,
    otherApprovers: Object.freeze(
      decision.otherHolderReferences.map((actor) =>
        Object.freeze({
          displayName:
            members.find((member) => member.actorReference === actor)?.displayName ?? null,
        }),
      ),
    ),
    actorMfaAt,
    verifiedUntil:
      actorMfaAt !== null && soleOperatorMfaRecent(actorMfaAt, input.observedAt)
        ? new Date(Date.parse(actorMfaAt) + soleOperatorMfaRecencyMilliseconds).toISOString()
        : null,
  });
}
/** The Store gate for a command: throws unless in effect with a second factor ≤ 15 minutes old. */
export async function requireMerchantStoreSoleOperator(
  tx: ConsumerTransaction,
  input: Parameters<typeof merchantStoreSoleOperatorGate>[1],
): Promise<{ readonly actorMfaAt: string }> {
  const gate = await merchantStoreSoleOperatorGate(tx, input);
  if (gate.status !== "Effective")
    throw new MerchantSoleOperatorGateError(
      "NotInEffect",
      gate.status === "NotSet" ? "Off" : "OtherApprovers",
    );
  if (gate.actorMfaAt === null || !soleOperatorMfaRecent(gate.actorMfaAt, input.observedAt))
    throw new MerchantSoleOperatorGateError("NeedsReverification");
  return Object.freeze({ actorMfaAt: gate.actorMfaAt });
}

/**
 * WP-2423 (v15 2026-10-16): an approval given alone stands only if sole operator was On for the
 * Brand when it was given. A defect let the Owner approve their own hours change alone after
 * turning sole operator off; such an approval cannot be published (its author withdraws it and
 * sends it again).
 */
export class MerchantSoleOperatorBasisError extends Error {
  constructor() {
    super("An approval given alone while sole operator was off cannot be published");
    this.name = "MerchantSoleOperatorBasisError";
  }
}
/**
 * Before a Store configuration is published: when its approval was given alone (the Store's
 * sole-operator mark for it exists), the Brand's sole-operator setting in force at the marked
 * approval time must be On (Organization read in this transaction). `allowed` must hold the
 * caller's current access.
 */
export async function requireMerchantStoreConfigurationSoleOperatorBasis(
  tx: ConsumerTransaction,
  input: StoreScope & {
    readonly configurationReference: string;
    allowed(): Promise<boolean>;
  },
): Promise<void> {
  const mark = await readStoreConfigurationSoleOperatorApproval(tx as never, {
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    configurationReference: input.configurationReference,
  });
  if (mark === null) return;
  const setting = await createPostgresSoleOperatorSettingSource({
    authorize: async (_tx, query) =>
      query.brandReference === input.brandReference && (await input.allowed()),
  })(tx as unknown as SoleOperatorSettingTransaction, {
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    observedAt: mark.approvedAt,
  });
  if (setting.state !== "On") throw new MerchantSoleOperatorBasisError();
}

/** WP-2423 item 8 ⑥: why a single-store listing was refused. */
export class MerchantSingleStoreListingError extends Error {
  constructor(readonly code: "NotSingleStore" | "NotPermitted") {
    super("single-store listing " + code);
    this.name = "MerchantSingleStoreListingError";
  }
}

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7): may the actor list this
 * alone, with no review? Only an active Brand member who holds `permissionCode` (the Permission
 * and Membership owners' reads at `observedAt`), whose current access `allowed` still holds, at a
 * Brand that has exactly one store (not archived) — this one. The store check holds the Brand's
 * stores until the transaction ends, so a second store cannot be added before the listing commits.
 */
export async function requireMerchantBrandSingleStore(
  tx: ConsumerTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly permissionCode: string;
    readonly observedAt: string;
    allowed(): Promise<boolean>;
  },
): Promise<void> {
  if (!(await input.allowed())) throw new MerchantSingleStoreListingError("NotPermitted");
  const holders = await merchantBrandApprovalHolders(tx, input);
  // The Brand-level holder read leaves the transaction without a Store; the command's writes are
  // the selected Store's again.
  await (tx as { query(sql: string, values: unknown[]): Promise<unknown> }).query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [input.brandReference, input.storeReference],
  );
  if (!holders.includes(input.actorReference))
    throw new MerchantSingleStoreListingError("NotPermitted");
  if (
    !(await holdBrandSingleStore(
      tx as unknown as SoleOperatorSettingTransaction,
      input.brandReference,
      input.storeReference,
    ))
  )
    throw new MerchantSingleStoreListingError("NotSingleStore");
  if (!(await input.allowed())) throw new MerchantSingleStoreListingError("NotPermitted");
}
