import assert from "node:assert/strict";

/** Called inside the existing actual ordinary authoring HTTP journey. Reuses
 * its encrypted persisted Session, current IAM, FeatureControl and Catalog SQL.
 * EA semantics below are an explicit synthetic operator declaration, independent
 * of observed codes/quantities; this never establishes a real Brand unit fact.
 */
export async function exerciseProductSellingUnitRuntimeHttp({
  post,
  session,
  selected,
  reference,
  admin,
  brand,
  actor,
  now,
}) {
  assert.equal(selected.brandReference, brand);
  assert.equal(typeof session.csrf, "string");
  const inspectPath = "/merchant/catalog/products/selling-units/inspect",
    registerPath = "/merchant/catalog/products/selling-units/register",
    counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_catalog.selling_unit_registry_record WHERE brand_id=$1) registry,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code='CATALOG_SELLING_UNIT_REGISTRY_RECORDED') audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1 AND event_type='SellingUnitRegistryVersionRecorded') outbox",
          [brand],
        )
      ).rows[0],
    inspect = async () => {
      const response = await post({ action: "Create" }, {}, inspectPath);
      assert.equal(response.status, 200, "Actual current unit inspection must succeed");
      assert.equal(response.body.profile, "CatalogProductSellingUnitRegistryViewV1");
      assert.equal(response.body.brandReference, brand);
      assert.equal(response.body.storeReference, selected.storeReference);
      assert.match(response.body.historyDigest, /^sha256:[0-9a-f]{64}$/u);
      return response.body;
    },
    before = await inspect();
  // This acceptance has a fixed real fixture precondition, never a guessed
  // expected version or a catch/fallback that turns source refusal into Absent.
  assert.equal(before.presence, "Absent", "This journey requires an actually unregistered Brand");
  assert.equal(before.registryVersion, 0);
  assert.equal(before.defaultLocale, null);
  assert.equal(before.definitionsDigest, null);
  assert.deepEqual(before.units, []);
  for (const assigned of before.assignedHistory) {
    assert.equal(
      assigned.unitCode,
      "EA",
      "Unexpected historical units require their own known semantics",
    );
    assert(Number.isSafeInteger(assigned.currentSkuCount) && assigned.currentSkuCount >= 0);
    assert(
      Number.isSafeInteger(assigned.historicalAssignmentCount) &&
        assigned.historicalAssignmentCount >= 0,
    );
    for (const quantity of assigned.quantities)
      assert.match(
        quantity,
        /^[1-9][0-9]*$/u,
        "Explicit synthetic EA precision zero must express every historical quantity",
      );
    assert(!Object.hasOwn(assigned, "skuReference"));
    assert(!Object.hasOwn(assigned, "productReference"));
  }
  const operationReference = reference(),
    definition = {
      unitReference: null,
      code: "EA",
      semanticDefinition: "count of one individual item",
      quantityDecimalPlaces: 0,
      localizedNames: { "en-CA": "Synthetic individual item" },
      lifecycle: "Active",
    },
    request = {
      action: "Create",
      operationReference,
      expectedRegistryVersion: 0,
      defaultLocale: "en-CA",
      units: [definition],
      ...(before.assignedHistory.length === 0
        ? {}
        : {
            bootstrapConfirmation: {
              historyDigest: before.historyDigest,
              confirmations: before.assignedHistory.map((assigned) => ({
                unitCode: assigned.unitCode,
                semanticDefinition: definition.semanticDefinition,
                confirmed: true,
              })),
            },
          }),
    },
    baseline = await counts(),
    registered = await post(request, {}, registerPath);
  assert.deepEqual(baseline, { registry: 0, audit: 0, outbox: 0 });
  assert.equal(
    registered.status,
    200,
    "Actual Session/IAM/capability unit registration must commit",
  );
  assert.deepEqual(
    {
      profile: registered.body.profile,
      status: registered.body.status,
      operationReference: registered.body.operationReference,
      registryVersion: registered.body.registryVersion,
    },
    {
      profile: "CatalogProductSellingUnitRegistryResultV1",
      status: "Applied",
      operationReference,
      registryVersion: 1,
    },
  );
  assert.match(registered.body.snapshotDigest, /^sha256:[0-9a-f]{64}$/u);
  const afterFirst = await counts();
  assert.deepEqual(afterFirst, { registry: 1, audit: 1, outbox: 1 });
  const persisted = async () =>
      (
        await admin.query(
          "SELECT actor_id,registry_id,version_id,occurred_at,command_json,snapshot_json,intent_digest,snapshot_digest,event_id,audit_id FROM rms_catalog.selling_unit_registry_record WHERE brand_id=$1 AND operation_id=$2",
          [brand, operationReference],
        )
      ).rows,
    originalRows = await persisted();
  assert.equal(originalRows.length, 1);
  const original = originalRows[0];
  assert.equal(original.actor_id, actor);
  assert.equal(original.command_json.occurredAt, original.snapshot_json.registeredAt);
  assert.equal(original.occurred_at.toISOString(), original.command_json.occurredAt);
  assert(original.command_json.occurredAt <= now());
  assert.equal(original.snapshot_digest, registered.body.snapshotDigest);
  if (request.bootstrapConfirmation) {
    const confirmation = original.command_json.bootstrapConfirmation;
    assert.equal(confirmation.profile, "CatalogSellingUnitBootstrapConfirmationV1");
    assert.equal(confirmation.historyDigest, before.historyDigest);
    assert.deepEqual(confirmation.confirmations, request.bootstrapConfirmation.confirmations);
    assert.match(confirmation.definitionsDigest, /^sha256:[0-9a-f]{64}$/u);
  } else assert(!Object.hasOwn(original.command_json, "bootstrapConfirmation"));

  const replay = await post(request, {}, registerPath);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, "Replayed");
  assert.equal(replay.body.registryVersion, 1);
  assert.equal(replay.body.snapshotDigest, registered.body.snapshotDigest);
  assert.deepEqual(await persisted(), originalRows);
  assert.deepEqual(await counts(), afterFirst);
  const changed = await post(
    {
      ...request,
      units: [{ ...definition, localizedNames: { "en-CA": "Changed original label" } }],
    },
    {},
    registerPath,
  );
  assert.equal(changed.status, 409);
  assert.deepEqual(await persisted(), originalRows);
  assert.deepEqual(await counts(), afterFirst);
  const stale = await post({ ...request, operationReference: reference() }, {}, registerPath);
  assert.equal(stale.status, 409);
  assert.deepEqual(await counts(), afterFirst);

  const present = await inspect();
  assert.equal(present.presence, "Present");
  assert.equal(present.registryVersion, 1);
  assert.equal(present.historyDigest, before.historyDigest);
  assert.equal(present.units.length, 1);
  const unit = present.units[0];
  assert.equal(unit.code, definition.code);
  assert.equal(unit.semanticDefinition, definition.semanticDefinition);
  assert.equal(unit.quantityDecimalPlaces, 0);
  assert.equal(typeof unit.unitReference, "string");
  const next = await post(
    {
      action: "Create",
      operationReference: reference(),
      expectedRegistryVersion: 1,
      defaultLocale: "en-CA",
      units: [{ ...unit, localizedNames: { "en-CA": "Synthetic individual item updated label" } }],
    },
    {},
    registerPath,
  );
  assert.equal(next.status, 200);
  assert.equal(next.body.status, "Applied");
  assert.equal(next.body.registryVersion, 2);
  const afterSecond = await counts();
  assert.deepEqual(afterSecond, { registry: 2, audit: 2, outbox: 2 });
  const oldReplay = await post(request, {}, registerPath);
  assert.equal(oldReplay.status, 200);
  assert.equal(oldReplay.body.status, "Replayed");
  assert.equal(oldReplay.body.registryVersion, 1);
  assert.equal(oldReplay.body.snapshotDigest, registered.body.snapshotDigest);
  assert.deepEqual(await persisted(), originalRows);
  assert.deepEqual(await counts(), afterSecond);
  assert.equal((await inspect()).registryVersion, 2);
  // Identity-only recovery uses the actual persisted Session/IAM and owner SQL.
  // It does not reconstruct definitions or generate a replacement operation.
  const contextPath = "/merchant/catalog/products/selling-units/context",
    resolvePath = "/merchant/catalog/products/selling-units/resolve",
    context = await post({ action: "Create" }, {}, contextPath);
  assert.equal(context.status, 200);
  assert.equal(context.body.profile, "CatalogSellingUnitRegistrationContextV1");
  assert.equal(context.body.brandReference, brand);
  assert.equal(context.body.storeReference, selected.storeReference);
  assert.equal(context.body.actorReference, actor);
  const resolveRequest = {
      profile: "CatalogSellingUnitRegistrationResolutionRequestV1",
      tenantReference: context.body.tenantReference,
      actorReference: actor,
      action: "Create",
      operationReference,
      expectedRegistryVersion: 0,
    },
    recoveryCounts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_catalog.selling_unit_registration_abandonment WHERE brand_id=$1) fences,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code='CATALOG_SELLING_UNIT_REGISTRATION_ABANDONED') audit",
          [brand],
        )
      ).rows[0],
    recoveryBaseline = await recoveryCounts();
  const resolved = await post(resolveRequest, {}, resolvePath);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.profile, "CatalogSellingUnitRegistrationResolutionResultV1");
  assert.equal(resolved.body.storeReference, selected.storeReference);
  const receipt = resolved.body.resolution;
  assert.equal(receipt.outcome, "Committed");
  assert.equal(receipt.recordedAt, original.command_json.occurredAt);
  assert.equal(receipt.registryReference, original.registry_id);
  assert.equal(receipt.versionReference, original.version_id);
  assert.equal(receipt.registryVersion, 1);
  assert.equal(receipt.originalIntentDigest, original.intent_digest);
  assert.equal(receipt.snapshotDigest, original.snapshot_digest);
  assert.deepEqual((await post(resolveRequest, {}, resolvePath)).body, resolved.body);
  for (const changed of [{ actorReference: reference() }, { tenantReference: reference() }]) {
    assert.equal((await post({ ...resolveRequest, ...changed }, {}, resolvePath)).status, 403);
  }
  for (const changed of [{ action: "ReplaceDraft" }, { expectedRegistryVersion: 1 }]) {
    assert.equal((await post({ ...resolveRequest, ...changed }, {}, resolvePath)).status, 409);
  }
  assert.deepEqual(await recoveryCounts(), recoveryBaseline);
  assert.deepEqual(await counts(), afterSecond);
  const absentRequest = {
      ...resolveRequest,
      operationReference: reference(),
      expectedRegistryVersion: 2,
    },
    abandoned = await post(absentRequest, {}, resolvePath);
  assert.equal(abandoned.status, 200);
  assert.equal(abandoned.body.resolution.outcome, "Abandoned");
  assert.equal(abandoned.body.resolution.registryReference, null);
  assert.equal(abandoned.body.resolution.registryVersion, null);
  assert.equal(abandoned.body.resolution.originalIntentDigest, null);
  assert.deepEqual((await post(absentRequest, {}, resolvePath)).body, abandoned.body);
  assert.deepEqual(await recoveryCounts(), {
    fences: recoveryBaseline.fences + 1,
    audit: recoveryBaseline.audit + 1,
  });
  const late = await post(
    {
      action: "Create",
      operationReference: absentRequest.operationReference,
      expectedRegistryVersion: 2,
      defaultLocale: "en-CA",
      units: [{ ...unit, localizedNames: { "en-CA": "Synthetic individual item after fence" } }],
    },
    {},
    registerPath,
  );
  assert.equal(late.status, 409);
  assert.deepEqual(await recoveryCounts(), {
    fences: recoveryBaseline.fences + 1,
    audit: recoveryBaseline.audit + 1,
  });
  assert.deepEqual(await counts(), afterSecond);
  assert.deepEqual(await persisted(), originalRows);
  assert.equal((await inspect()).registryVersion, 2);
}
