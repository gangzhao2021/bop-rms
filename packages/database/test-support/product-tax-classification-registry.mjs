import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { CatalogError, parseProductAggregate } from "../../rms/catalog/src/contracts/product.ts";
import {
  catalogProductTaxClassificationRegistryDigest,
  catalogTaxClassificationRegistryEventId,
  catalogTaxClassificationRegistryRequest,
  parseCatalogTaxClassificationRegistryCommand,
  taxClassificationRegistryFields,
} from "../../rms/catalog/src/contracts/product-tax-classification-registry.ts";
import { createPostgresProductTaxClassificationRegistryStore } from "../../rms/catalog/src/infrastructure/persistence/product-tax-classification-registry-store.ts";
import { createPostgresProductCreationStore } from "../../rms/catalog/src/infrastructure/persistence/product-lifecycle-store.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";

const id = (n) => `01902460-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const countsSql = `SELECT
  (SELECT count(*)::int FROM rms_catalog.product_tax_classification_registry_record) registry,
  (SELECT count(*)::int FROM rms_catalog.product) products,
  (SELECT count(*)::int FROM rms_catalog.product_version) versions,
  (SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,
  (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,
  (SELECT count(*)::int FROM rms_catalog.product_source_commit) commits,
  (SELECT count(*)::int FROM platform_audit.audit_record) audit,
  (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
  (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
  (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;

/** Synthetic classification identities, clock and Actor/field authority only.
 * Registry registration/current reads, classification resolution, Product Draft
 * consumer writes, SQL/RLS, Audit/Outbox and outer COMMIT guards are actual owning
 * implementations. No tax rate, professional evidence, Quote or sale is asserted. */
export async function exerciseProductTaxClassificationRegistry() {
  await withIsolatedDatabase({ caseId: "wp2421_tax_registry" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_tax_registry_" + context.runId;
    assert.match(role, /^wp2421_tax_registry_[a-f0-9]+$/u);
    const tenant = id(1),
      brand = id(2),
      actor = id(3),
      at = new Date(Date.now() - 3600000).toISOString(),
      time = (offset) => new Date(Date.parse(at) + offset).toISOString(),
      guards = new WeakMap();
    let created = false,
      allowed = true,
      clock = at,
      fault = null,
      faultEvidence,
      afterWork = null,
      historyBytes = null,
      countReplayHistory = false,
      replayHistoryQueries = 0,
      consumerSequence = 10000;
    const seenAuthority = [];
    const counts = async (queryable = admin) => (await queryable.query(countsSql, [])).rows[0];
    const registerBeforeCommit = async (tx, guard, finalAssert) => {
      const pending = guards.get(tx);
      assert(pending, "Registry guards must belong to the actual open outer transaction");
      assert.equal(pending.phase, "work");
      assert.equal(typeof guard, "function");
      assert.equal(typeof finalAssert, "function");
      const evidence = {
        asyncEntered: 0,
        asyncReturned: 0,
        finalEntered: 0,
        finalReturned: 0,
        finalError: null,
      };
      pending.entries.push({
        evidence,
        async guard() {
          evidence.asyncEntered++;
          const result = await guard();
          evidence.asyncReturned++;
          return result;
        },
        finalAssert() {
          evidence.finalEntered++;
          try {
            const result = finalAssert();
            evidence.finalReturned++;
            return result;
          } catch (error) {
            evidence.finalError = error;
            throw error;
          }
        },
      });
    };
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        let tx;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          tx = {
            async query(sql, values = []) {
              if (
                countReplayHistory &&
                sql.includes("product_tax_classification_registry_record") &&
                (sql.startsWith("SELECT count(*)::text n,") ||
                  sql.includes("ORDER BY registry_version"))
              )
                replayHistoryQueries++;
              if (
                (fault === "audit" && sql.includes("INSERT INTO platform_audit.audit_record")) ||
                (fault === "outbox" && sql.includes("INSERT INTO platform_eventing.outbox_event"))
              ) {
                faultEvidence = await counts(client);
                throw Error("SYNTHETIC_REGISTRY_ARTIFACT_FAILURE");
              }
              const result = await client.query(sql, [...values]);
              // Negative-only transport-copy fault: the real stored history is
              // unchanged, and PostgreSQL still measures the incoming jsonb.
              if (
                historyBytes !== null &&
                sql.startsWith("SELECT count(*)::text n,") &&
                sql.includes("product_tax_classification_registry_record")
              )
                return {
                  ...result,
                  rows: result.rows.map((row) => ({ ...row, bytes: historyBytes })),
                };
              return result;
            },
          };
          const pending = { phase: "work", entries: [] };
          guards.set(tx, pending);
          const result = await work(tx);
          const hook = afterWork;
          if (hook !== null) {
            afterWork = null;
            await hook(tx);
          }
          // Execute the registered guard after ALL enclosing work, not merely
          // when withCurrentRegistry/execute finishes its own callback.
          pending.phase = "guards";
          for (const { guard } of pending.entries) assert.equal(await guard(), undefined);
          // Later asynchronous owners can consume an earlier owner's original
          // lease. Recheck all captured leases synchronously, without yielding
          // between these final assertions and submitting the actual COMMIT.
          pending.phase = "final";
          for (const { finalAssert } of pending.entries) assert.equal(finalAssert(), undefined);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          if (tx) guards.delete(tx);
          await client.end();
        }
      },
    };
    const authority = {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.deepEqual(input.requiredFields, taxClassificationRegistryFields);
        assert.equal(input.purposeCode, "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY");
        assert.equal(input.permission, "catalog.manage");
        assert.equal(input.actorReference, actor);
        assert(["User", "System"].includes(input.actorKind));
        assert(
          ["catalog.tax-classification.read", "catalog.tax-classification.manage"].includes(
            input.action,
          ),
        );
        seenAuthority.push({
          action: input.action,
          mode: input.mode,
          version: input.registry?.registryVersion ?? null,
        });
        if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    };
    const auditInput = (operation, actionCode, targetType, targetId, occurredAt, reasonCode) => ({
      auditId: id(Number.parseInt(operation.slice(-12), 16) + 500000),
      brandId: brand,
      actor: { type: "User", reference: actor },
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
    const options = {
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      clock: { now: () => clock },
      transactions,
      registerBeforeCommit,
      authority,
      audit: {
        create(command) {
          return auditInput(
            command.operationReference,
            "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
            "CatalogTaxClassificationRegistry",
            command.registry.registryReference,
            command.occurredAt,
            command.reasonCode,
          );
        },
      },
    };
    const store = createPostgresProductTaxClassificationRegistryStore(options);
    const observation = (duration = 5000) => ({
      originalIntentDigest: hash("synthetic complete Product consumer intent"),
      observedAt: clock,
      validUntil: new Date(Date.parse(clock) + duration).toISOString(),
    });
    const command = (registry, operation) => ({
      purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      operationReference: id(operation),
      expectedRegistryVersion: registry.registryVersion - 1,
      occurredAt: registry.registeredAt,
      reasonCode: "SYNTHETIC_CLASSIFICATION",
      registry,
    });
    const resolve = (classificationReference) =>
      store.withCurrentResolution(
        { classificationReference, ...observation() },
        async (resolution) => resolution,
      );
    const firstRegistry = {
      profile: "CatalogProductTaxClassificationRegistryV1",
      tenantReference: tenant,
      brandReference: brand,
      registryReference: id(10),
      versionReference: id(11),
      registryVersion: 1,
      defaultLocale: "en-CA",
      previousSnapshotDigest: null,
      registeredAt: at,
      definitions: [100, 101, 102].map((number) => ({
        classificationReference: id(number),
        code: "SYNTH_CLASS_" + number,
        localizedNames: { "en-CA": "Synthetic classification " + number },
        lifecycle: "Active",
      })),
      defaultClassificationReference: null,
    };
    const firstCommand = command(firstRegistry, 20);
    const consumerWrite = async (tx, classificationReference) => {
      const reference = ++consumerSequence,
        product = id(reference),
        operation = id(reference + 10000);
      const aggregate = parseProductAggregate({
        productReference: product,
        brandReference: brand,
        internalCode: "SYNTH_TAX_" + reference,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: clock,
        createdByActorReference: actor,
        updatedAt: clock,
        draft: {
          versionReference: id(reference + 20000),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic registry consumer" },
          taxClassificationReference: classificationReference,
          createdAt: clock,
          updatedAt: clock,
          skus: [],
          optionBindings: [],
        },
      });
      return createPostgresProductCreationStore({
        brandReference: brand,
        transactions: { run: (work) => work(tx) },
        // Synthetic Create authority: the registry read is the behavior under
        // test, not complete Product publication or real native IAM.
        authorize: async () => true,
      }).create({
        record: {
          action: "Create",
          operationReference: operation,
          operationIntentHash: sha256Hex(canonicalizeRfc8785(aggregate)),
          aggregate,
        },
        audit: auditInput(
          operation,
          "CATALOG_PRODUCT_CREATE",
          "CatalogProduct",
          product,
          clock,
          "SYNTHETIC_CLASSIFICATION_CONSUMER",
        ),
      });
    };
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      // UPDATE/DELETE are granted only to prove the append-only trigger rejects
      // them even when SQL privileges alone would permit the mutation.
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product_tax_classification_registry_record TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head,rms_catalog.product_source_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment TO " +
          role,
      );

      const empty = await counts();
      let missingConsumerCalled = false;
      await assert.rejects(
        store.withCurrentResolution(
          { classificationReference: id(100), ...observation() },
          async () => {
            missingConsumerCalled = true;
          },
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(missingConsumerCalled, false);
      allowed = false;
      await assert.rejects(store.execute(firstCommand), { code: "CATALOG_PERMISSION_DENIED" });
      allowed = true;
      assert.deepEqual(await counts(), empty);
      const first = await store.execute(firstCommand);
      assert.equal(first.status, "Applied");
      assert.deepEqual(first.registry, firstRegistry);
      assert.equal(
        first.snapshotDigest,
        catalogProductTaxClassificationRegistryDigest(firstRegistry),
      );
      const firstCounts = await counts();
      assert.equal(firstCounts.registry, 1);
      assert.equal(firstCounts.audit, 1);
      assert.equal(firstCounts.outbox, 1);
      const explicit = await resolve(id(100));
      assert.equal(explicit.selection, "Explicit");
      assert.equal(explicit.classificationReference, id(100));
      assert.equal(explicit.reason, "Resolved");
      assert.deepEqual(explicit.check, { code: "TaxResolution", outcome: "Pass" });
      assert.equal(explicit.taxCalculation, "NotEvaluated");
      assert.equal(explicit.snapshotDigest, first.snapshotDigest);
      const missingDefault = await resolve(null),
        unknown = await resolve(id(999));
      assert.equal(missingDefault.reason, "DefaultMissing");
      assert.deepEqual(missingDefault.check, { code: "TaxResolution", outcome: "HardError" });
      assert.equal(unknown.reason, "Unknown");
      assert.deepEqual(unknown.check, { code: "TaxResolution", outcome: "HardError" });

      clock = time(1000);
      const secondRegistry = {
        ...first.registry,
        versionReference: id(12),
        registryVersion: 2,
        previousSnapshotDigest: first.snapshotDigest,
        registeredAt: clock,
        definitions: first.registry.definitions.map((definition, index) => ({
          ...definition,
          lifecycle: index === 0 ? "Active" : index === 1 ? "Inactive" : "Retired",
        })),
        defaultClassificationReference: id(100),
      };
      const second = await store.execute(command(secondRegistry, 21));
      assert.equal(second.status, "Applied");
      assert.equal(second.registry.registryVersion, 2);
      const selectedDefault = await resolve(null);
      assert.equal(selectedDefault.selection, "BrandDefault");
      assert.equal(selectedDefault.classificationReference, id(100));
      assert.deepEqual(selectedDefault.check, { code: "TaxResolution", outcome: "Pass" });
      for (const [reference, reason] of [
        [id(101), "Inactive"],
        [id(102), "Retired"],
      ]) {
        const result = await resolve(reference);
        assert.equal(result.reason, reason);
        assert.equal(result.classificationReference, reference);
        assert.deepEqual(result.check, { code: "TaxResolution", outcome: "HardError" });
      }
      const baseline = await counts();
      assert.equal(baseline.registry, 2);
      assert.equal(baseline.audit, 2);
      assert.equal(baseline.outbox, 2);
      const nextRegistry = (versionReference = 13) => ({
        ...second.registry,
        versionReference: id(versionReference),
        registryVersion: 3,
        previousSnapshotDigest: second.snapshotDigest,
        registeredAt: clock,
      });

      // Real tentative registry/Audit/Outbox writes precede a late outer guard.
      for (const failure of ["permission", "expiry"]) {
        clock = time(2000);
        const attempted = command(nextRegistry(), 22);
        // The new write starts later than its original command. Its deadline
        // must remain occurredAt + 30s rather than being renewed at execution.
        if (failure === "expiry") clock = time(2500);
        let tentative = null;
        afterWork = async (tx) => {
          tentative = await counts(tx);
          if (failure === "permission") allowed = false;
          else clock = time(32000);
        };
        await assert.rejects(store.execute(attempted), {
          code:
            failure === "permission"
              ? "CATALOG_PERMISSION_DENIED"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        allowed = true;
        clock = time(2000);
        assert(tentative, "The actual new registry result must reach the outer COMMIT boundary");
        assert.equal(tentative.registry, baseline.registry + 1);
        assert.equal(tentative.audit, baseline.audit + 1);
        assert.equal(tentative.outbox, baseline.outbox + 1);
        assert.deepEqual(await counts(), baseline);
      }

      // Real Product creation returns inside the source consumer. Permission or
      // the original shorter read deadline fails only after that consumer ends.
      for (const failure of ["permission", "expiry"]) {
        clock = time(3000);
        const request = { classificationReference: null, ...observation(1000) };
        let returnedCreate = null,
          tentative = null,
          seenResolution = null;
        afterWork = async (tx) => {
          tentative = await counts(tx);
          if (failure === "permission") allowed = false;
          else clock = request.validUntil;
        };
        await assert.rejects(
          store.withCurrentResolution(request, async (resolution, tx) => {
            seenResolution = resolution;
            returnedCreate = await consumerWrite(tx, resolution.classificationReference);
            return returnedCreate;
          }),
          {
            code:
              failure === "permission"
                ? "CATALOG_PERMISSION_DENIED"
                : "CATALOG_DEPENDENCY_UNAVAILABLE",
          },
        );
        allowed = true;
        clock = time(3000);
        assert(returnedCreate, "The owning Product Create must return before the final refusal");
        assert.equal(returnedCreate.action, "Create");
        assert.equal(seenResolution.request.validUntil, request.validUntil);
        assert.equal(returnedCreate.aggregate.draft.taxClassificationReference, id(100));
        assert(tentative, "The original read lease must guard the enclosing COMMIT");
        for (const key of [
          "products",
          "versions",
          "operations",
          "snapshots",
          "commits",
          "audit",
          "outbox",
        ])
          assert.equal(tentative[key], baseline[key] + 1, "Tentative Product consumer " + key);
        assert.equal(tentative.registry, baseline.registry);
        assert.deepEqual(await counts(), baseline);
      }

      // The Tax async guard succeeds first. A later owner's awaited guard then
      // reaches the exact original read deadline; only the synchronous final
      // Tax assertion can still prevent this real Product write from committing.
      clock = time(3500);
      const laterGuardRequest = { classificationReference: null, ...observation(1000) };
      let laterGuardCreate = null,
        laterGuardTentative = null,
        laterTaxGuardEvidence = null,
        laterGuardStart = null,
        laterGuardCalls = 0,
        laterFinalCalls = 0;
      await assert.rejects(
        store.withCurrentResolution(laterGuardRequest, async (resolution, tx) => {
          laterTaxGuardEvidence = guards.get(tx)?.entries[0]?.evidence ?? null;
          laterGuardCreate = await consumerWrite(tx, resolution.classificationReference);
          await registerBeforeCommit(
            tx,
            async () => {
              laterGuardCalls++;
              laterGuardStart = clock;
              laterGuardTentative = await counts(tx);
              clock = laterGuardRequest.validUntil;
            },
            () => {
              laterFinalCalls++;
            },
          );
          return laterGuardCreate;
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert(laterGuardCreate, "Actual Product Create must precede the later async guard");
      assert.equal(laterGuardCreate.action, "Create");
      assert.equal(laterGuardCreate.aggregate.draft.taxClassificationReference, id(100));
      assert.equal(laterGuardCalls, 1, "The earlier Tax async guard must have completed");
      assert.equal(laterGuardStart, laterGuardRequest.observedAt);
      assert.equal(clock, laterGuardRequest.validUntil);
      assert.equal(laterFinalCalls, 0, "The earlier Tax final assertion must refuse expiry");
      assert(laterTaxGuardEvidence, "Capture the actual Tax guard at registration");
      assert.equal(laterTaxGuardEvidence.asyncEntered, 1);
      assert.equal(laterTaxGuardEvidence.asyncReturned, 1);
      assert.equal(laterTaxGuardEvidence.finalEntered, 1);
      assert.equal(laterTaxGuardEvidence.finalReturned, 0);
      assert(laterTaxGuardEvidence.finalError instanceof CatalogError);
      assert.equal(laterTaxGuardEvidence.finalError.code, "CATALOG_DEPENDENCY_UNAVAILABLE");
      assert(laterGuardTentative, "Actual tentative writes must survive until the later guard");
      for (const key of [
        "products",
        "versions",
        "operations",
        "snapshots",
        "commits",
        "audit",
        "outbox",
      ])
        assert.equal(laterGuardTentative[key], baseline[key] + 1, "Later guard consumer " + key);
      assert.equal(laterGuardTentative.registry, baseline.registry);
      assert.notDeepEqual(laterGuardTentative.heads, baseline.heads);
      assert.notDeepEqual(laterGuardTentative.chains, baseline.chains);
      assert.deepEqual(await counts(), baseline);

      for (const artifact of ["audit", "outbox"]) {
        clock = time(4000);
        fault = artifact;
        faultEvidence = null;
        await assert.rejects(store.execute(command(nextRegistry(), 23)), {
          code: "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        fault = null;
        assert(faultEvidence, "Actual registry insertion must precede artifact failure");
        assert.equal(faultEvidence.registry, baseline.registry + 1);
        assert.equal(faultEvidence.audit, baseline.audit + (artifact === "outbox" ? 1 : 0));
        assert.equal(faultEvidence.outbox, baseline.outbox);
        assert.deepEqual(await counts(), baseline);
      }
      const budgetCommand = parseCatalogTaxClassificationRegistryCommand(
          command(nextRegistry(), 24),
        ),
        commandJson = canonicalizeRfc8785(catalogTaxClassificationRegistryRequest(budgetCommand)),
        registryJson = canonicalizeRfc8785(budgetCommand.registry),
        compactBytes = Buffer.byteLength(commandJson) + Buffer.byteLength(registryJson),
        actualBytes = (
          await admin.query(
            "SELECT (octet_length($1::jsonb::text)+octet_length($2::jsonb::text))::int bytes",
            [commandJson, registryJson],
          )
        ).rows[0].bytes;
      assert(actualBytes > compactBytes);
      historyBytes = String(8388608 - compactBytes);
      await assert.rejects(store.execute(catalogTaxClassificationRegistryRequest(budgetCommand)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      historyBytes = null;
      assert.deepEqual(await counts(), baseline);

      clock = time(5000);
      const raced = await Promise.allSettled([
        store.execute(command(nextRegistry(13), 25)),
        store.execute(command(nextRegistry(14), 26)),
      ]);
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = raced.find((result) => result.status === "rejected");
      assert(rejected);
      assert.equal(rejected.reason.code, "CATALOG_VERSION_CONFLICT");
      const latest = await store.withCurrentRegistry(observation(), async (source) => source);
      assert.equal(latest.registry.registryVersion, 3);
      const afterRace = await counts();
      assert.equal(afterRace.registry, baseline.registry + 1);
      assert.equal(afterRace.audit, baseline.audit + 1);
      assert.equal(afterRace.outbox, baseline.outbox + 1);

      clock = time(120000);
      seenAuthority.length = 0;
      countReplayHistory = true;
      const replay = await store.execute(firstCommand);
      countReplayHistory = false;
      assert.deepEqual(replay, { ...first, status: "Replayed" });
      assert.equal(
        replayHistoryQueries,
        0,
        "Original recovery must not acquire the current registry history",
      );
      assert(seenAuthority.some((entry) => entry.mode === "Replay" && entry.version === 1));
      assert.equal(
        seenAuthority.some((entry) => entry.mode === "Register"),
        false,
      );
      assert.deepEqual(await counts(), afterRace);
      await assert.rejects(store.execute({ ...firstCommand, reasonCode: "CHANGED" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      allowed = false;
      await assert.rejects(store.execute(firstCommand), { code: "CATALOG_PERMISSION_DENIED" });
      allowed = true;
      assert.deepEqual(await counts(), afterRace);
      const system = createPostgresProductTaxClassificationRegistryStore({
        ...options,
        actorKind: "System",
      });
      assert.equal(
        (await system.withCurrentRegistry(observation(), async (source) => source)).registry
          .registryVersion,
        3,
      );
      await assert.rejects(system.execute(firstCommand), { code: "CATALOG_PERMISSION_DENIED" });

      for (const operation of ["UPDATE", "DELETE"]) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          await assert.rejects(
            admin.query(
              operation === "UPDATE"
                ? "UPDATE rms_catalog.product_tax_classification_registry_record SET data_classification='ConfigurationMetadata'"
                : "DELETE FROM rms_catalog.product_tax_classification_registry_record",
            ),
            { code: "55000" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      const blockedCommand = parseCatalogTaxClassificationRegistryCommand(
        command(
          {
            ...latest.registry,
            registryVersion: 4,
            versionReference: id(15),
            previousSnapshotDigest: latest.snapshotDigest,
            registeredAt: clock,
          },
          27,
        ),
      );
      for (const [scopeTenant, scopeBrand, scopeStore] of [
        [id(998), brand, ""],
        [tenant, id(999), ""],
        [tenant, brand, id(99)],
      ]) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scopeTenant, scopeBrand, scopeStore],
          );
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::int n FROM rms_catalog.product_tax_classification_registry_record",
              )
            ).rows[0].n,
            0,
          );
          await assert.rejects(
            admin.query(
              "INSERT INTO rms_catalog.product_tax_classification_registry_record(operation_id,tenant_id,brand_id,registry_id,version_id,registry_version,actor_id,intent_digest,snapshot_digest,occurred_at,command_json,snapshot_json,event_id,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)",
              [
                blockedCommand.operationReference,
                tenant,
                brand,
                blockedCommand.registry.registryReference,
                blockedCommand.registry.versionReference,
                blockedCommand.registry.registryVersion,
                actor,
                blockedCommand.intentDigest,
                blockedCommand.snapshotDigest,
                blockedCommand.occurredAt,
                canonicalizeRfc8785(catalogTaxClassificationRegistryRequest(blockedCommand)),
                canonicalizeRfc8785(blockedCommand.registry),
                catalogTaxClassificationRegistryEventId(blockedCommand),
                id(500027),
              ],
            ),
            { code: "42501" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      assert.deepEqual(await counts(), afterRace);
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}
