import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  buildStoreRoleProvisioningPlan,
  permissionCatalogDigest,
  provisionStoreRoles,
  storePermissionCatalogVersion,
  storeRoleProvisioningPlanDigest,
  storeRoleProvisioningSigningBytes,
  storeRoleTemplateActions,
  synchronizePermissionCatalog,
} from "../../bop/permission/src/index.ts";
import { confirmStoreOpeningScope } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01909a07-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** WP-2423 / DEC-PERM-CATALOG: signed Store opening provisioning of the template System roles. */
it("provisions a Store's template System roles once under an independent signed approval", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_store_roles" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_roles_" + context.runId;
    let sequence = 1000;
    const next = () => id(++sequence);
    const tenant = id(1),
      brand = id(2),
      store = id(3),
      operator = id(4),
      approver = id(5),
      environment = id(6);
    try {
      const at = "2026-10-07T10:00:00.000Z";
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'PILOT_BRAND','Pilot Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, at],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'PILOT_STORE','Pilot Store','America/Toronto','en-CA','CAD','Draft',1,$3,$3)",
        [store, brand, at],
      );
      await admin.query("BEGIN");
      await synchronizePermissionCatalog(admin, {
        operationReference: id(10),
        operatorReference: operator,
        approvedByReference: approver,
        approvalEvidenceReference: id(11),
        auditReference: id(12),
        occurredAt: at,
        nextPermissionReference: next,
      });
      await admin.query("COMMIT");

      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [
        "GRANT USAGE ON SCHEMA bop_permission,bop_tenant,platform_audit,platform_helpers TO ROLE_",
        "GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ROLE_",
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ROLE_",
        "GRANT SELECT ON bop_tenant.store,bop_permission.permission_catalog_revision TO ROLE_",
        "GRANT SELECT,INSERT ON bop_permission.store_role_provisioning,bop_permission.role_administration_version,bop_permission.role_administration_permission,bop_permission.role_administration_decision,platform_audit.audit_record,platform_audit.platform_actor_audit_record TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON bop_permission.policy_state,bop_permission.role,bop_permission.permission_grant,bop_permission.permission_definition,bop_permission.role_assignment,bop_permission.permission_override,platform_audit.audit_chain_head,platform_audit.platform_actor_audit_chain_head TO ROLE_",
      ])
        await admin.query(sql.replace("ROLE_", role));

      const plan = buildStoreRoleProvisioningPlan({
        environmentReference: environment,
        operationReference: id(20),
        operatorReference: operator,
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        catalogVersion: storePermissionCatalogVersion,
        catalogDigest: permissionCatalogDigest(),
        effectiveFrom: at,
        reasonCode: "STORE_OPENING",
        templates: ["owner", "store-manager", "front-of-house", "kitchen", "inventory-manager"],
        nextReference: next,
      });
      const keys = generateKeyPairSync("ed25519");
      const unsigned = {
        profile: "StoreRoleProvisioningApprovalV1",
        purposeCode: "STORE_ROLE_PROVISIONING",
        environmentReference: environment,
        operationReference: plan.operationReference,
        storeReference: store,
        planDigest: storeRoleProvisioningPlanDigest(plan),
        operatorReference: operator,
        approvedByReference: approver,
        approvalEvidenceReference: id(21),
        notBefore: "2026-10-07T00:00:00.000Z",
        validUntil: "2026-10-08T00:00:00.000Z",
        keyReference: id(22),
      };
      const approval = {
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(storeRoleProvisioningSigningBytes(unsigned), "utf8"),
          keys.privateKey,
        ).toString("base64url"),
      };
      const signed = (target, evidence) => {
        const body = {
          ...unsigned,
          operationReference: target.operationReference,
          planDigest: storeRoleProvisioningPlanDigest(target),
          approvalEvidenceReference: evidence,
        };
        return {
          ...body,
          signature: sign(
            null,
            Buffer.from(storeRoleProvisioningSigningBytes(body), "utf8"),
            keys.privateKey,
          ).toString("base64url"),
        };
      };
      let revoked = [];
      const trust = () => ({
        profile: "StoreRoleProvisioningTrustV1",
        keys: [
          {
            keyReference: id(22),
            approvedByReference: approver,
            environmentReference: environment,
            purposeCode: "STORE_ROLE_PROVISIONING",
            notBefore: "2026-10-01T00:00:00.000Z",
            validUntil: "2027-10-01T00:00:00.000Z",
            publicKeySpki: keys.publicKey
              .export({ format: "der", type: "spki" })
              .toString("base64url"),
          },
        ],
        revokedApprovalEvidenceReferences: revoked,
      });
      let clockMinute = 0;
      const options = (material = () => ({ approval, trust: trust() })) => ({
        clock: {
          now: () => `2026-10-07T12:${String(clockMinute++ % 60).padStart(2, "0")}:00.000Z`,
        },
        readApprovalMaterial: async () => material(),
        storeScope: { confirm: confirmStoreOpeningScope },
        nextReference: next,
      });
      const transaction = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const value = await work(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };

      // A revocation observed while writing refuses the whole provisioning and leaves nothing behind.
      let reads = 0;
      await assert.rejects(
        transaction((tx) =>
          provisionStoreRoles(
            tx,
            plan,
            options(() => {
              reads += 1;
              if (reads === 2) revoked = [id(21)];
              return { approval, trust: trust() };
            }),
          ),
        ),
        { code: "STORE_ROLE_PROVISIONING_APPROVAL_UNAVAILABLE" },
      );
      revoked = [];
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_permission.role")).rows[0].n,
        0,
      );

      const applied = await transaction((tx) => provisionStoreRoles(tx, plan, options()));
      const expectedGrants = [
        "owner",
        "store-manager",
        "front-of-house",
        "kitchen",
        "inventory-manager",
      ].reduce((sum, template) => sum + storeRoleTemplateActions(template).length, 0);
      assert.deepEqual(
        { status: applied.status, roles: applied.roleCount, grants: applied.grantCount },
        { status: "Applied", roles: 5, grants: expectedGrants },
      );
      const again = await transaction((tx) => provisionStoreRoles(tx, plan, options()));
      assert.equal(again.status, "AlreadyApplied");

      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      const kitchen = (
        await admin.query(
          `SELECT d.action_code FROM bop_permission.role r JOIN bop_permission.permission_grant g ON g.role_id=r.role_id
           JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id
           WHERE r.role_code='kitchen' AND r.store_id=$1 AND g.lifecycle='Active' ORDER BY d.action_code COLLATE "C"`,
          [store],
        )
      ).rows.map((row) => row.action_code);
      assert.deepEqual(kitchen, [...storeRoleTemplateActions("kitchen")]);
      const administration = (
        await admin.query(
          "SELECT role_code,role_type,lifecycle,submitted_by_reference::text s,approved_by_reference::text a FROM bop_permission.role_administration_version ORDER BY role_code",
        )
      ).rows;
      assert.equal(administration.length, 5);
      assert.ok(
        administration.every(
          (row) =>
            row.role_type === "System" &&
            row.lifecycle === "Active" &&
            row.s === operator &&
            row.a === approver,
        ),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM bop_permission.role_administration_decision",
          )
        ).rows[0].n,
        15,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='STORE_ROLES_PROVISIONED'",
          )
        ).rows[0].n,
        1,
      );
      // The record is append-only and the database refuses a self-approved record.
      await assert.rejects(
        admin.query("UPDATE bop_permission.store_role_provisioning SET role_count=1"),
        /append-only/u,
      );
      // A second, different plan for the same Store is a conflict, not a second set of roles.
      const second = buildStoreRoleProvisioningPlan({
        ...plan,
        operationReference: id(30),
        templates: ["owner"],
        nextReference: next,
      });
      await assert.rejects(
        transaction((tx) =>
          provisionStoreRoles(
            tx,
            second,
            options(() => ({ approval: signed(second, id(31)), trust: trust() })),
          ),
        ),
        { code: "STORE_ROLE_PROVISIONING_CONFLICT" },
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
