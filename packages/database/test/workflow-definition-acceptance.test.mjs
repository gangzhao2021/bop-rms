import { exercisePublishedOrderConfirmation } from "../test-support/published-order-confirmation.mjs";
import { evaluateOrderPaidWorkflow } from "../../../apps/api/src/order-paid-workflow.ts";
import { createMerchantOrderAcceptanceComposition } from "../../../apps/api/src/merchant-order-acceptance-composition.ts";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import { evaluateOrderAcceptanceWorkflow } from "../../../apps/api/src/order-acceptance-workflow.ts";
import { orderQueryFixture } from "../../rms/ordering/src/tests/order-creation-query.fixture.ts";
import { createCustomerSubmissionInventoryWorkflowSource } from "../../../apps/api/src/customer-submission-inventory-workflow-source.ts";
import { finalValidationFixture } from "../../rms/inventory/src/tests/submission-final-validation.fixture.ts";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresWorkflowDefinitionStore,
  parseWorkflowDefinitionVersion,
  createWorkflowPublicationSnapshot,
} from "../../bop/workflow/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
it("persists synthetic Workflow versions with atomic Audit, original recovery and scoped current locks", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_workflow" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_workflow_" + context.runId;
    try {
      const publicAcl = await admin.query(
        "SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='bop_workflow.workflow_definition_version'::regclass AND a.grantee=0",
      );
      assert.equal(publicAcl.rows[0].n, 0);
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_workflow,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON bop_workflow.workflow_definition_version TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      function runner(options = {}) {
        return {
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            let committed = false;
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='5s'");
              let wrote = false;
              const result = await work({
                query: async (sql, values) => {
                  if (sql.startsWith("INSERT INTO bop_workflow.workflow_definition_version"))
                    wrote = true;
                  if (options.failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              committed = true;
              if (options.loseAck && wrote) throw new Error("synthetic response loss");
              return result;
            } catch (error) {
              if (!committed) await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
            }
          },
        };
      }
      const scope = { tenantReference: id(1), brandReference: id(2), storeReference: null };
      const draft = parseWorkflowDefinitionVersion({
        schemaVersion: 1,
        workflowReference: id(3),
        versionReference: id(4),
        versionNumber: 1,
        ...scope,
        purposeCode: "OrderFulfillment",
        applicabilityCode: "Pickup",
        lifecycle: "Draft",
        baseVersionReference: null,
        overrideAuthorizationReference: null,
        effectiveFrom: at,
        effectiveUntil: null,
        publicationReference: null,
        approvalEvidenceReference: null,
        authoredByReference: id(5),
        createdAt: at,
        transitions: [
          {
            transitionReference: id(6),
            currentState: "CartReady",
            action: "SubmitOrder",
            nextState: "Submitted",
            permissionCode: "order.submit",
            ruleReferences: [id(7)],
            effects: [{ ownerModule: "inventory", commandCode: "ReserveInventory" }],
          },
        ],
      });
      function write(definition, n) {
        return {
          definition,
          operationReference: id(n),
          audit: {
            auditId: id(n + 1),
            brandId: id(2),
            ...(definition.storeReference === null ? {} : { storeId: definition.storeReference }),
            actor: { type: "User", reference: id(5) },
            actionCode: "WORKFLOW_DEFINITION_" + definition.lifecycle.toUpperCase(),
            targetType: "WorkflowDefinitionVersion",
            targetId: definition.versionReference,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: id(n),
            occurredAt: definition.createdAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        };
      }
      const store = createPostgresWorkflowDefinitionStore(runner(), scope);
      let validations = 0;
      const syntheticGate = async () => {
        validations++;
        return true;
      };
      const first = write(draft, 20);
      await assert.rejects(
        createPostgresWorkflowDefinitionStore(runner({ loseAck: true }), scope).commit(
          first,
          syntheticGate,
        ),
        { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
      );
      const recovered = await store.commit(
        { ...first, audit: { ...first.audit, auditId: id(99) } },
        syntheticGate,
      );
      assert.equal(recovered.status, "AlreadyApplied");
      assert.equal(recovered.auditReference, id(21));
      assert.equal(validations, 1);
      const published = parseWorkflowDefinitionVersion({
        ...draft,
        versionReference: id(30),
        versionNumber: 2,
        lifecycle: "Published",
        publicationReference: id(31),
        approvalEvidenceReference: id(32),
      });
      const publish = write(published, 40);
      await assert.rejects(
        store.commit(publish, async () => false),
        { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
      );
      await assert.rejects(
        createPostgresWorkflowDefinitionStore(runner({ failAudit: true }), scope).commit(
          publish,
          syntheticGate,
        ),
        { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bop_workflow.workflow_definition_version",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows[0].n,
        1,
      );
      assert.equal((await store.commit(publish, syntheticGate)).status, "Applied");
      await assert.rejects(
        store.commit(
          { ...publish, audit: { ...publish.audit, actor: { type: "User", reference: id(98) } } },
          syntheticGate,
        ),
        { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
      );
      const currentInput = {
        purposeCode: "OrderFulfillment",
        applicabilityCode: "Pickup",
        observedAt: at,
      };
      const selected = await runner().run(async (tx) => {
        const source = createPostgresWorkflowDefinitionStore(
          { run: async (work) => work(tx) },
          { ...scope, storeReference: id(10) },
        );
        const result = await source.resolveCurrent(currentInput);
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_workflow.workflow_definition_version IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
        return result;
      });
      assert.equal(selected.definition.versionReference, id(30));
      const local = createPostgresWorkflowDefinitionStore(runner(), {
        ...scope,
        storeReference: id(10),
      });
      const localDraft = parseWorkflowDefinitionVersion({
        ...draft,
        workflowReference: id(50),
        versionReference: id(51),
        storeReference: id(10),
        baseVersionReference: id(30),
        overrideAuthorizationReference: id(52),
      });
      await local.commit(write(localDraft, 60), syntheticGate);
      const localPublished = parseWorkflowDefinitionVersion({
        ...localDraft,
        versionReference: id(53),
        versionNumber: 2,
        lifecycle: "Published",
        publicationReference: id(54),
        approvalEvidenceReference: id(55),
      });
      await local.commit(write(localPublished, 70), syntheticGate);
      assert.equal((await local.resolveCurrent(currentInput)).definition.versionReference, id(53));
      const actionRequest = {
        ...scope,
        storeReference: id(10),
        actorReference: id(5),
        resourceReference: id(120),
        resourceVersion: 1,
        ...currentInput,
        expectedVersionReference: id(53),
        currentState: "CartReady",
        action: "SubmitOrder",
      };
      let resourceChecks = 0;
      await runner().run(async (outerTx) => {
        const bound = createPostgresWorkflowDefinitionStore(
          { run: async (work) => work(outerTx) },
          { ...scope, storeReference: id(10) },
        );
        const seen = [];
        const checkContext = async (tx) => {
          assert.equal(tx, outerTx);
          const result = await tx.query(
            "SELECT current_setting('bop.tenant_id') AS tenant,current_setting('bop.brand_id') AS brand,current_setting('bop.store_id') AS store",
            [],
          );
          assert.deepEqual(result.rows[0], { tenant: id(1), brand: id(2), store: id(10) });
        };
        const gates = {
          authorizeResource: async (tx, request) => {
            await checkContext(tx);
            resourceChecks++;
            seen.push("resource");
            assert.equal(request.resourceReference, id(120));
            return true;
          },
          validatePublication: async (tx, input) => {
            await checkContext(tx);
            seen.push("publication");
            assert.equal(input.definition.versionReference, id(53));
            assert.equal(input.brandDefinition.versionReference, id(30));
            return true;
          },
          authorizeAction: async (tx, input) => {
            await checkContext(tx);
            seen.push("action");
            assert.equal(input.transition.permissionCode, "order.submit");
            return true;
          },
          evaluateRule: async (tx, input) => {
            await checkContext(tx);
            seen.push("rule");
            assert.equal(input.ruleReference, id(7));
            return true;
          },
        };
        const evaluated = await bound.evaluateAction(actionRequest, gates);
        assert.equal(evaluated.transition.nextState, "Submitted");
        assert.deepEqual(seen, ["resource", "publication", "action", "rule"]);
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_workflow.workflow_definition_version IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
        await assert.rejects(
          bound.evaluateAction(actionRequest, {
            ...gates,
            authorizeResource: async (tx) => {
              await checkContext(tx);
              resourceChecks++;
              return false;
            },
          }),
          { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
        );
        await assert.rejects(
          bound.evaluateAction({ ...actionRequest, storeReference: id(11) }, gates),
          { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
        );
        assert.equal(resourceChecks, 2);
      });
      await admin.query("BEGIN");
      try {
        await admin.query(
          "LOCK TABLE bop_workflow.workflow_definition_version IN ROW EXCLUSIVE MODE NOWAIT",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      const other = createPostgresWorkflowDefinitionStore(runner(), {
        ...scope,
        storeReference: id(11),
      });
      assert.equal((await other.resolveCurrent(currentInput)).definition.versionReference, id(30));
      await assert.rejects(
        createPostgresWorkflowDefinitionStore(runner(), {
          ...scope,
          tenantReference: id(99),
          storeReference: id(10),
        }).resolveCurrent(currentInput),
        { code: "WORKFLOW_DEFINITION_UNAVAILABLE" },
      );
      await local.commit(
        write(
          parseWorkflowDefinitionVersion({
            ...localPublished,
            versionReference: id(56),
            versionNumber: 3,
            lifecycle: "Withdrawn",
          }),
          80,
        ),
        syntheticGate,
      );
      await assert.rejects(local.resolveCurrent(currentInput), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      const actualDraft = parseWorkflowDefinitionVersion({
        ...draft,
        workflowReference: id(500),
        versionReference: id(501),
        purposeCode: "PublicationBindingFixture",
        transitions: [
          ...draft.transitions,
          {
            transitionReference: id(503),
            currentState: "Submitted",
            action: "Accept",
            nextState: "Accepted",
            permissionCode: "order.accept",
            ruleReferences: [id(7)],
            effects: [],
          },
          {
            transitionReference: id(505),
            currentState: "Accepted",
            action: "ReleasePaidOrder",
            nextState: "Accepted",
            permissionCode: "order.release",
            ruleReferences: [id(7)],
            effects: [],
          },
          {
            transitionReference: id(506),
            currentState: "Accepted",
            action: "ReleasePaidOrderWithEffect",
            nextState: "Accepted",
            permissionCode: "order.release",
            ruleReferences: [id(7)],
            effects: [{ ownerModule: "Inventory", commandCode: "ReserveInventory" }],
          },
          {
            transitionReference: id(504),
            currentState: "Submitted",
            action: "Reject",
            nextState: "Rejected",
            permissionCode: "order.accept",
            ruleReferences: [],
            effects: [],
          },
        ],
      });
      await store.commit(write(actualDraft, 510), syntheticGate);
      const snapshot = createWorkflowPublicationSnapshot(actualDraft);
      const publisher = createPostgresPublishingMutationStore(runner(), id(1), snapshot.scope);
      const initial = {
        lifecycleId: id(550),
        familyReference: snapshot.familyReference,
        configurationType: snapshot.configurationType,
        purposeCode: snapshot.purposeCode,
        snapshotReference: snapshot.snapshotReference,
        snapshotDigest: snapshot.snapshotDigest,
        scope: snapshot.scope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      };
      function publicationMutation(operation, current, next, n, extra = {}) {
        return {
          operation,
          current,
          next,
          expectedVersion: current?.version ?? 1,
          idempotencyKey: id(n),
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: null,
          audit: {
            auditId: id(n + 1),
            brandId: id(2),
            actor: { type: "User", reference: id(5) },
            actionCode: {
              CreateDraft: "PUBLISHING_DRAFT_CREATED",
              SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
              Approve: "PUBLISHING_REVIEW_APPROVED",
              Publish: "PUBLISHING_RELEASE_PUBLISHED",
              Archive: "PUBLISHING_RELEASE_ARCHIVED",
            }[operation],
            targetType: "PublishingLifecycle",
            targetId: next.lifecycleId,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: id(n),
            occurredAt: at,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
            retentionPolicyVersion: 1,
          },
          ...extra,
        };
      }
      const validation = {
        evidenceReference: id(560),
        snapshotReference: snapshot.snapshotReference,
        snapshotDigest: snapshot.snapshotDigest,
        scope: snapshot.scope,
        result: "Pass",
        checkedAt: at,
        validUntil: "2026-09-11T11:00:00.000Z",
        checkCodes: ["SCHEMA_VALID"],
      };
      const review = {
        ...initial,
        version: 2,
        state: "InReview",
        validationEvidenceReference: id(560),
      };
      const approval = {
        evidenceReference: id(561),
        reviewLifecycleId: id(550),
        reviewVersion: 2,
        snapshotReference: snapshot.snapshotReference,
        snapshotDigest: snapshot.snapshotDigest,
        scope: snapshot.scope,
        decision: "Accepted",
        approvedActorReference: id(5),
        approvedAt: at,
        validUntil: validation.validUntil,
      };
      const approved = {
        ...review,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: id(561),
      };
      const publicationLifecycle = { ...approved, version: 4, state: "Published" };
      const release = {
        releaseId: id(562),
        familyReference: snapshot.familyReference,
        configurationType: snapshot.configurationType,
        purposeCode: snapshot.purposeCode,
        snapshotReference: snapshot.snapshotReference,
        snapshotDigest: snapshot.snapshotDigest,
        scope: snapshot.scope,
        sequence: 1,
        sourceLifecycleId: id(550),
        kind: "Publish",
        previousReleaseId: null,
        createdAt: at,
      };
      await publisher.commit(publicationMutation("CreateDraft", null, initial, 600));
      await publisher.commit(
        publicationMutation("SubmitReview", initial, review, 602, {
          validationEvidence: validation,
        }),
      );
      await publisher.commit(
        publicationMutation("Approve", review, approved, 604, { approvalEvidence: approval }),
      );
      await publisher.commit(
        publicationMutation("Publish", approved, publicationLifecycle, 606, {
          validationEvidence: validation,
          approvalEvidence: approval,
          release,
        }),
      );
      const actualPublished = parseWorkflowDefinitionVersion({
        ...actualDraft,
        versionReference: id(502),
        versionNumber: 2,
        lifecycle: "Published",
        publicationReference: id(562),
        approvalEvidenceReference: id(561),
      });
      await store.commit(write(actualPublished, 520), syntheticGate);
      await runner().run(async (tx) => {
        const bound = createPostgresWorkflowDefinitionStore(
          { run: async (work) => work(tx) },
          { ...scope, storeReference: id(10) },
        );
        const boundPublication = await bound.validatePublication(id(502), at);
        assert.equal(boundPublication.snapshot.snapshotDigest, snapshot.snapshotDigest);
        assert.equal(boundPublication.publication.release.releaseId, id(562));
        const contextAfter = await tx.query("SELECT current_setting('bop.store_id') AS store", []);
        assert.equal(contextAfter.rows[0].store, id(10));
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      });
      const publishedActionStore = createPostgresWorkflowDefinitionStore(runner(), {
        ...scope,
        storeReference: id(10),
      });
      const publishedActionRequest = {
        ...actionRequest,
        purposeCode: "PublicationBindingFixture",
        expectedVersionReference: id(502),
      };
      const ownerActionGates = {
        authorizeResource: async () => true,
        authorizeAction: async () => true,
        evaluateRule: async () => true,
        authorizeOverride: async () => {
          throw new Error("Brand-only action must not request a synthetic Store override");
        },
      };
      assert.equal(
        (
          await publishedActionStore.evaluatePublishedAction(
            publishedActionRequest,
            ownerActionGates,
          )
        ).definition.versionReference,
        id(502),
      );
      const originalOrder = orderQueryFixture().record;
      function alignOrderScope(value) {
        if (value === originalOrder.order.brandReference) return scope.brandReference;
        if (value === originalOrder.order.storeReference) return id(10);
        if (Array.isArray(value)) return value.map(alignOrderScope);
        if (value !== null && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, alignOrderScope(entry)]),
          );
        return value;
      }
      const orderRecord = alignOrderScope(originalOrder);
      const acceptanceRequest = {
        ...publishedActionRequest,
        resourceReference: orderRecord.order.orderReference,
        resourceVersion: orderRecord.order.aggregateVersion,
        currentState: "Submitted",
        action: "Accept",
      };
      let acceptanceAuthorizations = 0;
      let acceptanceRules = 0;
      const acceptOrder = (binding = {}, requestPatch = {}, authorized = true) =>
        runner().run(async (transaction) =>
          evaluateOrderAcceptanceWorkflow({
            transaction,
            order: orderRecord,
            quoteVersion: 1,
            request: { ...acceptanceRequest, ...requestPatch },
            acceptance: {
              action: "Accept",
              purposeCode: "PublicationBindingFixture",
              permissionCode: "order.accept",
              ...binding,
            },
            gates: {
              ...ownerActionGates,
              authorizeAction: async (tx, action) => {
                assert.equal(tx, transaction);
                assert.equal(action.transition.nextState, "Accepted");
                acceptanceAuthorizations++;
                return authorized;
              },
              evaluateRule: async (tx, rule) => {
                assert.equal(tx, transaction);
                assert.equal(rule.ruleReference, id(7));
                acceptanceRules++;
                return true;
              },
            },
          }),
        );
      assert.equal((await acceptOrder()).transition.nextState, "Accepted");
      assert.equal(acceptanceAuthorizations, 1);
      assert.equal(acceptanceRules, 1);
      await assert.rejects(acceptOrder({ permissionCode: "order.other" }), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      await assert.rejects(acceptOrder({ action: "Reject" }, { action: "Reject" }), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      assert.equal(acceptanceAuthorizations, 1);
      assert.equal(acceptanceRules, 1);
      await assert.rejects(acceptOrder({}, {}, false), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      assert.equal(acceptanceAuthorizations, 2);
      assert.equal(acceptanceRules, 1);
      await seedAcceptanceOrderHistory(admin, orderRecord);
      await admin.query("GRANT USAGE ON SCHEMA rms_ordering TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_ordering.order_submission_record,rms_ordering.order_item,rms_ordering.order_number_allocation TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,UPDATE ON rms_ordering.order_header,rms_ordering.order_batch TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT ON rms_ordering.order_acceptance_record TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record TO " +
          role,
      );
      let eligibilityAllowed = false;
      let merchantAllowed = true;
      let eligibilityCalls = 0;
      const acceptedRecord = {
        acceptanceReference: id(710),
        operationReference: id(711),
        brandReference: scope.brandReference,
        storeReference: id(10),
        orderReference: orderRecord.order.orderReference,
        orderBatchReference: orderRecord.order.batches[0].orderBatchReference,
        expectedOrderVersion: 1,
        acceptedOrderVersion: 2,
        actorType: "User",
        actorReference: id(5),
        purposeCode: "PublicationBindingFixture",
        permissionCode: "order.accept",
        reasonCode: "SYNTHETIC_TEST",
        workflowVersionReference: id(502),
        transitionReference: id(503),
        sourceDigest: "sha256:" + "a".repeat(64),
        acceptedAt: at,
      };
      const merchant = createMerchantOrderAcceptanceComposition({
        scope: { ...scope, storeReference: id(10) },
        quoteVersion: 1,
        acceptance: {
          action: "Accept",
          purposeCode: "PublicationBindingFixture",
          permissionCode: "order.accept",
        },
        gates: ownerActionGates,
        authorize: async (_, record) => merchantAllowed && record.actorReference === id(5),
        validateEligibility: async (tx, candidate, currentOrder) => {
          eligibilityCalls++;
          assert.equal(currentOrder.order.orderReference, candidate.orderReference);
          assert.equal(currentOrder.items.length, orderRecord.items.length);
          const context = await tx.query("SELECT current_setting('bop.store_id') AS store", []);
          assert.equal(context.rows[0].store, id(10));
          return eligibilityAllowed;
        },
        audit: async (record) => ({
          auditId: id(712),
          brandId: scope.brandReference,
          storeId: id(10),
          actor: { type: "User", reference: id(5) },
          actionCode: "ORDER_ACCEPTED",
          targetType: "Order",
          targetId: record.orderReference,
          correlationId: record.operationReference,
          reasonCode: record.reasonCode,
          occurredAt: record.acceptedAt,
          sourceChannel: "MERCHANT_WEB",
          afterSummary: { phase: "Accepted" },
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      });
      const commitMerchantAcceptance = (patch = {}) =>
        runner().run((transaction) =>
          merchant.commit({
            transaction,
            record: { ...acceptedRecord, ...patch },
            submissionReference: orderRecord.submissionReference,
          }),
        );
      await assert.rejects(commitMerchantAcceptance());
      assert.equal(eligibilityCalls, 1);
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record"))
          .rows[0].n,
        0,
      );
      eligibilityAllowed = true;
      await assert.rejects(commitMerchantAcceptance({ transitionReference: id(504) }));
      assert.equal(eligibilityCalls, 1);
      const committedAcceptance = await commitMerchantAcceptance();
      assert.equal(committedAcceptance.status, "Created");
      assert.equal(committedAcceptance.record.workflowVersionReference, id(502));
      assert.equal(eligibilityCalls, 2);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='ORDER_ACCEPTED'",
          )
        ).rows[0].n,
        1,
      );
      const originalAcceptance = await commitMerchantAcceptance({ acceptanceReference: id(713) });
      assert.equal(originalAcceptance.status, "AlreadyCommitted");
      assert.deepEqual(originalAcceptance.record, committedAcceptance.record);
      merchantAllowed = false;
      await assert.rejects(commitMerchantAcceptance());
      assert.equal(eligibilityCalls, 2);
      merchantAllowed = true;
      let releaseResourceAllowed = true;
      const releasePaidOrder = (patch = {}, binding = {}) =>
        runner().run((transaction) =>
          evaluateOrderPaidWorkflow({
            transaction,
            context: { order: orderRecord, acceptance: committedAcceptance.record, observedAt: at },
            request: {
              ...acceptanceRequest,
              actorReference: id(5),
              currentState: "Accepted",
              resourceVersion: 2,
              action: "ReleasePaidOrder",
              ...patch,
            },
            release: {
              action: "ReleasePaidOrder",
              purposeCode: "PublicationBindingFixture",
              permissionCode: "order.release",
              nextState: "Accepted",
              ...binding,
            },
            gates: { ...ownerActionGates, authorizeResource: async () => releaseResourceAllowed },
          }),
        );
      assert.equal((await releasePaidOrder()).transition.transitionReference, id(505));
      await assert.rejects(releasePaidOrder({ resourceVersion: 1 }), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      await assert.rejects(releasePaidOrder({}, { permissionCode: "order.other" }), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      releaseResourceAllowed = false;
      await assert.rejects(releasePaidOrder(), { code: "WORKFLOW_DEFINITION_UNAVAILABLE" });
      releaseResourceAllowed = true;
      const verifyArchivedConfirmation = await exercisePublishedOrderConfirmation({
        admin,
        role,
        runner,
        scope: { ...scope, storeReference: id(10) },
        orderRecord,
        request: { ...acceptanceRequest, actorReference: id(5) },
        gates: ownerActionGates,
        at,
        id,
      });
      const finalFixture = finalValidationFixture();
      const finalRecord = {
        ...finalFixture,
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: publishedActionRequest.storeReference,
        actorReference: publishedActionRequest.actorReference,
        cartReference: publishedActionRequest.resourceReference,
        cartVersion: publishedActionRequest.resourceVersion,
        observedAt: publishedActionRequest.observedAt,
        workflowReference: actualPublished.workflowReference,
        workflowVersionReference: actualPublished.versionReference,
        workflowVersion: actualPublished.versionNumber,
        transitionReference: actualPublished.transitions[0].transitionReference,
        reservationSet: null,
        items: finalFixture.items.map((item) => ({
          ...item,
          stockTrackingEnabled: false,
          disposition: "NotTracked",
        })),
      };
      const finalWorkflow = (record = finalRecord, request = publishedActionRequest) =>
        runner().run(async (tx) =>
          createCustomerSubmissionInventoryWorkflowSource(
            tx,
            {
              ...scope,
              storeReference: publishedActionRequest.storeReference,
            },
            { reserveCommandCode: "ReserveInventory", gates: ownerActionGates },
          ).resolve(record, request),
        );
      assert.deepEqual(await finalWorkflow(), finalRecord);
      await assert.rejects(finalWorkflow({ ...finalRecord, cartVersion: 99 }), {
        code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
      });
      await assert.rejects(finalWorkflow({ ...finalRecord, transitionReference: id(9999) }), {
        code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
      });
      await assert.rejects(store.validatePublication(id(30), at));
      await publisher.commit(
        publicationMutation(
          "Archive",
          publicationLifecycle,
          { ...publicationLifecycle, version: 5, state: "Archived" },
          608,
        ),
      );
      await assert.rejects(store.validatePublication(id(502), at));
      await verifyArchivedConfirmation();
      await assert.rejects(releasePaidOrder(), { code: "WORKFLOW_DEFINITION_UNAVAILABLE" });
      await assert.rejects(acceptOrder(), { code: "WORKFLOW_DEFINITION_UNAVAILABLE" });
      assert.equal(acceptanceAuthorizations, 2);
      assert.equal(acceptanceRules, 1);
      await assert.rejects(finalWorkflow(), { code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" });
      await assert.rejects(
        publishedActionStore.evaluatePublishedAction(publishedActionRequest, ownerActionGates),
      );
      const race = await Promise.allSettled(
        [90, 100].map((n) =>
          store.commit(
            write(
              parseWorkflowDefinitionVersion({
                ...draft,
                versionReference: id(n + 2),
                versionNumber: 3,
              }),
              n,
            ),
            syntheticGate,
          ),
        ),
      );
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      await assert.rejects(
        admin.query("UPDATE bop_workflow.workflow_definition_version SET purpose_code='Changed'"),
        { code: "55000" },
      );
      await assert.rejects(admin.query("DELETE FROM bop_workflow.workflow_definition_version"), {
        code: "55000",
      });
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
