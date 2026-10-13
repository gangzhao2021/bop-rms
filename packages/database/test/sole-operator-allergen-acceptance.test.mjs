import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantAllergens } from "../../../apps/api/src/merchant-allergens.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 Q19 step 2 (DEC-SOLE-OPERATOR-APPROVAL, supplementary decision 2): the allergen roster is
 * recorded by one person and approved by another (server and database). The person who recorded
 * it approves it alone only as an in-effect, re-verified sole operator, marked SoleOperator; a
 * second roster manager ends that at once and approves independently. Restricted pilot API role.
 */
it("allergen roster: recorder ≠ approver; the sole operator approves alone with MFA", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_allergen" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      noah = id(5);
    let operation = 0x7000;
    const op = () => "019a0002-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_soa");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      const managerRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ["catalog.allergen_registry.manage", "catalog.allergen.read"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [managerRole],
        from,
        enrolledAt,
      });
      const tx = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          const value = await work(admin);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const actions = ["catalog.allergen.read", "catalog.allergen_registry.manage"];
      const brandScope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: { [owner]: actions, [noah]: actions },
      });
      const allergens = createMerchantAllergens({
        persistence: { now: () => new Date().toISOString(), transactions: { run: tx } },
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next: op },
        locale: "en-CA",
        resolveScope: brandScope.resolveScope,
      });
      const session = { sessionCookie: "c", csrf: "c" };
      const command = (body) => allergens.command({ ...session, body });
      const read = () => allergens.query({ ...session, itemReference: null });
      const rejects = (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
      const record = async () =>
        (
          await command({
            action: "RecordRegistry",
            operationReference: op(),
            template: "CA_PRIORITY_TEST",
          })
        ).proposalReference;
      const approve = (proposalReference, sole) =>
        command({
          action: "ApproveRegistry",
          operationReference: op(),
          proposalReference,
          ...(sole ? { approvalMode: "SoleOperator" } : {}),
        });
      const versions = async () =>
        (
          await admin.query(
            "SELECT reviewer_actor_id::text reviewer,recorder_actor_id::text recorder,approval_mode,approver_mfa_at IS NOT NULL mfa FROM rms_catalog.allergen_registry_version ORDER BY reviewed_at",
          )
        ).rows;

      // ── 1. Two-person rule: the recorder cannot approve; not set → named refusal.
      brandScope.as(owner);
      const first = await record();
      const pending = await read();
      assert.deepEqual(
        [pending.registryProposal.recordedByYou, pending.soleOperator.status],
        [true, "NotSet"],
      );
      await rejects(approve(first, false), "ApprovalRequired");
      await rejects(approve(first, true), "SoleOperatorNotInEffect");

      // ── 2. On and in effect, second factor two hours old → verify again.
      await seedSoleOperatorSetting(admin, {
        id,
        n: 500,
        tenantReference,
        brandReference,
        actorReference: owner,
        state: "On",
        version: 1,
      });
      assert.equal((await read()).soleOperator.status, "Effective");
      await rejects(approve(first, true), "NeedsReverification");
      await rejects(approve(first, false), "ApprovalRequired");
      assert.deepEqual(await versions(), []);

      // ── 3. Re-verified: the recorder approves alone; version and Audit are marked.
      await seedStepUp(admin, {
        id,
        n: 520,
        brandReference,
        storeReference,
        actorReference: owner,
      });
      assert.equal((await approve(first, true)).status, "Applied");
      assert.deepEqual(await versions(), [
        { reviewer: owner, recorder: owner, approval_mode: "SoleOperator", mfa: true },
      ]);
      const audit = (
        await admin.query(
          "SELECT after_summary_json->>'approvalMode' mode FROM platform_audit.audit_record WHERE action_code='CATALOG_ALLERGEN_REGISTRY_APPROVE'",
        )
      ).rows;
      assert.deepEqual(audit, [{ mode: "SoleOperator" }]);
      assert.equal((await read()).registry.entries.length, 12);

      // ── 4. A second roster manager joins: it lapses at once, names them; they approve.
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference,
        actorReference: noah,
        name: "Noah",
        roles: [managerRole],
        from,
        enrolledAt,
      });
      const second = await record();
      const lapsed = (await read()).soleOperator;
      assert.deepEqual(
        [lapsed.status, lapsed.otherApprovers],
        ["OtherApprovers", [{ displayName: "Noah" }]],
      );
      await rejects(approve(second, true), "SoleOperatorNotInEffect");
      brandScope.as(noah);
      // Not the only roster manager either: the sole-operator path is refused.
      await rejects(approve(second, true), "SoleOperatorNotInEffect");
      assert.equal((await approve(second, false)).status, "Applied");
      assert.deepEqual((await versions()).at(-1), {
        reviewer: noah,
        recorder: owner,
        approval_mode: "Independent",
        mfa: false,
      });

      // ── 5. History is immutable; the database refuses a stale second factor on a mark.
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.allergen_registry_version SET approval_mode='Independent'",
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        admin.query("UPDATE rms_catalog.allergen_registry_proposal SET recorder_actor_id=$1", [
          noah,
        ]),
        /append-only allergen registry proposal/u,
      );
    } finally {
      await admin.end();
    }
  });
});
