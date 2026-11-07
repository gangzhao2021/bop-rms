import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  parseProductAggregate,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  createPostgresProductLifecycleStore,
  createPostgresProductValidationCandidateSourceV2,
  productPublicationCheckCodes,
  parseProductPublicationValidationV2,
  applyCatalogProductUniqueScopeValidationV2,
} from "../../rms/catalog/src/index.ts";
import { createCurrentProductCandidateUniqueScopeSourceV2 } from "../../../apps/api/src/current-product-candidate-unique-scope-v2.ts";
import { exerciseProductCurrentValidationV2 } from "./product-current-validation-v2.mjs";

const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Actual owning Create/ReplaceDraft, history/retirement, Tenant projection and
 * Published policy SQL. Identities, field holders and other validation checks
 * are controlled synthetic inputs, never production qualification. */
export async function exerciseProductValidationCandidateV2(env) {
  const {
    admin,
    role,
    tenant,
    brand,
    actor,
    storeA,
    storeB,
    policyReference,
    policySource,
    transactions,
    seedPublished,
    replacementCommand,
    execute,
    counts,
    id,
    time,
    clock,
  } = env;
  assert.match(role, /^wp2421_retire_[a-f0-9]+$/);
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_tenant.brand,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_channel,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_version_category_assignment TO " +
      role,
  );
  await admin.query("GRANT INSERT ON rms_catalog.product TO " + role);
  await admin.query(
    "INSERT INTO bop_tenant.brand VALUES($1,'SYNTHETIC_V2_BRAND','Synthetic Brand','en-CA','CAD','Active',1,$2,$2)",
    [brand, time(0)],
  );
  for (const [index, store] of [storeA, storeB].entries()) {
    await admin.query(
      "INSERT INTO bop_tenant.store VALUES($1,$2,$3,'Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$4,$4)",
      [store, brand, "SYNTHETIC_V2_" + index, time(0)],
    );
  }
  const complete = await seedPublished(30000, async (minimal) => {
    const original = parseProductAggregate({
      ...minimal,
      lifecycle: "Draft",
      draft: {
        ...minimal.draft,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {},
          localizedDescriptions: { "en-CA": "Synthetic complete candidate" },
          preparationNotes: {},
          tagReferences: [],
          attributeValues: [],
          media: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    });
    const options = {
      brandReference: brand,
      transactions,
      authorize: async () => true,
      editorContentAuthority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.aggregate.productReference, original.productReference);
          assert.equal(input.aggregate.brandReference, brand);
        },
      },
    };
    const audit = (operation, action) => ({
      auditId: id(operation + 500000),
      brandId: brand,
      actor: { type: "User", reference: actor },
      actionCode: action,
      targetType: "CatalogProduct",
      targetId: original.productReference,
      correlationId: id(operation),
      occurredAt: clock.now(),
      reasonCode: "SYNTHETIC_V2_CANDIDATE",
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
    await createPostgresProductCreationStore(options).create({
      record: {
        action: "Create",
        operationReference: id(30500),
        operationIntentHash: sha256Hex("synthetic V2 current candidate create"),
        aggregate: original,
      },
      audit: audit(30500, "CATALOG_PRODUCT_CREATE"),
    });
    const next = parseProductAggregate({
      ...original,
      aggregateVersion: 2,
      draft: {
        ...original.draft,
        editorContent: {
          ...original.draft.editorContent,
          localizedDescriptions: { "en-CA": "Changed synthetic complete candidate" },
        },
      },
    });
    await createPostgresProductDraftStore(options).commit({
      record: {
        action: "ReplaceDraft",
        operationReference: id(30501),
        operationIntentHash: sha256Hex("synthetic V2 current candidate replace"),
        aggregate: next,
      },
      expectedAggregateVersion: 1,
      audit: audit(30501, "CATALOG_PRODUCT_REPLACEDRAFT"),
    });
    assert.deepEqual(
      await createPostgresProductLifecycleStore(options).load(next.productReference),
      next,
    );
    return next;
  });
  clock.set(time(10000));
  let command = replacementCommand(complete, complete.original.aggregate, 0, "Validate", 30600);
  let activeTx,
    fault = "normal",
    consumerFinished = false,
    historyReads = 0,
    advanced = false,
    candidateHolds = 0,
    rosterChecks = 0;
  const candidateAuthority = {
    async holdUntilTransactionCompletes(actual, input) {
      assert.equal(actual, activeTx);
      assert.equal(input.actorReference, actor);
      assert.equal(input.actorKind, "User");
      assert.equal(input.purposeCode, command.purposeCode);
      assert.equal(input.productReference, command.productReference);
      assert(input.requiredFields.includes("replacementIntent"));
      assert(input.requiredFields.includes("replacementIntentDigest"));
      assert(input.requiredFields.includes("editorContent"));
      candidateHolds++;
      if (consumerFinished && fault === "candidate-denial")
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  };
  const configuration = {
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: () => clock.now() },
    policySource,
    candidateAuthority,
    validationAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, activeTx);
        assert.deepEqual(input.command, command);
        if (!advanced) {
          clock.set(new Date(Date.parse(clock.now()) + 1).toISOString());
          advanced = true;
        }
        if (consumerFinished && fault === "validation-denial")
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
    historyAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, activeTx);
        assert.equal(input.productReference, command.productReference);
        assert(input.owningActions.includes("catalog.product.history.read"));
        assert(input.requiredFields.includes("scopeRetirements"));
        historyReads++;
      },
    },
    tenantAuthority: {
      async withCurrentBrandReferenceRead(request, work) {
        assert.equal(request.originalIntentDigest, hash(command));
        assert.equal(request.actorReference, actor);
        assert.equal(request.brandReference, brand);
        return work();
      },
      async isCurrent(actual, request) {
        assert.equal(actual, activeTx);
        assert.equal(request.originalIntentDigest, hash(command));
        rosterChecks++;
        return !(consumerFinished && fault === "tenant-denial");
      },
    },
  };
  const source = createCurrentProductCandidateUniqueScopeSourceV2(configuration);
  // Capture configuration methods; mutation after construction cannot inject a source.
  configuration.historyAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("MUTATED_PORT_MUST_NOT_RUN");
  };
  const read = (work) =>
    transactions.run(async (tx) => {
      activeTx = tx;
      return source.withCurrentAssessment(tx, { command, policyReference, policyVersion: 1 }, work);
    });
  const proof = await read(async (assessment) => assessment);
  assert.equal(proof.currentCandidate, "Bound");
  assert.equal(proof.completeContent, "Present");
  assert.equal(proof.originalIntentDigest, hash(command));
  assert.equal(proof.replacementIntentDigest, command.replacementIntentDigest);
  assert.equal(proof.contentDigest, command.contentDigest);
  assert.equal(proof.configurationDigest, command.configurationDigest);
  assert.equal(proof.candidateObservedAt, time(10000));
  assert.equal(proof.observedAt, time(10001));
  assert.equal(proof.validUntil, time(15000));
  assert.equal(proof.scopeAssessment.validUntil, time(15000));
  assert.equal(proof.scopeAssessment.digest, proof.scopeAssessmentDigest);
  assert.deepEqual(proof.check, { code: "UniqueScope", outcome: "Pass" });
  assert.deepEqual(proof.internalCodeCheck, { code: "InternalCode", outcome: "Pass" });
  assert.equal(proof.skuPrerequisite, "NoActiveMember");
  // M133 exposes the empty-binding necessary condition without fabricating a graph proof.
  assert.equal(proof.optionRulePrerequisite, "NoMechanicalContradiction");
  assert.equal(Object.hasOwn(proof, "optionRulesAssessment"), false);
  assert(candidateHolds > 2 && historyReads > 1 && rosterChecks > 1);
  const validation = {
    profile: "CatalogProductPublicationValidationV2",
    replacementIntentDigest: command.replacementIntentDigest,
    evidenceReference: id(30601),
    productAggregateVersion: command.expectedProductAggregateVersion,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: hash(command.scopeSet),
    periodDigest: hash(command.effectivePeriod),
    policyReference,
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({
      code,
      outcome:
        code === "ApprovalPolicy"
          ? "Pending"
          : ["PublishableSku", "HardErrorsCleared"].includes(code)
            ? "HardError"
            : "Pass",
    })),
    warningAcknowledgement: null,
    checkedAt: time(10000),
    validUntil: time(40000),
  };
  const merged = applyCatalogProductUniqueScopeValidationV2(
    command,
    validation,
    proof.scopeAssessment,
    clock.now(),
  );
  assert.deepEqual(merged.checks, parseProductPublicationValidationV2(validation).checks);
  assert.equal(merged.checks.find((check) => check.code === "ApprovalPolicy").outcome, "Pending");
  assert.equal(merged.evidenceReference, validation.evidenceReference);
  assert.equal(merged.validUntil, proof.scopeAssessment.validUntil);
  for (const selected of [
    "candidate-denial",
    "validation-denial",
    "tenant-denial",
    "expiry",
    "clock-rollback",
  ]) {
    clock.set(time(10000));
    advanced = false;
    consumerFinished = false;
    fault = selected;
    const before = await counts(command.productReference);
    const row = (
      await admin.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
        command.productReference,
      ])
    ).rows[0];
    let calls = 0;
    await assert.rejects(
      read(async () => {
        calls++;
        await activeTx.query("UPDATE rms_catalog.product SET updated_at=$1 WHERE product_id=$2", [
          time(10002),
          command.productReference,
        ]);
        consumerFinished = true;
        if (selected === "expiry") clock.set(time(15000));
        if (selected === "clock-rollback") clock.set(time(10000));
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(await counts(command.productReference), before);
    assert.deepEqual(
      (
        await admin.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
          command.productReference,
        ])
      ).rows[0],
      row,
    );
  }
  fault = "normal";
  consumerFinished = false;
  advanced = false;
  clock.set(time(10000));
  await transactions.run(async (tx) => {
    activeTx = tx;
    const candidate = createPostgresProductValidationCandidateSourceV2({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      authority: candidateAuthority,
      clock: { now: () => clock.now() },
      transactions: { run: (work) => work(tx) },
    });
    await candidate.withCurrentCandidate(command, async (current, actual) => {
      assert.equal(actual, tx);
      assert.equal(current.completeContent, "Present");
      assert.equal(current.originalIntentDigest, hash(command));
    });
  });
  // The native V2 writer creates real permanent retirement rows; its remaining
  // validation inputs here are the existing explicitly synthetic131 fixture.
  clock.set(time(10000));
  let aggregate = complete.original.aggregate,
    revision = 0,
    published;
  for (const [index, action] of ["Validate", "SubmitReview", "Approve", "Publish"].entries()) {
    const c = replacementCommand(complete, aggregate, revision, action, 30700 + index);
    published = await execute(c);
    assert.equal(
      published.publication.validationDecision,
      action === "Validate" || action === "SubmitReview" ? "ApprovalPending" : "Pass",
    );
    aggregate = published.aggregate;
    revision++;
  }
  command = replacementCommand(complete, aggregate, 0, "Validate", 30800);
  advanced = false;
  let refusedConsumerCalls = 0;
  await assert.rejects(
    read(async () => {
      refusedConsumerCalls++;
      return null;
    }),
    {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    },
  );
  assert.equal(refusedConsumerCalls, 0);
  advanced = false;
  clock.set(time(10000));
  command = replacementCommand(complete, aggregate, 0, "Validate", 30801, { selectorIndex: 1 });
  const retained = await read(async (assessment) => assessment);
  assert.equal(retained.check.outcome, "Pass");
  assert.equal(retained.replacementIntentDigest, command.replacementIntentDigest);
  const minimal = await seedPublished(40000);
  clock.set(time(10000));
  advanced = false;
  historyReads = 0;
  command = replacementCommand(minimal, minimal.original.aggregate, 0, "Validate", 40800);
  await assert.rejects(
    read(async () => {
      refusedConsumerCalls++;
      return null;
    }),
    {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    },
  );
  assert.equal(refusedConsumerCalls, 0);
  assert.equal(historyReads, 0);
  await exerciseProductCurrentValidationV2(env, complete, aggregate);
}
