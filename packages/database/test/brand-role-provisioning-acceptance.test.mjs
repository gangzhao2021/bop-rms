import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { confirmBrandMemberScope, createMembership } from "../../bop/membership/src/index.ts";
import {
  brandRoleTemplateActions,
  buildBrandRoleProvisioningPlan,
  createPostgresCurrentPermissionPolicySource,
  decideRoleAssignment,
  listRoleAdministration,
  listStoreRoleAssignments,
  permissionCatalogDigest,
  provisionBrandRoles,
  readBrandTemplateRoles,
  requestRoleAssignment,
  revokeRoleAssignment,
  roleAssignmentApprovalSigningBytes,
  storePermissionCatalogVersion,
  synchronizePermissionCatalog,
  verifyRoleAssignmentPlatformApproval,
} from "../../bop/permission/src/index.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { openSyntheticBrandRoles } from "../test-support/store-role-provisioning.mjs";

const { Client } = pg;
const id = (n) => "01909a0c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-07T10:00:00.000Z";

/** WP-2423 / DEC-PERM-BRAND-ROLES: Brand template roles and Brand role assignment. */
it("opens Brand roles under a signed plan and assigns them with independent approval", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_brand_roles" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000;
    const next = () => id(++sequence);
    const [tenant, brand, store, owner, chef, operator, approver] = [1, 2, 3, 4, 5, 6, 7].map(id);
    const members = new Map();
    try {
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'BRAND_ROLES','Brand Roles','en-CA','CAD','Active',1,$2,$2)",
        [brand, at],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'BRAND_ROLES_1','Store One','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, at],
      );
      for (const actor of [owner, chef]) {
        const membership = next();
        members.set(actor, membership);
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [membership, actor, brand, next(), at],
        );
      }
      await admin.query("BEGIN");
      await synchronizePermissionCatalog(admin, {
        operationReference: next(),
        operatorReference: operator,
        approvedByReference: approver,
        approvalEvidenceReference: next(),
        auditReference: next(),
        occurredAt: at,
        nextPermissionReference: next,
      });
      await admin.query("COMMIT");

      // A Brand Owner must be an Active Brand member.
      await assert.rejects(
        openSyntheticBrandRoles(admin, {
          tenant,
          brand,
          operator,
          approver,
          at,
          next,
          owner: { actorReference: owner, membershipReference: next() },
        }),
        { code: "STORE_ROLE_PROVISIONING_CONFLICT" },
      );
      const opened = await openSyntheticBrandRoles(admin, {
        tenant,
        brand,
        operator,
        approver,
        at,
        next,
        owner: { actorReference: owner, membershipReference: members.get(owner) },
      });
      assert.equal(opened.result.status, "Applied");
      assert.equal(opened.result.roleCount, 3);
      assert.equal(
        opened.result.grantCount,
        ["brand-owner", "recipe-developer", "recipe-reviewer"].reduce(
          (sum, template) => sum + brandRoleTemplateActions(template).length,
          0,
        ),
      );
      // Replaying the same signed plan reports it; a second opening is refused.
      await admin.query("BEGIN");
      const replay = await provisionBrandRoles(admin, opened.plan, {
        clock: { now: () => at },
        readApprovalMaterial: async () => ({ approval: opened.approval, trust: opened.trust }),
        memberScope: { confirm: confirmBrandMemberScope },
        nextReference: next,
      });
      await admin.query("COMMIT");
      assert.equal(replay.status, "AlreadyApplied");
      await assert.rejects(
        openSyntheticBrandRoles(admin, { tenant, brand, operator, approver, at, next }),
        { code: "STORE_ROLE_PROVISIONING_CONFLICT" },
      );

      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id','',false)",
        [brand],
      );
      const roles = (
        await admin.query(
          'SELECT role_code,store_id FROM bop_permission.role ORDER BY role_code COLLATE "C"',
        )
      ).rows;
      assert.deepEqual(roles, [
        { role_code: "brand_owner", store_id: null },
        { role_code: "recipe_developer", store_id: null },
        { role_code: "recipe_reviewer", store_id: null },
      ]);
      const reviewerActions = (
        await admin.query(
          `SELECT d.action_code FROM bop_permission.role r JOIN bop_permission.permission_grant g ON g.role_id=r.role_id
           JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id
           WHERE r.role_code='recipe_reviewer' AND g.store_id IS NULL AND g.lifecycle='Active' ORDER BY d.action_code COLLATE "C"`,
        )
      ).rows.map((row) => row.action_code);
      assert.deepEqual(reviewerActions, [...brandRoleTemplateActions("recipe-reviewer")]);
      assert.deepEqual(
        (await readBrandTemplateRoles(admin, { tenantReference: tenant, brandReference: brand }))
          .latestCatalogVersion,
        storePermissionCatalogVersion,
      );
      await assert.rejects(
        admin.query("UPDATE bop_permission.brand_role_provisioning SET role_count=1"),
        /append-only/u,
      );

      // Brand role assignment: requested by the Brand Owner, decided by an independent approver.
      const brandScope = { brandReference: brand, storeReference: null };
      const listed = await listRoleAdministration(
        admin,
        { brandReference: brand, storeReference: store },
        at,
      );
      const reviewerRole = listed.find((role) => role.record.code === "recipe_reviewer").record;
      assert.equal(reviewerRole.storeReference, null);
      let minute = 1;
      const tx = async (work) => {
        const now = `2026-10-07T11:${String(minute++).padStart(2, "0")}:00.000Z`;
        await admin.query("BEGIN");
        try {
          const value = await work(now);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const change = id(400);
      const request = (input) =>
        tx((now) =>
          requestRoleAssignment(admin, {
            ...brandScope,
            changeReference: change,
            assignmentReference: id(401),
            roleReference: reviewerRole.roleReference,
            actorReference: chef,
            membershipReference: members.get(chef),
            storeAssignmentReference: null,
            requestedBy: owner,
            at: now,
            auditReference: next(),
            ...input,
          }),
        );
      // A Brand role is never requested with a Store assignment.
      await assert.rejects(request({ storeAssignmentReference: id(9) }), {
        code: "ROLE_ASSIGNMENT_INVALID",
      });
      assert.equal((await request({})).status, "Requested");
      assert.equal((await request({})).status, "AlreadyApplied");
      const pending = await listStoreRoleAssignments(admin, brandScope, "2026-10-07T11:30:00.000Z");
      assert.deepEqual(
        pending.pending.map((item) => [item.changeReference, item.roleCode]),
        [[change, "recipe_reviewer"]],
      );
      // The Store-scoped listing keeps Store rows only.
      assert.equal(
        (
          await listStoreRoleAssignments(
            admin,
            { brandReference: brand, storeReference: store },
            "2026-10-07T11:30:00.000Z",
          )
        ).pending.length,
        0,
      );
      const decide = (decidedBy, extra = {}) =>
        tx((now) =>
          decideRoleAssignment(
            admin,
            {
              ...brandScope,
              changeReference: change,
              decision: "Approved",
              decidedBy,
              at: now,
              auditReference: next(),
              snapshotReference: next(),
              ...extra,
            },
            (member) => {
              assert.equal(member.storeAssignmentReference, null);
              return confirmBrandMemberScope(admin, {
                brandReference: brand,
                actorReference: member.actorReference,
                membershipReference: member.membershipReference,
                at: now,
              });
            },
          ),
        );
      await assert.rejects(decide(owner), { code: "ROLE_ASSIGNMENT_SELF" });
      await assert.rejects(decide(chef), { code: "ROLE_ASSIGNMENT_SELF" });

      // Platform support approves with a signed approval bound to the Brand scope (no Store).
      const keys = generateKeyPairSync("ed25519");
      const environment = next(),
        keyReference = next();
      const unsigned = {
        profile: "RoleAssignmentPlatformApprovalV1",
        purposeCode: "ROLE_ASSIGNMENT_APPROVAL",
        environmentReference: environment,
        brandReference: brand,
        storeReference: null,
        changeReference: change,
        roleReference: reviewerRole.roleReference,
        subjectReference: chef,
        requestedByReference: owner,
        approvedByReference: approver,
        approvalEvidenceReference: next(),
        notBefore: "2026-10-07T00:00:00.000Z",
        validUntil: "2026-10-08T00:00:00.000Z",
        keyReference,
      };
      const signed = {
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(roleAssignmentApprovalSigningBytes(unsigned), "utf8"),
          keys.privateKey,
        ).toString("base64url"),
      };
      const trust = {
        profile: "StoreRoleProvisioningTrustV1",
        keys: [
          {
            keyReference,
            approvedByReference: approver,
            environmentReference: environment,
            purposeCode: "ROLE_ASSIGNMENT_APPROVAL",
            notBefore: "2026-10-01T00:00:00.000Z",
            validUntil: "2027-10-01T00:00:00.000Z",
            publicKeySpki: keys.publicKey
              .export({ format: "der", type: "spki" })
              .toString("base64url"),
          },
        ],
        revokedApprovalEvidenceReferences: [],
      };
      const expected = {
        ...brandScope,
        changeReference: change,
        roleReference: reviewerRole.roleReference,
        subjectReference: chef,
        requestedByReference: owner,
      };
      // An approval signed for a Store does not approve the Brand request.
      assert.throws(() =>
        verifyRoleAssignmentPlatformApproval({
          approval: signed,
          trust,
          now: "2026-10-07T12:00:00.000Z",
          expected: { ...expected, storeReference: store },
        }),
      );
      const verified = verifyRoleAssignmentPlatformApproval({
        approval: signed,
        trust,
        now: "2026-10-07T12:00:00.000Z",
        expected,
      });
      const decided = await decide(verified.approvedByReference, {
        platformApprovalEvidence: verified.approvalEvidenceReference,
      });
      assert.equal(decided.status, "Applied");
      const active = await listStoreRoleAssignments(admin, brandScope, "2026-10-07T12:00:00.000Z");
      assert.deepEqual(
        active.assignments.map((item) => [item.actorReference, item.roleCode]).sort(),
        [
          [owner, "brand_owner"],
          [chef, "recipe_reviewer"],
        ],
      );

      // Current policy evaluation at Brand scope allows the reviewer's recipe.approve only.
      const actor = createIdentityActor({
        actorType: "User",
        actorReference: chef,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      });
      const brandEntity = createBrand({
        brandReference: brand,
        code: "BRAND_ROLES",
        displayName: "Brand Roles",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const evaluate = async (action) => {
        const resolvedAt = "2026-10-07T12:10:00.000Z";
        await admin.query("BEGIN");
        try {
          return await createPostgresCurrentPermissionPolicySource(admin).authorize({
            tenantContext: createTenantContext(actor, brandEntity, null, resolvedAt),
            membership: createMembership(
              {
                membershipReference: members.get(chef),
                actorReference: chef,
                brandReference: brand,
                workforceRelationshipReference: id(999),
                lifecycle: "Active",
                effectiveFrom: at,
                effectiveUntil: null,
                version: 1,
                createdAt: at,
                updatedAt: at,
              },
              actor,
            ),
            storeAssignment: null,
            action,
          });
        } finally {
          await admin.query("ROLLBACK");
        }
      };
      const approve = await evaluate("recipe.approve");
      assert.deepEqual([approve.effect, approve.scopeKind], ["Allow", "Brand"]);
      assert.equal((await evaluate("recipe.publish")).effect, "Deny");

      // Revocation applies at once; the last Brand Owner cannot be removed.
      const ownerAssignment = active.assignments.find((item) => item.actorReference === owner);
      await assert.rejects(
        tx((now) =>
          revokeRoleAssignment(admin, {
            ...brandScope,
            changeReference: next(),
            assignmentReference: ownerAssignment.assignmentReference,
            revokedBy: chef,
            at: now,
            auditReference: next(),
            snapshotReference: next(),
          }),
        ),
        { code: "ROLE_ASSIGNMENT_LAST_OWNER" },
      );
      const reviewerAssignment = active.assignments.find((item) => item.actorReference === chef);
      assert.equal(
        (
          await tx((now) =>
            revokeRoleAssignment(admin, {
              ...brandScope,
              changeReference: next(),
              assignmentReference: reviewerAssignment.assignmentReference,
              revokedBy: owner,
              at: now,
              auditReference: next(),
              snapshotReference: next(),
            }),
          )
        ).status,
        "Applied",
      );
      assert.equal((await evaluate("recipe.approve")).effect, "Deny");
    } finally {
      await admin.end();
    }
  });
});

it("builds Brand plans only from the released Brand templates", () => {
  const plan = buildBrandRoleProvisioningPlan({
    environmentReference: id(1),
    operationReference: id(2),
    operatorReference: id(3),
    tenantReference: id(4),
    brandReference: id(5),
    catalogVersion: storePermissionCatalogVersion,
    catalogDigest: permissionCatalogDigest(),
    effectiveFrom: at,
    reasonCode: "BRAND_ROLE_OPENING",
    templates: ["recipe-reviewer", "brand-owner"],
    nextReference: (() => {
      let n = 10;
      return () => id(++n);
    })(),
  });
  assert.deepEqual(
    plan.roles.map((role) => role.roleCode),
    ["brand_owner", "recipe_reviewer"],
  );
  assert.throws(() =>
    buildBrandRoleProvisioningPlan({
      environmentReference: id(1),
      operationReference: id(2),
      operatorReference: id(3),
      tenantReference: id(4),
      brandReference: id(5),
      catalogVersion: storePermissionCatalogVersion,
      catalogDigest: permissionCatalogDigest(),
      effectiveFrom: at,
      reasonCode: "BRAND_ROLE_OPENING",
      templates: ["recipe-reviewer"],
      nextReference: () => id(20),
    }),
  );
});
