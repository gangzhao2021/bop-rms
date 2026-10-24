import assert from "node:assert/strict";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createMerchantOrdinaryRefundAuthority } from "../../../apps/api/src/merchant-ordinary-refund-authority.ts";
import { createMerchantOrdinaryRefundExecutor } from "../../../apps/api/src/merchant-ordinary-refund-executor.ts";

/** Actual membership/assignment/permission/MFA records. Identity and Tenant
 * association origins are synthetic; no real OIDC or MFA Provider is claimed. */
export async function seedOrdinaryRefundWorkforce({ client, scope, requester, approver, at }) {
  const id = (n) => "01909972-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const from = new Date(Date.parse(at) - 60000).toISOString(),
    until = new Date(Date.parse(at) + 3600000).toISOString();
  // This helper can also run after guest-only Pickup. Dining may already have
  // seeded the policy root; preserve it rather than assuming it exists.
  await client.query(
    "INSERT INTO bop_permission.policy_state (brand_id,snapshot_id,version,updated_at) VALUES ($1,$2,1,$3) ON CONFLICT (brand_id) DO NOTHING",
    [scope.brandReference, id(900), from],
  );
  const names = ["synthetic_refund_manager", "synthetic_refund_finance"];
  let permissionNumber = 500;
  for (const [i, actor] of [requester, approver].entries()) {
    const n = 1 + i * 10;
    await client.query(
      "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [id(n), actor, scope.brandReference, id(n + 1), from, until],
    );
    await client.query(
      "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(n + 2), id(n), actor, scope.brandReference, scope.storeReference, from, until],
    );
    await client.query(
      "INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [id(n + 3), scope.brandReference, scope.storeReference, names[i], from, until],
    );
    await client.query(
      "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
      [
        id(n + 4),
        id(n + 3),
        id(n),
        id(n + 2),
        actor,
        scope.brandReference,
        scope.storeReference,
        from,
        until,
      ],
    );
    for (const action of i === 0
      ? ["merchant.access", "payment.refund.request", "payment.refund.execute"]
      : ["merchant.access", "payment.refund.approve"]) {
      let permission = (
        await client.query(
          "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
          [action],
        )
      ).rows[0]?.permission_id;
      if (!permission) {
        permission = id(permissionNumber++);
        await client.query(
          "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
          [permission, action, from],
        );
      }
      await client.query(
        "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [
          id(permissionNumber++),
          id(n + 3),
          permission,
          scope.brandReference,
          scope.storeReference,
          from,
          until,
        ],
      );
    }
    await client.query(
      "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
      [actor, id(n + 5), at],
    );
  }
  const brand = createBrand({
    brandReference: scope.brandReference,
    code: "SYNTHETIC_REFUND",
    displayName: "Synthetic Refund Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: from,
    updatedAt: from,
  });
  const store = createStore({
    storeReference: scope.storeReference,
    brandReference: scope.brandReference,
    code: "SYNTHETIC_REFUND",
    displayName: "Synthetic Refund Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: from,
    updatedAt: from,
  });
  const options = {
    resolveContext: async (_tx, query) => {
      assert.equal(query.tenantReference, scope.tenantReference);
      assert.equal(query.brandReference, scope.brandReference);
      assert.equal(query.storeReference, scope.storeReference);
      assert.ok([requester, approver].includes(query.actorReference));
      const actor = createIdentityActor({
        actorType: "User",
        actorReference: query.actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: from,
        recentMfaAt: null,
      });
      return {
        tenantReference: scope.tenantReference,
        context: createTenantContext(actor, brand, store, query.observedAt),
      };
    },
    resolveRoleMapping: async () => ({ Manager: [names[0]], Owner: [], Finance: [names[1]] }),
  };
  return {
    options,
    authority: createMerchantOrdinaryRefundAuthority(options),
    executor: createMerchantOrdinaryRefundExecutor(options),
  };
}
