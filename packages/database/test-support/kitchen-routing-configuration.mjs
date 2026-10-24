import assert from "node:assert/strict";
import {
  createPostgresKitchenRoutingConfigurationStore,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";

/** Real Kitchen configuration write/read; explicit synthetic operator authority and Store facts. */
export async function exerciseKitchenRoutingConfiguration({
  admin,
  role,
  runner,
  scope,
  at,
  id,
  hash,
}) {
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_kitchen.kitchen_routing_configuration TO " + role,
  );
  let readAllowed = true;
  let writeAllowed = true;
  let configurationAllowed = true;
  let validations = 0;
  const store = createPostgresKitchenRoutingConfigurationStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    sha256: hash,
    authorizeRead: async () => readAllowed,
    authorizeWrite: async () => writeAllowed,
    validateConfiguration: async () => {
      validations++;
      return configurationAllowed;
    },
    audit: async (record) => ({
      auditId: id(9400 + record.configuration.evidenceVersion),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: record.actorReference },
      actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
      targetType: "KitchenRoutingConfiguration",
      targetId: record.configuration.evidenceReference,
      correlationId: record.operationReference,
      reasonCode: record.reasonCode,
      occurredAt: record.recordedAt,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: { version: record.configuration.evidenceVersion },
      dataClassification: "Restricted",
      retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
      retentionPolicyVersion: 1,
    }),
  });
  const query = {
    actorType: "System",
    actorReference: null,
    action: "ResolveKitchenStationRoutingEvidence",
    purpose: "CreateKitchenWork",
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    effectiveAt: at,
  };
  const read = (patch = {}) =>
    runner().run((transaction) => store.resolve({ transaction, query: { ...query, ...patch } }));
  assert.equal(await read(), null);
  const configuration = rebindKitchenRoutingEvidence(
    {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      evidenceReference: id(9201),
      evidenceVersion: 1,
      effectiveAt: at,
      evidenceDigest: hash("placeholder"),
      candidates: [
        {
          stationReference: id(9101),
          stationVersion: 1,
          stationStatus: "Active",
          stationCapabilityReferences: [id(9203)],
          routingRuleReference: id(9102),
          routingRuleVersion: 1,
          routingRuleStatus: "Active",
          selector: { kind: "AllPreparedItems" },
          targetStationReference: id(9101),
          routingRuleDigest: hash("placeholder"),
        },
      ],
    },
    at,
    hash,
  );
  const record = {
    operationReference: id(9202),
    actorReference: id(5),
    purposeCode: "SyntheticConfiguration",
    permissionCode: "synthetic.configure",
    reasonCode: "SYNTHETIC_SETUP",
    recordedAt: at,
    expectedVersion: 0,
    configuration,
  };
  const count = async () =>
    (await admin.query("SELECT count(*)::int AS n FROM rms_kitchen.kitchen_routing_configuration"))
      .rows[0].n;
  await assert.rejects(
    runner({ failAudit: true }).run((transaction) => store.commit({ transaction, record })),
  );
  assert.equal(await count(), 0);
  writeAllowed = false;
  await assert.rejects(runner().run((transaction) => store.commit({ transaction, record })));
  writeAllowed = true;
  configurationAllowed = false;
  await assert.rejects(runner().run((transaction) => store.commit({ transaction, record })));
  configurationAllowed = true;
  assert.equal(await count(), 0);
  const created = await Promise.all([
    runner().run((transaction) => store.commit({ transaction, record })),
    runner().run((transaction) => store.commit({ transaction, record })),
  ]);
  assert.deepEqual(created.map((result) => result.status).sort(), [
    "AlreadyCommitted",
    "Committed",
  ]);
  assert.equal(await count(), 1);
  assert.deepEqual(await read(), configuration);
  const previousValidations = validations;
  assert.equal(
    (await runner().run((transaction) => store.commit({ transaction, record }))).status,
    "AlreadyCommitted",
  );
  assert.equal(validations, previousValidations);
  await assert.rejects(
    runner().run((transaction) =>
      store.commit({
        transaction,
        record: { ...record, reasonCode: "CHANGED" },
      }),
    ),
    { code: "KITCHEN_ROUTING_CONFIGURATION_CONFLICT" },
  );
  readAllowed = false;
  let reads = 0;
  await assert.rejects(
    runner().run((tx) =>
      store.resolve({
        transaction: {
          query: async (sql, values) => {
            if (sql.includes("FROM rms_kitchen.kitchen_routing_configuration")) reads++;
            return tx.query(sql, values);
          },
        },
        query,
      }),
    ),
  );
  assert.equal(reads, 0);
  readAllowed = true;
  await assert.rejects(read({ action: "UnexpectedAction" }));
  await assert.rejects(read({ storeReference: id(9299) }));
  const later = new Date(Date.parse(at) + 60000).toISOString();
  const inactive = {
    ...record,
    operationReference: id(9205),
    expectedVersion: 1,
    configuration: rebindKitchenRoutingEvidence(
      {
        ...configuration,
        evidenceReference: id(9206),
        evidenceVersion: 2,
        candidates: [
          {
            ...configuration.candidates[0],
            stationStatus: "Inactive",
            stationVersion: 2,
            routingRuleStatus: "Inactive",
            routingRuleVersion: 2,
          },
        ],
      },
      later,
      hash,
    ),
  };
  await runner().run((transaction) => store.commit({ transaction, record: inactive }));
  assert.equal(await count(), 2);
  assert.deepEqual(await read(), configuration);
  assert.equal((await read({ effectiveAt: later })).candidates[0].stationStatus, "Inactive");
  const between = new Date(Date.parse(at) + 1000).toISOString();
  const selected = await read({ effectiveAt: between });
  assert.equal(selected.evidenceReference, configuration.evidenceReference);
  assert.equal(selected.effectiveAt, between);
  assert.notEqual(selected.evidenceDigest, configuration.evidenceDigest);
  await runner().run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    assert.equal(
      (await tx.query("UPDATE rms_kitchen.kitchen_routing_configuration SET version_number=99", []))
        .rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_kitchen.kitchen_routing_configuration", [])).rowCount,
      0,
    );
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(9299)]);
    assert.equal(
      (await tx.query("SELECT * FROM rms_kitchen.kitchen_routing_configuration", [])).rows.length,
      0,
    );
  });
  return { store, query, requiredCapabilityReference: id(9203) };
}
