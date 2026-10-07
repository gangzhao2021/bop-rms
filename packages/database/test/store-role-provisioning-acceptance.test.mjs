import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  buildStoreRoleProvisioningPlan,
  permissionCatalogDigest,
  provisionStoreRoles,
  readStoreTemplateRoles,
  storePermissionCatalogVersion,
  storeRoleProvisioningPlanDigest,
  storeRoleProvisioningSigningBytes,
  storeRoleTemplateActions,
  synchronizePermissionCatalog,
} from "../../bop/permission/src/index.ts";
import { confirmStoreMemberScope } from "../../bop/membership/src/index.ts";
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
      const owner = id(7),
        membership = id(8),
        storeAssignment = id(9);
      await admin.query(
        "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$5,'Active',$4,NULL,1,$4,$4)",
        [membership, owner, brand, at, id(60)],
      );
      await admin.query(
        "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
        [storeAssignment, membership, owner, brand, store, at],
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
        "GRANT USAGE ON SCHEMA bop_permission,bop_tenant,bop_membership,platform_audit,platform_helpers TO ROLE_",
        "GRANT SELECT ON bop_membership.membership,bop_membership.store_assignment TO ROLE_",
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
        ownerAssignment: {
          actorReference: owner,
          membershipReference: membership,
          storeAssignmentReference: storeAssignment,
        },
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
        memberScope: { confirm: confirmStoreMemberScope },
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
      assert.deepEqual(
        (
          await admin.query(
            "SELECT r.role_code,a.actor_id::text actor FROM bop_permission.role_assignment a JOIN bop_permission.role r ON r.role_id=a.role_id WHERE a.lifecycle='Active'",
          )
        ).rows,
        [{ role_code: "store_owner", actor: owner }],
      );

      // Upgrade: make the opened Store look as if it had been opened at catalog version 1 whose
      // Store Manager template lacked identity.role.approve (test-only rewind of the isolated
      // database; the append-only trigger is suspended solely for this setup).
      await admin.query("RESET ROLE");
      await admin.query(
        "INSERT INTO bop_permission.permission_catalog_revision VALUES(1,$1,$2,$3,$4,$5,$6,1,0,$7,'ConfigurationMetadata')",
        ["sha256:" + "0".repeat(64), id(40), operator, approver, id(41), id(42), at],
      );
      await admin.query(
        "ALTER TABLE bop_permission.store_role_provisioning DISABLE TRIGGER store_role_provisioning_append_only",
      );
      await admin.query("UPDATE bop_permission.store_role_provisioning SET catalog_version=1");
      await admin.query(
        "ALTER TABLE bop_permission.store_role_provisioning ENABLE TRIGGER store_role_provisioning_append_only",
      );
      await admin.query(
        `UPDATE bop_permission.permission_grant g SET lifecycle='Revoked',version=2 FROM bop_permission.role r,bop_permission.permission_definition d
         WHERE g.role_id=r.role_id AND d.permission_id=g.permission_id AND r.role_code='store_manager' AND d.action_code='identity.role.approve'`,
      );
      const current = await transaction((tx) =>
        readStoreTemplateRoles(tx, {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
        }),
      );
      assert.equal(current.latestCatalogVersion, 1);
      const upgrade = buildStoreRoleProvisioningPlan({
        environmentReference: environment,
        operationReference: id(50),
        operatorReference: operator,
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        catalogVersion: storePermissionCatalogVersion,
        catalogDigest: permissionCatalogDigest(),
        previousCatalogVersion: 1,
        existingRoles: current.roles,
        effectiveFrom: at,
        reasonCode: "STORE_ROLE_TEMPLATE_UPGRADE",
        templates: ["owner", "store-manager", "front-of-house", "kitchen", "inventory-manager"],
        nextReference: next,
      });
      // Platform may assign an Owner only while the Store has none.
      const withOwner = buildStoreRoleProvisioningPlan({
        environmentReference: environment,
        operationReference: id(55),
        operatorReference: operator,
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        catalogVersion: storePermissionCatalogVersion,
        catalogDigest: permissionCatalogDigest(),
        previousCatalogVersion: 1,
        existingRoles: current.roles,
        ownerAssignment: {
          actorReference: owner,
          membershipReference: membership,
          storeAssignmentReference: storeAssignment,
        },
        effectiveFrom: at,
        reasonCode: "STORE_ROLE_TEMPLATE_UPGRADE",
        templates: ["owner", "store-manager", "front-of-house", "kitchen", "inventory-manager"],
        nextReference: next,
      });
      await assert.rejects(
        transaction((tx) =>
          provisionStoreRoles(
            tx,
            withOwner,
            options(() => ({ approval: signed(withOwner, id(56)), trust: trust() })),
          ),
        ),
        { code: "STORE_ROLE_PROVISIONING_CONFLICT" },
      );
      const upgraded = await transaction((tx) =>
        provisionStoreRoles(
          tx,
          upgrade,
          options(() => ({ approval: signed(upgrade, id(51)), trust: trust() })),
        ),
      );
      assert.deepEqual(
        { status: upgraded.status, added: upgraded.addedCount, revoked: upgraded.revokedCount },
        { status: "Applied", added: 1, revoked: 0 },
      );
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT max(version)::int v,count(DISTINCT role_id)::int n FROM bop_permission.role_administration_version",
          )
        ).rows[0],
        { v: 2, n: 5 },
      );
      const repeated = await transaction((tx) =>
        provisionStoreRoles(
          tx,
          upgrade,
          options(() => ({ approval: signed(upgrade, id(51)), trust: trust() })),
        ),
      );
      assert.equal(repeated.status, "AlreadyApplied");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM bop_permission.role_assignment WHERE lifecycle='Active'",
          )
        ).rows[0].n,
        1,
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
