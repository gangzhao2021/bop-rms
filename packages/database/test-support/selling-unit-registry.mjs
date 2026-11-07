import assert from "node:assert/strict";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createPostgresSellingUnitRegistryStore,
  catalogSellingUnitRegistryDigest,
  catalogSellingUnitDefinitionsDigest,
  parseCatalogSellingUnitRegistryCommand,
  sellingUnitRegistryFields,
  sellingUnitRegistrationResolutionFields,
  createPostgresProductCreationStore,
  parseProductAggregate,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";
const id = (n) => "01902421-5000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// Synthetic definitions/current authority/clock. Actual owner SQL/RLS,
// append-only registry, SKU consumer, Audit/Outbox and outer COMMIT execute.
export async function exerciseSellingUnitRegistry() {
  await withIsolatedDatabase({ caseId: "wp2421_unit_registry" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_unit_registry_" + context.runId;
    assert.match(role, /^wp2421_unit_registry_[a-f0-9]+$/u);
    const tenant = id(1),
      brand = id(2),
      actor = id(3),
      at = new Date(Date.now() - 3600000).toISOString(),
      guards = new WeakMap();
    let clock = at,
      allowed = true,
      afterWork = null,
      created = false,
      raceCapture = null;
    const audit = (operation, actionCode, targetType, targetId, occurredAt, reasonCode) => ({
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
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        let tx;
        const capture = raceCapture,
          slot = capture ? capture.started++ : null;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          tx = { query: (sql, values = []) => client.query(sql, [...values]) };
          if (capture && slot !== null)
            capture.pids[slot] = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          const entries = [];
          guards.set(tx, entries);
          const result = await work(tx);
          if (afterWork) {
            const hook = afterWork;
            afterWork = null;
            await hook(tx);
          }
          for (const entry of entries) await entry.guard();
          for (const entry of entries) entry.finalAssert();
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
    const options = {
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      clock: { now: () => clock },
      transactions,
      registerBeforeCommit: async (tx, guard, finalAssert) => {
        const entries = guards.get(tx);
        assert(entries);
        entries.push({ guard, finalAssert });
      },
      authority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.deepEqual(
            input.requiredFields,
            input.mode === "Resolve"
              ? sellingUnitRegistrationResolutionFields
              : sellingUnitRegistryFields,
          );
          assert.equal(input.permission, "catalog.manage");
          assert.deepEqual(
            input.requiredPermissions,
            input.mode === "Read" ||
              input.mode === "Replay" ||
              input.mode === "Intent" ||
              input.mode === "Resolve"
              ? ["catalog.manage"]
              : [
                  "catalog.manage",
                  "catalog.product.read",
                  "catalog.product.history.read",
                  "catalog.sku.read",
                ],
          );
          assert.equal(input.action, "catalog.manage");
          assert.equal(input.purposeCode, "CATALOG_SELLING_UNIT_REGISTRY");
          assert.equal(input.actorReference, actor);
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      },
      audit: {
        create: (command) =>
          audit(
            command.operationReference,
            "CATALOG_SELLING_UNIT_REGISTRY_RECORDED",
            "CatalogSellingUnitRegistry",
            command.registry.registryReference,
            command.occurredAt,
            command.reasonCode,
          ),
      },
    };
    const store = createPostgresSellingUnitRegistryStore(options);
    const registry = {
      profile: "CatalogSellingUnitRegistryV1",
      tenantReference: tenant,
      brandReference: brand,
      registryReference: id(10),
      versionReference: id(11),
      registryVersion: 1,
      previousSnapshotDigest: null,
      registeredAt: at,
      defaultLocale: "en-CA",
      units: [
        {
          unitReference: id(12),
          code: "SYNTHETIC",
          semanticDefinition: "Synthetic registered package",
          quantityDecimalPlaces: 2,
          localizedNames: { "en-CA": "Synthetic package" },
          lifecycle: "Active",
        },
      ],
    };
    const command = (snapshot, operation) => ({
      purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      operationReference: id(operation),
      expectedRegistryVersion: snapshot.registryVersion - 1,
      occurredAt: snapshot.registeredAt,
      reasonCode: "SYNTHETIC",
      registry: snapshot,
    });
    const observation = () => ({
      originalIntentDigest: hash("Synthetic original consumer"),
      observedAt: clock,
      validUntil: new Date(Date.parse(clock) + 5000).toISOString(),
    });
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_catalog.selling_unit_registry_record) registry,(SELECT count(*)::int FROM rms_catalog.product) products,(SELECT count(*)::int FROM platform_audit.audit_record) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) outbox",
        )
      ).rows[0];
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
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_catalog.selling_unit_registry_record,rms_catalog.selling_unit_registration_abandonment TO " +
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
      assert.deepEqual(await counts(), { registry: 0, products: 0, audit: 0, outbox: 0 });
      const absent = await store.withCurrentInspection(observation(), async (source) => source);
      assert.equal(absent.presence, "Absent");
      assert.equal(absent.registry, null);
      assert.equal(absent.assignments.length, 0);
      const initial = command(registry, 20);
      assert.equal((await store.execute(initial)).status, "Applied");
      assert.deepEqual(await counts(), { registry: 1, products: 0, audit: 1, outbox: 1 });
      assert.equal((await store.execute(initial)).status, "Replayed");
      assert.deepEqual(await counts(), { registry: 1, products: 0, audit: 1, outbox: 1 });
      await assert.rejects(
        store.execute({ ...initial, reasonCode: "OTHER" }),
        (error) => error.code === "CATALOG_IDEMPOTENCY_CONFLICT",
      );
      for (const sql of [
        "UPDATE rms_catalog.selling_unit_registry_record SET registry_version=registry_version",
        "DELETE FROM rms_catalog.selling_unit_registry_record",
        "TRUNCATE rms_catalog.selling_unit_registry_record",
      ]) {
        await assert.rejects(
          transactions.run((tx) => tx.query(sql)),
          (error) => error.code === "55000",
        );
      }
      await transactions.run(async (tx) => {
        assert.equal(
          (await tx.query("SELECT count(*)::int n FROM rms_catalog.selling_unit_registry_record"))
            .rows[0].n,
          1,
        );
        for (const setting of ["bop.tenant_id", "bop.brand_id"]) {
          await tx.query("SELECT set_config($1,$2,true)", [setting, id(99)]);
          assert.equal(
            (await tx.query("SELECT count(*)::int n FROM rms_catalog.selling_unit_registry_record"))
              .rows[0].n,
            0,
          );
          await tx.query("SELECT set_config($1,$2,true)", [
            setting,
            setting === "bop.tenant_id" ? tenant : brand,
          ]);
        }
      });
      const aggregate = parseProductAggregate({
        productReference: id(100),
        brandReference: brand,
        internalCode: "SYNTHETIC_UNIT_CONSUMER",
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: at,
        createdByActorReference: actor,
        updatedAt: at,
        draft: {
          versionReference: id(101),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic consumer" },
          taxClassificationReference: null,
          createdAt: at,
          updatedAt: at,
          optionBindings: [],
          skus: [
            {
              skuReference: id(102),
              productReference: id(100),
              brandReference: brand,
              skuCode: "SYNTHETIC_SKU",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic SKU" },
              variantSelections: [],
              unitOfSale: "SYNTHETIC",
              unitQuantity: "1.25",
              createdAt: at,
              createdByActorReference: actor,
            },
          ],
        },
      });
      const candidate = {
        tenantReference: tenant,
        brandReference: brand,
        productReference: id(100),
        operationReference: id(103),
        purposeCode: "CATALOG_PRODUCT_CREATE",
        aggregate,
        ...observation(),
      };
      for (const [code, quantity] of [
        ["UNKNOWN", "1"],
        ["SYNTHETIC", "0"],
        ["SYNTHETIC", "1.234"],
      ]) {
        const value = {
          ...aggregate,
          draft: {
            ...aggregate.draft,
            skus: aggregate.draft.skus.map((sku) => ({
              ...sku,
              unitOfSale: code,
              unitQuantity: quantity,
            })),
          },
        };
        await assert.rejects(
          store.withRegisteredProductSkuQuantities(
            { ...candidate, aggregate: value },
            async () => true,
          ),
        );
      }
      await store.withRegisteredProductSkuQuantities(candidate, async (source, tx) => {
        assert.equal(source.snapshotDigest, catalogSellingUnitRegistryDigest(registry));
        await createPostgresProductCreationStore({
          brandReference: brand,
          transactions: { run: (work) => work(tx) },
          authorize: async () => true,
        }).create({
          record: {
            action: "Create",
            operationReference: id(103),
            operationIntentHash: sha256Hex(canonicalizeRfc8785(aggregate)),
            aggregate,
          },
          audit: audit(
            id(103),
            "CATALOG_PRODUCT_CREATE",
            "CatalogProduct",
            id(100),
            at,
            "SYNTHETIC_CONSUMER",
          ),
        });
        assert.equal(source.request.aggregate.aggregateVersion, 1);
        assert.equal(source.registry.registryVersion, 1);
      });
      assert.deepEqual(await counts(), { registry: 1, products: 1, audit: 2, outbox: 2 });
      const next = {
        ...registry,
        versionReference: id(21),
        registryVersion: 2,
        previousSnapshotDigest: catalogSellingUnitRegistryDigest(registry),
      };
      await assert.rejects(
        store.execute(
          command(
            { ...next, units: next.units.map((unit) => ({ ...unit, quantityDecimalPlaces: 3 })) },
            22,
          ),
        ),
        (error) => error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      const before = await counts();
      afterWork = async () => {
        allowed = false;
      };
      await assert.rejects(
        store.execute(command(next, 23)),
        (error) => error.code === "CATALOG_PERMISSION_DENIED",
      );
      allowed = true;
      assert.deepEqual(await counts(), before);
      assert.equal((await store.execute(command(next, 23))).status, "Applied");
      assert.deepEqual(await counts(), { registry: 2, products: 1, audit: 3, outbox: 3 });

      // Actual legacy Brand has owning SKU receipts but no registration. The
      // explicit semantic confirmation below is synthetic operator input;
      // persisted original history/coverage and registration are actual SQL.
      const legacyBrand = id(400),
        legacyRegistry = {
          ...registry,
          brandReference: legacyBrand,
          registryReference: id(401),
          versionReference: id(402),
        },
        legacyStore = createPostgresSellingUnitRegistryStore({
          ...options,
          brandReference: legacyBrand,
          audit: { create: (value) => ({ ...options.audit.create(value), brandId: legacyBrand }) },
        }),
        legacyValue = parseProductAggregate({
          ...aggregate,
          brandReference: legacyBrand,
          productReference: id(403),
          internalCode: "SYNTHETIC_LEGACY_UNIT",
          draft: {
            ...aggregate.draft,
            versionReference: id(404),
            skus: aggregate.draft.skus.map((sku) => ({
              ...sku,
              brandReference: legacyBrand,
              productReference: id(403),
              skuReference: id(405),
              skuCode: "SYNTHETIC_LEGACY_SKU",
            })),
          },
        }),
        legacyCreate = createPostgresProductCreationStore({
          brandReference: legacyBrand,
          transactions,
          authorize: async () => true,
        });
      const createLegacy = async (value, operation) =>
        legacyCreate.create({
          record: {
            action: "Create",
            operationReference: operation,
            operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
            aggregate: value,
          },
          audit: {
            ...audit(
              operation,
              "CATALOG_PRODUCT_CREATE",
              "CatalogProduct",
              value.productReference,
              at,
              "SYNTHETIC_LEGACY",
            ),
            brandId: legacyBrand,
          },
        });
      await createLegacy(legacyValue, id(410));
      const legacyCommand = { ...command(legacyRegistry, 420), brandReference: legacyBrand },
        inspection = await legacyStore.withCurrentInspection(
          observation(),
          async (source) => source,
        );
      assert.equal(inspection.presence, "Absent");
      assert.equal(inspection.assignments.length, 2);
      assert.deepEqual(inspection.assignments.map((row) => row.source).sort(), [
        "CurrentSku",
        "OperationSnapshot",
      ]);
      assert(
        inspection.assignments.every(
          (row) => row.unitQuantity === "1.25" && row.skuReference === id(405),
        ),
      );
      const baseline = await counts();
      await assert.rejects(
        legacyStore.execute(legacyCommand),
        (error) => error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      assert.deepEqual(await counts(), baseline);
      const confirm = (source, definitions) => ({
          profile: "CatalogSellingUnitBootstrapConfirmationV1",
          historyDigest: source.historyDigest,
          definitionsDigest: catalogSellingUnitDefinitionsDigest(definitions),
          confirmations: [
            {
              unitCode: "SYNTHETIC",
              semanticDefinition: definitions.units[0].semanticDefinition,
              confirmed: true,
            },
          ],
        }),
        narrow = {
          ...legacyRegistry,
          units: legacyRegistry.units.map((unit) => ({ ...unit, quantityDecimalPlaces: 1 })),
        };
      await assert.rejects(
        legacyStore.execute({
          ...legacyCommand,
          registry: narrow,
          bootstrapConfirmation: confirm(inspection, narrow),
        }),
        (error) => error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      assert.deepEqual(await counts(), baseline);
      const otherValue = parseProductAggregate({
        ...legacyValue,
        productReference: id(430),
        internalCode: "SYNTHETIC_LEGACY_SECOND",
        draft: {
          ...legacyValue.draft,
          versionReference: id(431),
          skus: legacyValue.draft.skus.map((sku) => ({
            ...sku,
            productReference: id(430),
            skuReference: id(432),
            skuCode: "SYNTHETIC_LEGACY_SECOND_SKU",
          })),
        },
      });
      await createLegacy(otherValue, id(433));
      const afterSecond = await counts();
      await assert.rejects(
        legacyStore.execute({
          ...legacyCommand,
          bootstrapConfirmation: confirm(inspection, legacyRegistry),
        }),
        (error) => error.code === "CATALOG_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), afterSecond);
      const currentInspection = await legacyStore.withCurrentInspection(
          observation(),
          async (source) => source,
        ),
        confirmed = {
          ...legacyCommand,
          bootstrapConfirmation: confirm(currentInspection, legacyRegistry),
        },
        originalHistory = (
          await admin.query(
            "SELECT operation_id,snapshot_json FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 ORDER BY operation_id",
            [legacyBrand],
          )
        ).rows;
      assert.equal(currentInspection.assignments.length, 4);
      afterWork = async () => {
        allowed = false;
      };
      await assert.rejects(
        legacyStore.execute(confirmed),
        (error) => error.code === "CATALOG_PERMISSION_DENIED",
      );
      allowed = true;
      assert.deepEqual(await counts(), afterSecond);
      assert.equal((await legacyStore.execute(confirmed)).status, "Applied");
      const recorded = await counts();
      assert.equal(recorded.registry, afterSecond.registry + 1);
      assert.equal(recorded.audit, afterSecond.audit + 1);
      assert.equal(recorded.outbox, afterSecond.outbox + 1);
      assert.equal(recorded.products, afterSecond.products);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT operation_id,snapshot_json FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 ORDER BY operation_id",
            [legacyBrand],
          )
        ).rows,
        originalHistory,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT command_json->'bootstrapConfirmation' confirmation FROM rms_catalog.selling_unit_registry_record WHERE brand_id=$1",
            [legacyBrand],
          )
        ).rows[0].confirmation,
        confirmed.bootstrapConfirmation,
      );
      assert.equal((await legacyStore.execute(confirmed)).status, "Replayed");
      assert.deepEqual(await counts(), recorded);
      const present = await legacyStore.withCurrentInspection(
        observation(),
        async (source) => source,
      );
      assert.equal(present.presence, "Present");
      assert.equal(present.registry.registryVersion, 1);
      assert.equal(present.historyDigest, currentInspection.historyDigest);
      // Real two-backend arbitration on the existing isolated UoW. IAM remains
      // the explicitly controlled holder above; the separate HTTP helper uses
      // actual persisted Session/IAM. No delay is accepted as blocking evidence.
      const resolutionRequest = (scopeBrand, operation) => ({
        profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
        tenantReference: tenant,
        brandReference: scopeBrand,
        actorReference: actor,
        action: "Create",
        operationReference: operation,
        expectedRegistryVersion: 0,
      });
      const recoveryCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.selling_unit_registry_record) registry,(SELECT count(*)::int FROM rms_catalog.selling_unit_registration_abandonment) fences,(SELECT count(*)::int FROM platform_audit.audit_record) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) outbox",
          )
        ).rows[0];
      const bounded = async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("Synthetic unit arbitration timed out")),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      for (const writerFirst of [true, false]) {
        const base = writerFirst ? 1000 : 2000,
          scopeBrand = id(base),
          operation = id(base + 4),
          value = {
            ...registry,
            brandReference: scopeBrand,
            registryReference: id(base + 1),
            versionReference: id(base + 2),
          },
          input = {
            ...command(value, base + 4),
            brandReference: scopeBrand,
            reasonCode: "PRODUCT_CREATE_UNITS",
          },
          request = resolutionRequest(scopeBrand, operation),
          raceStore = createPostgresSellingUnitRegistryStore({
            ...options,
            brandReference: scopeBrand,
            audit: {
              create: (command) => ({ ...options.audit.create(command), brandId: scopeBrand }),
              createAbandonment: ({ command, resolution }) => ({
                ...audit(
                  command.operationReference,
                  "CATALOG_SELLING_UNIT_REGISTRATION_ABANDONED",
                  "SellingUnitRegistrationOperation",
                  command.operationReference,
                  resolution.recordedAt,
                  "ORIGINAL_OPERATION_ABANDONED",
                ),
                brandId: scopeBrand,
              }),
            },
          }),
          baseline = await recoveryCounts(),
          held = Promise.withResolvers(),
          release = Promise.withResolvers(),
          capture = { started: 0, pids: [] };
        const settled = (work) =>
          work().then(
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
          first = settled(
            writerFirst
              ? () => raceStore.execute(input)
              : () => raceStore.resolveRegistrationOperation(request),
          );
          await bounded(held.promise);
          second = settled(
            writerFirst
              ? () => raceStore.resolveRegistrationOperation(request)
              : () => raceStore.execute(input),
          );
          const deadline = Date.now() + 10000;
          let blocked = false;
          while (Date.now() < deadline && !blocked) {
            if (capture.pids[1]) {
              const row = (
                await admin.query({
                  text: "SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1",
                  values: [capture.pids[1]],
                  query_timeout: 10000,
                })
              ).rows[0];
              blocked = row?.wait_event_type === "Lock" && row.blockers.includes(capture.pids[0]);
            } else await admin.query({ text: "SELECT 1", query_timeout: 10000 });
          }
          assert.equal(capture.started, 2);
          assert.equal(blocked, true, "Contender must actually wait on original holder backend");
          release.resolve();
          const winner = await bounded(first);
          if (winner.error) throw winner.error;
          const loser = await bounded(second);
          raceCapture = null;
          if (writerFirst) {
            if (loser.error) throw loser.error;
            assert.equal(winner.value.status, "Applied");
            assert.equal(loser.value.outcome, "Committed");
            assert.equal(loser.value.recordedAt, input.occurredAt);
            assert.equal(loser.value.registryReference, value.registryReference);
            assert.equal(loser.value.registryVersion, 1);
            assert.deepEqual(await raceStore.resolveRegistrationOperation(request), loser.value);
          } else {
            assert.equal(winner.value.outcome, "Abandoned");
            assert.equal(loser.error?.code, "CATALOG_IDEMPOTENCY_CONFLICT");
            assert.deepEqual(await raceStore.resolveRegistrationOperation(request), winner.value);
          }
          const after = await recoveryCounts();
          assert.equal(after.registry, baseline.registry + (writerFirst ? 1 : 0));
          assert.equal(after.fences, baseline.fences + (writerFirst ? 0 : 1));
          assert.equal(after.audit, baseline.audit + 1);
          assert.equal(after.outbox, baseline.outbox + (writerFirst ? 1 : 0));
          const foreign = createPostgresSellingUnitRegistryStore({
            ...options,
            brandReference: scopeBrand,
            actorReference: id(9999),
            authority: {
              async holdUntilTransactionCompletes(_tx, input) {
                assert.equal(input.actorReference, id(9999));
                assert.equal(input.mode, "Resolve");
                assert.equal(input.permission, "catalog.manage");
                assert.equal(input.action, "catalog.manage");
                assert.equal(input.purposeCode, "CATALOG_SELLING_UNIT_REGISTRY");
                assert.deepEqual(input.requiredFields, sellingUnitRegistrationResolutionFields);
                assert.deepEqual(input.requiredPermissions, ["catalog.manage"]);
                if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              },
            },
          });
          await assert.rejects(
            foreign.resolveRegistrationOperation({ ...request, actorReference: id(9999) }),
            (error) => error.code === "CATALOG_PERMISSION_DENIED",
          );
          assert.deepEqual(await recoveryCounts(), after);
          if (!writerFirst) {
            for (const sql of [
              "UPDATE rms_catalog.selling_unit_registration_abandonment SET recorded_at=recorded_at",
              "DELETE FROM rms_catalog.selling_unit_registration_abandonment",
              "TRUNCATE rms_catalog.selling_unit_registration_abandonment",
            ]) {
              await assert.rejects(
                transactions.run(async (tx) => {
                  await tx.query(
                    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
                    [tenant, scopeBrand],
                  );
                  assert.equal(
                    (
                      await tx.query(
                        "SELECT count(*)::int n FROM rms_catalog.selling_unit_registration_abandonment WHERE operation_id=$1",
                        [operation],
                      )
                    ).rows[0].n,
                    1,
                  );
                  return tx.query(sql);
                }),
                (error) => error.code === "55000",
              );
            }
            await transactions.run(async (tx) => {
              for (const setting of ["bop.tenant_id", "bop.brand_id"]) {
                await tx.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
                  [tenant, scopeBrand],
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT count(*)::int n FROM rms_catalog.selling_unit_registration_abandonment",
                    )
                  ).rows[0].n,
                  1,
                );
                await tx.query("SELECT set_config($1,$2,true)", [setting, id(9999)]);
                assert.equal(
                  (
                    await tx.query(
                      "SELECT count(*)::int n FROM rms_catalog.selling_unit_registration_abandonment",
                    )
                  ).rows[0].n,
                  0,
                );
              }
            });
            // Trigger guard is independent from the producer's friendly refusal:
            // a direct delayed registry INSERT cannot cross the permanent fence.
            await assert.rejects(
              transactions.run(async (tx) => {
                await tx.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
                  [tenant, scopeBrand],
                );
                const original = parseCatalogSellingUnitRegistryCommand(input);
                return tx.query(
                  "INSERT INTO rms_catalog.selling_unit_registry_record(operation_id,tenant_id,brand_id,registry_id,version_id,registry_version,actor_id,intent_digest,snapshot_digest,occurred_at,command_json,snapshot_json,event_id,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)",
                  [
                    operation,
                    tenant,
                    scopeBrand,
                    value.registryReference,
                    value.versionReference,
                    value.registryVersion,
                    actor,
                    original.intentDigest,
                    original.snapshotDigest,
                    input.occurredAt,
                    canonicalizeRfc8785(input),
                    canonicalizeRfc8785(value),
                    id(base + 8),
                    id(base + 9),
                  ],
                );
              }),
              (error) => error.code === "23514",
            );
            assert.deepEqual(await recoveryCounts(), after);
          }
        } finally {
          release.resolve();
          await Promise.all([first, second].filter(Boolean));
          raceCapture = null;
          afterWork = null;
        }
      }
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}
