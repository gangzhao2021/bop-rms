import assert from "node:assert/strict";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  parseProductAggregate,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  createPostgresProductAuthoringResolutionStore,
  productAuthoringResolutionFields,
  createPostgresProductPublicationResolutionStore,
  productPublicationResolutionFields,
  parseProductPublicationCommand,
  deriveCatalogProductPublicationContentIdentity,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";

const id = (n) => "01902421-7100-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const countsSql = `SELECT
 (SELECT count(*)::int FROM rms_catalog.product) products,
 (SELECT count(*)::int FROM rms_catalog.product_version) versions,
 (SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,
 (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,
 (SELECT count(*)::int FROM rms_catalog.product_source_commit) commits,
 (SELECT count(*)::int FROM rms_catalog.product_authoring_operation_abandonment) authoring_fences,
 (SELECT count(*)::int FROM rms_catalog.product_publication_operation_abandonment) publication_fences,
 (SELECT count(*)::int FROM platform_audit.audit_record) audit,
 (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
 (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.product_id),'[]'::jsonb) FROM rms_catalog.product p) roots,
 (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
 (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;

/** Controlled synthetic authority and identities, not native IAM evidence.
 * Actual owning writers/receipts, PostgreSQL UoW, forced RLS, fences, Audit,
 * Outbox and rollback execute in one isolated migrated database. */
export async function exerciseProductAuthoringResolution() {
  await withIsolatedDatabase({ caseId: "wp2421_auth_resolve" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      role = "wp2421_auth_resolve_" + context.runId,
      tenant = id(1),
      brand = id(2),
      actor = id(3),
      otherActor = id(4),
      at = new Date(Date.now() - 3600000).toISOString(),
      states = new WeakMap();
    assert.match(role, /^wp2421_auth_resolve_[a-f0-9]+$/u);
    await admin.connect();
    let roleCreated = false,
      clock = at,
      allowed = true,
      afterWork = null,
      raceCapture = null,
      auditSequence = 900000,
      lastSqlCode = null;
    const counts = async () => (await admin.query(countsSql)).rows[0];
    const transactions = {
      async run(work) {
        const race = raceCapture,
          slot = race ? race.started++ : null;
        const client = new pg.Client({
          ...context.clientConfig,
          ...(race ? { connectionTimeoutMillis: 10000, query_timeout: 10000 } : {}),
        });
        await client.connect();
        if (race) race.pids[slot] = client.processID;
        let tx;
        try {
          await client.query("BEGIN");
          if (race)
            await client.query(
              "SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '10s'",
            );
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          lastSqlCode = null;
          tx = {
            async query(sql, values = []) {
              try {
                return await client.query(sql, [...values]);
              } catch (error) {
                lastSqlCode = error.code;
                throw error;
              }
            },
          };
          const guards = [];
          states.set(tx, guards);
          const result = await work(tx);
          if (afterWork) {
            const hook = afterWork;
            afterWork = null;
            await hook(tx);
          }
          for (const item of guards) await item.guard();
          for (const item of guards) item.finalAssert();
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          if (tx) states.delete(tx);
          await client.end();
        }
      },
    };
    const registerBeforeCommit = async (tx, guard, finalAssert) => {
      const entries = states.get(tx);
      assert(entries);
      entries.push({ guard, finalAssert });
    };
    const audit = (
      operation,
      actionCode,
      targetType,
      targetId,
      occurredAt,
      actorReference = actor,
      reasonCode = "SYNTHETIC_RECOVERY",
    ) => ({
      auditId: id(++auditSequence),
      brandId: brand,
      actor: { type: "User", reference: actorReference },
      actionCode,
      targetType,
      targetId,
      reasonCode,
      correlationId: operation,
      occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "CATALOG_CONFIGURATION",
      retentionPolicyVersion: 1,
    });
    const resolutionCommand = (
      action,
      operation,
      productReference = null,
      expectedAggregateVersion = null,
      actorReference = actor,
    ) => ({
      profile: "CatalogProductAuthoringResolutionCommandV1",
      tenantReference: tenant,
      brandReference: brand,
      actorReference,
      action,
      operationReference: operation,
      productReference,
      expectedAggregateVersion,
    });
    const authoring = (actorReference = actor) =>
      createPostgresProductAuthoringResolutionStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference,
        clock: { now: () => clock },
        transactions,
        registerBeforeCommit,
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_AUTHORING_OPERATION_RESOLUTION");
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.actorKind, "User");
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.deepEqual(input.requiredFields, productAuthoringResolutionFields);
            assert.equal(input.command.actorReference, actorReference);
            assert.deepEqual(input.requiredPermissions, [
              "catalog.manage",
              "catalog.product.manage",
              "catalog.product.read",
              "catalog.product.history.read",
            ]);
            if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        audit: {
          create: ({ command, resolution }) =>
            audit(
              command.operationReference,
              "CATALOG_PRODUCT_AUTHORING_OPERATION_ABANDONED",
              "ProductAuthoringOperation",
              command.operationReference,
              resolution.recordedAt,
              actorReference,
              "ORIGINAL_OPERATION_ABANDONED",
            ),
        },
      });
    const ownerOptions = { brandReference: brand, transactions, authorize: async () => allowed };
    const create = createPostgresProductCreationStore(ownerOptions),
      draft = createPostgresProductDraftStore(ownerOptions);
    const aggregate = (base) =>
      parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTHETIC_RECOVERY_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: at,
        createdByActorReference: actor,
        updatedAt: at,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic recovery" },
          taxClassificationReference: null,
          createdAt: at,
          updatedAt: at,
          skus: [],
          optionBindings: [],
        },
      });
    const createInput = (operation, value) => ({
      record: {
        action: "Create",
        operationReference: operation,
        operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
        aggregate: value,
      },
      audit: audit(
        operation,
        "CATALOG_PRODUCT_CREATE",
        "CatalogProduct",
        value.productReference,
        value.updatedAt,
      ),
    });
    const draftInput = (operation, value, expectedAggregateVersion) => ({
      record: {
        action: "ReplaceDraft",
        operationReference: operation,
        operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
        aggregate: value,
      },
      expectedAggregateVersion,
      audit: audit(
        operation,
        "CATALOG_PRODUCT_REPLACEDRAFT",
        "CatalogProduct",
        value.productReference,
        value.updatedAt,
      ),
    });
    // The first real owning transaction retains its source/operation locks
    // after work and before COMMIT. Actual PostgreSQL blocker identity, rather
    // than elapsed time or a mock callback, proves the competing transaction.
    const concurrentOriginal = async (store, write, command, writerFirst, expected) => {
      const baselineCounts = await counts();
      const held = Promise.withResolvers(),
        release = Promise.withResolvers();
      const capture = { started: 0, pids: [] };
      const bounded = async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error("Synthetic authoring race timed out")), 10000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const settled = (start) =>
        start().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      let first, second;
      raceCapture = capture;
      afterWork = async () => {
        held.resolve();
        await bounded(release.promise);
      };
      try {
        first = settled(writerFirst ? write : () => store.execute(command));
        await bounded(held.promise);
        second = settled(writerFirst ? () => store.execute(command) : write);
        const deadline = Date.now() + 10000;
        let blocked = false;
        while (Date.now() < deadline && !blocked) {
          if (capture.pids[1]) {
            const observation = await admin.query({
              text: "SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1",
              values: [capture.pids[1]],
              query_timeout: 10000,
            });
            const row = observation.rows[0];
            blocked = row?.wait_event_type === "Lock" && row.blockers.includes(capture.pids[0]);
          } else {
            // A real query yields to the connecting contender without sleeping.
            await admin.query({ text: "SELECT 1", query_timeout: 10000 });
          }
        }
        assert.equal(capture.started, 2);
        assert.equal(blocked, true, "Synthetic contender must actually wait on the winner backend");
        release.resolve();
        const winner = await bounded(first);
        if (winner.error) throw winner.error;
        const committedCounts = await counts();
        const loser = await bounded(second);
        raceCapture = null;
        if (writerFirst) {
          if (loser.error) throw loser.error;
          assert.equal(loser.value.outcome, "Committed");
          assert.deepEqual(loser.value.command, command);
          assert.equal(loser.value.productReference, expected.aggregate.productReference);
          assert.equal(loser.value.versionReference, expected.aggregate.draft.versionReference);
          assert.equal(loser.value.aggregateVersion, expected.aggregate.aggregateVersion);
          assert.equal(loser.value.originalIntentDigest, "sha256:" + expected.intentHash);
          assert.equal(loser.value.recordedAt, expected.aggregate.updatedAt);
          assert.deepEqual(await store.execute(command), loser.value);
        } else {
          assert.equal(winner.value.outcome, "Abandoned");
          assert.deepEqual(winner.value.command, command);
          assert.equal(winner.value.productReference, command.productReference);
          assert.equal(winner.value.versionReference, null);
          assert.equal(winner.value.aggregateVersion, null);
          assert.equal(winner.value.originalIntentDigest, null);
          assert(loser.error);
          assert.equal(lastSqlCode, "23514");
          assert.deepEqual(await store.execute(command), winner.value);
        }
        assert.deepEqual(await counts(), committedCounts);
        assert.equal(committedCounts.operations, baselineCounts.operations + (writerFirst ? 1 : 0));
        assert.equal(committedCounts.snapshots, baselineCounts.snapshots + (writerFirst ? 1 : 0));
        assert.equal(committedCounts.commits, baselineCounts.commits + (writerFirst ? 1 : 0));
        assert.equal(
          committedCounts.authoring_fences,
          baselineCounts.authoring_fences + (writerFirst ? 0 : 1),
        );
        assert.equal(committedCounts.publication_fences, baselineCounts.publication_fences);
        assert.equal(committedCounts.audit, baselineCounts.audit + 1);
        if (!writerFirst) {
          assert.equal(committedCounts.products, baselineCounts.products);
          assert.equal(committedCounts.versions, baselineCounts.versions);
          assert.equal(committedCounts.outbox, baselineCounts.outbox);
          assert.deepEqual(committedCounts.roots, baselineCounts.roots);
          assert.deepEqual(committedCounts.heads, baselineCounts.heads);
        }
      } finally {
        release.resolve();
        await Promise.all([first, second].filter(Boolean));
        raceCapture = null;
        afterWork = null;
      }
    };
    const publicationCommand = (operation, value) => {
      const identity = deriveCatalogProductPublicationContentIdentity(value);
      return parseProductPublicationCommand({
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        operationReference: operation,
        productReference: value.productReference,
        versionReference: value.draft.versionReference,
        expectedProductAggregateVersion: value.aggregateVersion,
        expectedPublicationVersion: 0,
        action: "Validate",
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [{ level: "Store", reference: id(40), channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: null,
        occurredAt: clock,
        reasonCode: "SYNTHETIC_RECOVERY",
      });
    };
    const publicationResolution = createPostgresProductPublicationResolutionStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => clock },
      transactions,
      registerBeforeCommit,
      authority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.purposeCode, "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION");
          assert.equal(input.actorReference, actor);
          assert.deepEqual(input.requiredFields, productPublicationResolutionFields);
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      },
      audit: {
        create: ({ command, resolution }) =>
          audit(
            command.originalCommand.operationReference,
            "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED",
            "ProductPublicationOperation",
            command.originalCommand.operationReference,
            resolution.recordedAt,
            actor,
            "ORIGINAL_OPERATION_ABANDONED",
          ),
      },
    });
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      roleCreated = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_authoring_operation_abandonment,rms_catalog.product_publication_operation_abandonment,platform_audit.audit_record,platform_eventing.outbox_event,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_source_head,platform_audit.audit_chain_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment,rms_catalog.product_publication_revision,rms_catalog.product_publication_content,rms_catalog.product_publication_validation_report,rms_catalog.product_publication_warning_acknowledgement,rms_catalog.product_scope_retirement_header,rms_catalog.product_scope_journal TO " +
          role,
      );
      await admin.query("GRANT DELETE ON rms_catalog.sku TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
          role,
      );
      const store = authoring(),
        absentOperation = id(100),
        absentCommand = resolutionCommand("Create", absentOperation);
      const abandoned = await store.execute(absentCommand);
      assert.equal(abandoned.outcome, "Abandoned");
      assert.equal(abandoned.productReference, null);
      assert.equal(abandoned.versionReference, null);
      assert.equal(abandoned.aggregateVersion, null);
      assert.equal(abandoned.originalIntentDigest, null);
      let before = await counts();
      assert.equal(before.products, 0);
      assert.equal(before.operations, 0);
      assert.equal(before.audit, 1);
      assert.equal(before.outbox, 0);
      assert.deepEqual(await store.execute(absentCommand), abandoned);
      assert.deepEqual(await counts(), before);
      await assert.rejects(create.create(createInput(absentOperation, aggregate(200))));
      assert.equal(lastSqlCode, "23514");
      assert.deepEqual(await counts(), before);
      await assert.rejects(
        authoring(otherActor).execute({ ...absentCommand, actorReference: otherActor }),
        (error) => error.code === "CATALOG_IDEMPOTENCY_CONFLICT",
      );
      assert.deepEqual(await counts(), before);
      await transactions.run(async (tx) => {
        assert.equal(
          (
            await tx.query(
              "SELECT count(*)::int n FROM rms_catalog.product_authoring_operation_abandonment",
            )
          ).rows[0].n,
          1,
        );
        for (const setting of ["bop.tenant_id", "bop.brand_id"]) {
          await tx.query("SELECT set_config($1,$2,true)", [setting, id(999)]);
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int n FROM rms_catalog.product_authoring_operation_abandonment",
              )
            ).rows[0].n,
            0,
          );
          await tx.query("SELECT set_config($1,$2,true)", [
            setting,
            setting === "bop.tenant_id" ? tenant : brand,
          ]);
        }
      });
      // Actual owning Create and ReplaceDraft emit immutable snapshots and sources.
      const value = aggregate(300),
        createOperation = id(3010),
        createdInput = createInput(createOperation, value);
      await create.create(createdInput);
      const createReceipt = await store.execute(resolutionCommand("Create", createOperation));
      assert.equal(createReceipt.outcome, "Committed");
      assert.equal(createReceipt.productReference, value.productReference);
      assert.equal(createReceipt.versionReference, value.draft.versionReference);
      assert.equal(createReceipt.aggregateVersion, 1);
      assert.equal(
        createReceipt.originalIntentDigest,
        "sha256:" + createdInput.record.operationIntentHash,
      );
      before = await counts();
      assert.deepEqual(
        await store.execute(resolutionCommand("Create", createOperation)),
        createReceipt,
      );
      assert.deepEqual(await counts(), before);
      await assert.rejects(
        authoring(otherActor).execute(
          resolutionCommand("Create", createOperation, null, null, otherActor),
        ),
        (error) => error.code === "CATALOG_IDEMPOTENCY_CONFLICT",
      );
      assert.deepEqual(await counts(), before);
      clock = new Date(Date.parse(at) + 1).toISOString();
      const replaced = parseProductAggregate({
          ...value,
          aggregateVersion: 2,
          updatedAt: clock,
          draft: {
            ...value.draft,
            updatedAt: clock,
            localizedNames: { "en-CA": "Synthetic replacement" },
          },
        }),
        draftOperation = id(3020),
        replacedInput = draftInput(draftOperation, replaced, 1);
      await draft.commit(replacedInput);
      const draftCommand = resolutionCommand(
          "ReplaceDraft",
          draftOperation,
          value.productReference,
          1,
        ),
        draftReceipt = await store.execute(draftCommand);
      assert.equal(draftReceipt.outcome, "Committed");
      assert.equal(draftReceipt.productReference, value.productReference);
      assert.equal(draftReceipt.versionReference, value.draft.versionReference);
      assert.equal(draftReceipt.aggregateVersion, 2);
      assert.equal(
        draftReceipt.originalIntentDigest,
        "sha256:" + replacedInput.record.operationIntentHash,
      );
      before = await counts();
      assert.deepEqual(await store.execute(draftCommand), draftReceipt);
      assert.deepEqual(await counts(), before);
      await assert.rejects(
        authoring(otherActor).execute({ ...draftCommand, actorReference: otherActor }),
        (error) => error.code === "CATALOG_IDEMPOTENCY_CONFLICT",
      );
      assert.deepEqual(await counts(), before);
      // Both orderings use the actual Create/Draft owner and the same original
      // operation identity. Draft contenders start from a real persisted root.
      for (const [action, writerFirst, base] of [
        ["Create", true, 600],
        ["Create", false, 700],
        ["ReplaceDraft", true, 800],
        ["ReplaceDraft", false, 900],
      ]) {
        const initial = aggregate(base),
          operation = id(base + 10000);
        let input, write, command;
        if (action === "Create") {
          input = createInput(operation, initial);
          write = () => create.create(input);
          command = resolutionCommand("Create", operation);
        } else {
          await create.create(createInput(id(base + 20000), initial));
          const candidate = parseProductAggregate({
            ...initial,
            aggregateVersion: 2,
            updatedAt: clock,
            draft: {
              ...initial.draft,
              updatedAt: clock,
              localizedNames: { "en-CA": "Synthetic concurrent replacement" },
            },
          });
          input = draftInput(operation, candidate, 1);
          write = () => draft.commit(input);
          command = resolutionCommand("ReplaceDraft", operation, initial.productReference, 1);
        }
        await concurrentOriginal(store, write, command, writerFirst, {
          aggregate: input.record.aggregate,
          intentHash: input.record.operationIntentHash,
        });
      }
      before = await counts();
      // Late current authority loss rolls back the real fence and Audit chain.
      const late = resolutionCommand("Create", id(4000));
      afterWork = async () => {
        allowed = false;
      };
      await assert.rejects(
        store.execute(late),
        (error) => error.code === "CATALOG_PERMISSION_DENIED",
      );
      allowed = true;
      assert.deepEqual(await counts(), before);
      assert.equal((await store.execute(late)).outcome, "Abandoned");
      // Existing PublicationV1 terminal fence still excludes a late authoring write.
      const legacyOperation = id(5000),
        legacyEnvelope = {
          profile: "CatalogProductPublicationResolutionCommandV1",
          originalKind: "PublicationV1",
          originalCommand: publicationCommand(legacyOperation, replaced),
        };
      const legacy = await publicationResolution.execute(legacyEnvelope);
      assert.equal(legacy.resolution.outcome, "Abandoned");
      before = await counts();
      assert.deepEqual(
        (await publicationResolution.execute(legacyEnvelope)).resolution,
        legacy.resolution,
      );
      assert.deepEqual(await counts(), before);
      const next = parseProductAggregate({
        ...replaced,
        aggregateVersion: 3,
        updatedAt: clock,
        draft: { ...replaced.draft, updatedAt: clock },
      });
      await assert.rejects(draft.commit(draftInput(legacyOperation, next, 2)));
      assert.equal(lastSqlCode, "23514");
      assert.deepEqual(await counts(), before);
      // New null-Product authoring fence also excludes old publication namespace.
      await assert.rejects(
        publicationResolution.execute({
          profile: "CatalogProductPublicationResolutionCommandV1",
          originalKind: "PublicationV1",
          originalCommand: publicationCommand(absentOperation, replaced),
        }),
      );
      assert.equal(lastSqlCode, "23514");
      assert.deepEqual(await counts(), before);
      assert.deepEqual(
        await store.execute(resolutionCommand("Create", createOperation)),
        createReceipt,
      );
      assert.equal((await store.execute(draftCommand)).aggregateVersion, 2);
      assert.equal(digest(draftReceipt), digest(await store.execute(draftCommand)));
    } finally {
      if (roleCreated) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}
