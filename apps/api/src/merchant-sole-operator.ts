import type { ConsumerTransaction } from "@bop/eventing";
import type { TenantContext } from "@bop/tenant";
import { listStoreMembers, MembershipContractError } from "@bop/membership";
import {
  createPostgresSoleOperatorSettingSource,
  createSoleOperatorApprovalSource,
  SoleOperatorApprovalError,
  type SoleOperatorSettingTransaction,
} from "@bop/tenant";
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
 * Organization public read `soleOperatorApproval` for a Store gate, composed with the holder read
 * above. `authorize` must hold the caller's current access to the Brand through the read.
 */
export function createMerchantSoleOperatorApproval(options: {
  resolveContext: ResolveContext;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const holders = createMerchantApprovalHolders(options);
  const source = createSoleOperatorApprovalSource({
    setting: createPostgresSoleOperatorSettingSource({
      authorize: async (tx) => options.authorize(tx as ConsumerTransaction),
    }),
    holders: async (tx, query) => {
      if (query.storeReference === null)
        throw new SoleOperatorApprovalError("SOLE_OPERATOR_UNAVAILABLE");
      return holders(tx as ConsumerTransaction, { ...query, storeReference: query.storeReference });
    },
  });
  return async (
    tx: ConsumerTransaction,
    query: StoreScope & {
      readonly permissionCode: string;
      readonly actorReference: string;
      readonly observedAt: string;
    },
  ) => source(tx as SoleOperatorSettingTransaction, query);
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
