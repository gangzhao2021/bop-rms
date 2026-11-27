import { createMerchantOrdinaryRefundExecutor } from "../../../apps/api/src/merchant-ordinary-refund-executor.ts";
import { createMerchantOrdinaryRefundAuthority } from "../../../apps/api/src/merchant-ordinary-refund-authority.ts";
import assert from "node:assert/strict";
import { createMerchantWorkforceAuthoritySource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

export async function verifyWorkforceAuthorityComposition({ admin, client, role }) {
  await admin.query(
    "INSERT INTO bop_permission.permission_definition VALUES ($1,'merchant.access','Active',1,$2,$2) ON CONFLICT DO NOTHING",
    [f.uuid("201"), f.FROM],
  );
  const access = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='merchant.access'",
    )
  ).rows[0];
  assert.ok(access);
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6) ON CONFLICT DO NOTHING",
    [f.uuid("202"), f.STORE_ROLE, access.permission_id, f.BRAND, f.STORE, f.FROM, f.UNTIL],
  );
  await admin.query(
    "INSERT INTO bop_identity.workforce_mfa_status VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
    [f.ACTOR, f.uuid("203"), f.AT],
  );
  await admin.query("GRANT SELECT,UPDATE(version) ON bop_identity.workforce_mfa_status TO " + role);
  // Only Identity/Tenant origin is synthetic here; all three owner readers use SQL.
  const source = createMerchantWorkforceAuthoritySource({
    resolveContext: async () => ({ tenantReference: f.uuid("200"), context: f.tenantContext }),
  });
  const query = {
    tenantReference: f.uuid("200"),
    brandReference: f.BRAND,
    storeReference: f.STORE,
    actorReference: f.ACTOR,
    observedAt: f.AT,
    permissionCode: f.ACTION,
  };
  const read = async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE " + role);
      const result = await source(client, query);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  const refundAuthority = createMerchantOrdinaryRefundAuthority({
    resolveContext: async () => ({ tenantReference: f.uuid("200"), context: f.tenantContext }),
    resolveRoleMapping: async () => ({
      Manager: [],
      Owner: [],
      Finance: ["synthetic_operator"],
    }),
  });
  const readRefund = async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE " + role);
      const result = await refundAuthority(client, {
        ...query,
        orderReference: f.uuid("204"),
        permissionCode: "payment.refund.approve",
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  await admin.query(
    "UPDATE bop_permission.permission_definition SET action_code='payment.refund.approve' WHERE permission_id=$1",
    [f.PERMISSION],
  );
  const refundAllowed = await readRefund();
  assert.equal(refundAllowed.role, "Finance");
  assert.equal(refundAllowed.allowed, true);
  assert.equal(refundAllowed.recentMfaAt, f.AT);
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
    [f.STORE_GRANT],
  );
  assert.equal((await readRefund()).allowed, false);
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
    [f.STORE_GRANT],
  );
  await admin.query(
    "UPDATE bop_permission.permission_definition SET action_code=$1 WHERE permission_id=$2",
    [f.ACTION, f.PERMISSION],
  );
  const executor = createMerchantOrdinaryRefundExecutor({
    resolveContext: async () => ({ tenantReference: f.uuid("200"), context: f.tenantContext }),
  });
  const executeRead = async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE " + role);
      const executorQuery = { ...query };
      delete executorQuery.permissionCode;
      const result = await executor(client, { ...executorQuery, orderReference: f.uuid("204") });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  assert.equal((await executeRead()).allowed, false);
  await admin.query(
    "UPDATE bop_permission.permission_definition SET action_code='payment.refund.execute' WHERE permission_id=$1",
    [f.PERMISSION],
  );
  await admin.query("REVOKE SELECT ON bop_identity.workforce_mfa_status FROM " + role);
  assert.equal((await executeRead()).allowed, true);
  await admin.query("GRANT SELECT ON bop_identity.workforce_mfa_status TO " + role);
  await admin.query(
    "UPDATE bop_permission.permission_definition SET action_code=$1 WHERE permission_id=$2",
    [f.ACTION, f.PERMISSION],
  );
  const allowed = await read();
  assert.equal(allowed.decision.effect, "Allow");
  assert.deepEqual(allowed.activeRoleCodes, ["synthetic_operator"]);
  assert.equal(allowed.mfa.verifiedAt, f.AT);
  assert.equal(allowed.mfa.actorReference, f.ACTOR);
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
    [f.STORE_GRANT],
  );
  const denied = await read();
  assert.equal(denied.decision.effect, "Deny");
  assert.deepEqual(denied.activeRoleCodes, ["synthetic_operator"]);
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
    [f.STORE_GRANT],
  );
  await admin.query(
    "UPDATE bop_membership.membership SET lifecycle='Suspended',version=version+1 WHERE membership_id=$1",
    [f.MEMBERSHIP],
  );
  await assert.rejects(read());
  await admin.query(
    "UPDATE bop_membership.membership SET lifecycle='Active',version=version+1 WHERE membership_id=$1",
    [f.MEMBERSHIP],
  );
}
