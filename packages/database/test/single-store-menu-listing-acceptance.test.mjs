import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPublishingMutationStore,
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
} from "../../bop/publishing/src/index.ts";
import { recordMenuSingleStoreListing } from "../../rms/catalog/src/index.ts";
import { createMenuReviewApprovalSource } from "../../../apps/api/src/menu-review-approval-source.ts";
import {
  MerchantSingleStoreListingError,
  requireMerchantBrandSingleStore,
} from "../../../apps/api/src/merchant-sole-operator.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a2e-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7): at a Brand with one store,
 * the person who submitted a menu version lists it alone ("List it", no review); the approval is
 * marked SingleStoreListing. Under the restricted pilot API role with the rendered grants, over real
 * Publishing lifecycle rows and the Organization, Membership and Permission owners' reads:
 * 1. one store: the submitter who holds menu approval lists alone; the mark is recorded;
 * 2. someone without menu approval (catalog permission) cannot list, even their own submission;
 * 3. a second store (even a draft one) turns the exception off at once — in the application and
 *    in the database (a mark written directly is refused); archiving it turns it back on;
 * 4. marks are append-only and scoped to their Brand; a version is listed once.
 */
it("single store: the submitter lists alone; no catalog permission or a second store refuses", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_menu" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      secondStore = id(6),
      owner = id(4),
      cook = id(5);
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_ssm");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      const store = (reference, code, lifecycle) =>
        admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD',$5,1,$6,$6)",
          [reference, brandReference, code, "Synthetic " + code, lifecycle, from],
        );
      await store(storeReference, "STORE_ONE", "Active");
      const approverRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "menu_manager",
        // The real Menu Manager template (catalog v21).
        actions: brandRoleTemplateActions("menu-manager"),
        from,
      });
      const kitchenRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(320),
        // A real Brand template without menu approval.
        code: "recipe_developer",
        actions: brandRoleTemplateActions("recipe-developer"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [approverRole],
        from,
        enrolledAt,
      });
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference,
        actorReference: cook,
        name: "Kai",
        roles: [kitchenRole],
        from,
        enrolledAt,
      });
      const run = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brandReference],
          );
          const value = await work({
            query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
          });
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const scope = createPublishingScope({ kind: "Brand", brandReference, storeReference: null });
      const publishing = createPostgresPublishingMutationStore(
        { run: (work) => run(work) },
        tenantReference,
        scope,
      );
      const digest = "sha256:" + "d".repeat(64);
      let n = 1000;
      // A menu version submitted for review by `submitter` (Publishing lifecycle rows).
      const submit = async (submitter) => {
        const lifecycle = id(++n),
          menu = id(++n),
          version = id(++n);
        const at = new Date(Date.parse(await dbNow(admin)) - 60_000).toISOString();
        const draft = createPublishingLifecycleRecord({
          lifecycleId: lifecycle,
          familyReference: menu,
          configurationType: "MENU",
          purposeCode: "CUSTOMER_ORDERING",
          snapshotReference: version,
          snapshotDigest: digest,
          scope,
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: at,
          changedAt: at,
        });
        const validation = createPublishingValidationEvidence({
          evidenceReference: id(++n),
          snapshotReference: version,
          snapshotDigest: digest,
          scope,
          result: "Pass",
          checkedAt: at,
          validUntil: new Date(Date.parse(at) + 3600_000).toISOString(),
          checkCodes: ["SYNTHETIC_MENU_VALIDATION"],
        });
        const commit = async (operation, current, next, extra) =>
          publishing.commit({
            operation,
            current,
            next,
            expectedVersion: current?.version ?? 1,
            idempotencyKey: id(++n),
            release: null,
            supersededReleaseId: null,
            rollbackTargetReleaseId: null,
            validationEvidence: null,
            approvalEvidence: null,
            audit: {
              auditId: id(++n),
              brandId: brandReference,
              actor: { type: "User", reference: submitter },
              actionCode:
                operation === "CreateDraft"
                  ? "PUBLISHING_DRAFT_CREATED"
                  : "PUBLISHING_REVIEW_SUBMITTED",
              targetType: "PublishingLifecycle",
              targetId: lifecycle,
              reasonCode: "SYNTHETIC_TEST",
              correlationId: id(n - 1),
              occurredAt: at,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Confidential",
              retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
              retentionPolicyVersion: 1,
            },
            ...extra,
          });
        await commit("CreateDraft", null, draft, {});
        await commit(
          "SubmitReview",
          draft,
          {
            ...draft,
            version: 2,
            state: "InReview",
            validationEvidenceReference: validation.evidenceReference,
          },
          { validationEvidence: validation },
        );
        return { lifecycle, menu, version };
      };
      const references = new Map();
      const approval = createMenuReviewApprovalSource({
        tenantReference,
        brandReference,
        reference: (purpose, operation) => {
          const key = purpose + operation;
          if (!references.has(key)) references.set(key, id(0x9000 + references.size));
          return references.get(key);
        },
        validUntil: ({ validationValidUntil }) => validationValidUntil,
        authorize: async () => true,
      });
      /** "List it" as `actor`: their own approval as a single-store listing, then its mark. */
      const list = async (submitted, actor) => {
        const operation = id(++n);
        return run(async (tx) => {
          const at = await dbNow(admin);
          let mode = "SingleStoreListing";
          const next = await approval.approve(tx, {
            actorReference: actor,
            menuReference: submitted.menu,
            menuVersionReference: submitted.version,
            lifecycleReference: submitted.lifecycle,
            snapshotDigest: digest,
            operationReference: operation,
            expectedVersion: 2,
            observedAt: at,
            singleStoreListing: async () => {
              mode = await requireMerchantBrandSingleStore(tx, {
                brandReference,
                storeReference,
                actorReference: actor,
                permissionCode: "catalog.menu.approve",
                observedAt: at,
                allowed: async () => true,
              });
              await tx.query(
                "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
                [brandReference],
              );
            },
          });
          await recordMenuSingleStoreListing(tx, {
            brandReference,
            storeReference,
            approvalEvidenceReference: references.get("Approval" + operation),
            operationReference: operation,
            menuReference: submitted.menu,
            menuVersionReference: submitted.version,
            lifecycleReference: submitted.lifecycle,
            actorReference: actor,
            listedAt: at,
            auditReference: id(0xa000 + n),
            approvalMode: mode,
          });
          return next;
        });
      };
      const marks = async () =>
        (
          await admin.query(
            "SELECT menu_version_id::text version,actor_id::text actor,approval_mode,listing_store_id::text store FROM rms_catalog.menu_single_store_listing ORDER BY listed_at",
          )
        ).rows;
      const refused = (code) => (error) => {
        assert.ok(error instanceof MerchantSingleStoreListingError, String(error));
        assert.equal(error.code, code);
        return true;
      };
      const approved = async (submitted) =>
        (
          await admin.query(
            "SELECT actor_id::text actor FROM bop_publishing.publishing_mutation_record WHERE lifecycle_id=$1 AND operation_code='Approve'",
            [submitted.lifecycle],
          )
        ).rows;

      // ── 1. One store: the submitter who holds menu approval lists alone; it is marked.
      const first = await submit(owner);
      assert.equal((await list(first, owner)).state, "Approved");
      assert.deepEqual(await marks(), [
        {
          version: first.version,
          actor: owner,
          approval_mode: "SingleStoreListing",
          store: storeReference,
        },
      ]);
      assert.deepEqual(await approved(first), [{ actor: owner }]);
      // v15 2026-10-28 finding a: the version is listed once — a second listing record of it, even
      // under a new operation and approval evidence, is refused (2000_114).
      const againAt = await dbNow(admin);
      await assert.rejects(
        run((tx) =>
          recordMenuSingleStoreListing(tx, {
            brandReference,
            storeReference,
            approvalEvidenceReference: id(0x9800),
            operationReference: id(0x9801),
            menuReference: first.menu,
            menuVersionReference: first.version,
            lifecycleReference: first.lifecycle,
            actorReference: owner,
            listedAt: againAt,
            auditReference: id(0x9802),
          }),
        ),
        /menu_single_store_listing_version_once/u,
      );
      assert.equal((await marks()).length, 1);

      // ── 2. No catalog permission: Kai (kitchen) cannot list, even their own submission.
      const kais = await submit(cook);
      await assert.rejects(list(kais, cook), refused("NotPermitted"));
      assert.deepEqual(await approved(kais), []);
      assert.equal((await marks()).length, 1);

      // ── 3. A second store (a draft one) turns the exception off at once.
      await store(secondStore, "STORE_TWO", "Draft");
      const second = await submit(owner);
      await assert.rejects(list(second, owner), refused("NotSingleStore"));
      assert.deepEqual(await approved(second), []);
      // The database refuses a mark written directly while the Brand has two stores.
      const directAt = await dbNow(admin);
      await assert.rejects(
        run((tx) =>
          recordMenuSingleStoreListing(tx, {
            brandReference,
            storeReference,
            approvalEvidenceReference: id(0x9900),
            operationReference: id(0x9901),
            menuReference: second.menu,
            menuVersionReference: second.version,
            lifecycleReference: second.lifecycle,
            actorReference: owner,
            listedAt: directAt,
            auditReference: id(0x9902),
          }),
        ),
        /menu single store listing needs a brand with one store/u,
      );
      assert.equal((await marks()).length, 1);
      // Archived, the second store no longer counts: listing alone works again.
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2 WHERE store_id=$1",
        [secondStore],
      );
      assert.equal((await list(second, owner)).state, "Approved");
      assert.equal((await marks()).length, 2);

      // ── 4. Append-only, and another Brand's scope sees none of it.
      await assert.rejects(
        admin.query("UPDATE rms_catalog.menu_single_store_listing SET actor_id=$1", [cook]),
        /append-only menu single store listing/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_catalog.menu_single_store_listing"),
        /append-only menu single store listing/u,
      );
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [id(0x77)],
        );
        assert.equal(
          (await admin.query("SELECT count(*)::int n FROM rms_catalog.menu_single_store_listing"))
            .rows[0].n,
          0,
        );
      } finally {
        await admin.query("ROLLBACK");
      }

      // ── 5. DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31, a revision
      // of trade-off 7): with two active Stores, only someone with Brand Owner authority lists a
      // Brand change directly (marked BrandOwnerListing); a menu manager's change stays a draft
      // for the Owner, and the database refuses an Owner mark for anyone else.
      const thirdStore = id(7);
      await store(thirdStore, "STORE_THREE", "Active");
      const boss = id(8);
      const ownerRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(330),
        code: "brand_owner",
        // The real Brand Owner template (catalog v21).
        actions: brandRoleTemplateActions("brand-owner"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 700,
        brandReference,
        storeReference,
        actorReference: boss,
        name: "Bo",
        roles: [ownerRole],
        from,
        enrolledAt,
      });
      const managers = await submit(owner);
      await assert.rejects(list(managers, owner), refused("NotSingleStore"));
      assert.deepEqual(await approved(managers), []);
      const bosses = await submit(boss);
      assert.equal((await list(bosses, boss)).state, "Approved");
      assert.deepEqual((await marks()).at(-1), {
        version: bosses.version,
        actor: boss,
        approval_mode: "BrandOwnerListing",
        store: storeReference,
      });
      // A Brand Owner mark for the manager is refused by the database itself.
      const ownerAt = await dbNow(admin);
      await assert.rejects(
        run((tx) =>
          recordMenuSingleStoreListing(tx, {
            brandReference,
            storeReference,
            approvalEvidenceReference: id(0x9a00),
            operationReference: id(0x9a01),
            menuReference: managers.menu,
            menuVersionReference: managers.version,
            lifecycleReference: managers.lifecycle,
            actorReference: owner,
            listedAt: ownerAt,
            auditReference: id(0x9a02),
            approvalMode: "BrandOwnerListing",
          }),
        ),
        /menu brand owner listing needs Brand Owner authority/u,
      );
      // The Owner approves the manager's waiting change in one action — an independent approval
      // (the Owner is not its author), never the manager approving their own.
      const ownerApproval = await run(async (tx) =>
        approval.approve(tx, {
          actorReference: boss,
          menuReference: managers.menu,
          menuVersionReference: managers.version,
          lifecycleReference: managers.lifecycle,
          snapshotDigest: digest,
          operationReference: id(0x9b00),
          expectedVersion: 2,
          observedAt: await dbNow(admin),
        }),
      );
      assert.equal(ownerApproval.state, "Approved");
      assert.deepEqual(await approved(managers), [{ actor: boss }]);
    } finally {
      await admin.end();
    }
  });
}, 180_000);
