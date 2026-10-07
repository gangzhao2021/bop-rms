import assert from "node:assert/strict";
import pg from "pg";
import {
  createPostgresFullOptionSetDraftStore,
  createPostgresCurrentFullOptionSetDraftStore,
} from "../../rms/catalog/src/infrastructure/persistence/option-set-full-draft-store.ts";
import { CatalogError } from "../../rms/catalog/src/contracts/product.ts";
const id = (n) => "01902421-7100-7000-8000-" + n.toString(16).padStart(12, "0");
/** Controlled synthetic Actor/permission input only. Actual Catalog SQL, CAS,
 * allocation, immutable original receipt, Audit/Outbox and outer rollback execute.
 * Does not certify persisted IAM, referenced source eligibility or publication. */
export async function exerciseOptionSetFullEdit(context) {
  const admin = new pg.Client(context.clientConfig);
  await admin.connect();
  const role = "wp2421_opt_edit_" + context.runId;
  assert.match(role, /^wp2421_opt_edit_[a-f0-9]+$/u);
  const tenant = id(1),
    brand = id(2),
    actor = id(3),
    at = new Date(Date.now() - 1000).toISOString(),
    guards = new WeakMap();
  let sequence = 100,
    allowed = true,
    afterWork = null,
    createdRole = false,
    allocations = 0;
  const reference = () => id(++sequence),
    now = () => at;
  const permit = async (_tx, input) => {
    assert.equal(input.tenantReference, tenant);
    assert.equal(input.brandReference, brand);
    assert.equal(input.actorReference, actor);
    assert.equal(input.actorKind, "User");
    assert.equal(input.permission, "catalog.manage");
    assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
    assert(
      [
        "catalog.option_set.create",
        "catalog.option_set.update",
        "catalog.option_set.read",
      ].includes(input.action),
    );
    assert(input.requiredFields.length > 0);
    if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return {
      observedAt: input.observedAt,
      validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
    };
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
        tx = { query: (sql, values = []) => client.query(sql, [...values]) };
        const entries = [];
        guards.set(tx, entries);
        const result = await work(tx);
        if (afterWork) {
          const hook = afterWork;
          afterWork = null;
          await hook();
        }
        for (const entry of entries) await entry.guard();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
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
  const register = async (tx, guard, finalAssert) => {
    const entries = guards.get(tx);
    assert(entries);
    entries.push({ guard, finalAssert });
  };
  const audit = (input) => ({
    auditId: reference(),
    brandId: brand,
    actor: { type: "User", reference: actor },
    actionCode:
      input.result.sourceAggregate.aggregateVersion === 1
        ? "CATALOG_OPTION_SET_CREATE"
        : "CATALOG_OPTION_SET_REPLACEDRAFT",
    targetType: "CatalogOptionSet",
    targetId: input.result.sourceAggregate.optionSetReference,
    reasonCode: input.reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  });
  const owner = () =>
    createPostgresFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now },
      transactions,
      authority: { holdUntilTransactionCompletes: permit },
      creation: {
        authority: { holdUntilTransactionCompletes: permit },
        references: { generate: reference },
      },
      editing: {
        authority: { holdUntilTransactionCompletes: permit },
        references: {
          generateOption: () => {
            allocations++;
            return reference();
          },
        },
        registerBeforeCommit: register,
      },
      audit: { create: audit },
      events: { generateReference: reference },
    });
  const read = (set, root) =>
    createPostgresCurrentFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now },
      transactions,
      authority: { holdUntilTransactionCompletes: permit },
    }).readCurrent({ optionSetReference: set, expectedAggregateVersion: root });
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_catalog.option_set_operation_record WHERE brand_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.option_set_draft_content_snapshot WHERE brand_id=$1) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1) outbox",
        [brand],
      )
    ).rows[0];
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_catalog.option_set_authoring_identity TO " + role,
    );
    await admin.query("GRANT SELECT ON rms_catalog.option_set_authoring_abandonment TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION rms_catalog.option_set_authoring_operation_available(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query(
      "GRANT DELETE ON rms_catalog.option_conflict,rms_catalog.option_set_draft_content_snapshot TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
        role,
    );
    const createOperation = reference(),
      command = {
        internalCode: "SYNTHETIC_NATIVE_OPTIONS",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic choices" },
          localizedDescriptions: {},
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 1,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 1,
          options: [
            {
              stableCode: "ONE",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic one" },
              localizedDescriptions: {},
              sortOrder: 0,
              defaultEligible: false,
              triggeredOptionSetReference: null,
              conflictOptionCodes: [],
            },
          ],
        },
        additionalContent: {
          profile: "CatalogOptionSetEditorContentV1",
          optionDetails: [
            {
              stableCode: "ONE",
              quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
              media: null,
              pricingRule: null,
              consumption: null,
              triggeredOptionSetVersionReference: null,
            },
          ],
          conditionalRules: [],
          conflictRules: [],
          scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
        },
        operationReference: createOperation,
        occurredAt: at,
        reasonCode: "SYNTHETIC_OPTION_NATIVE",
      };
    const created = await owner().create(command);
    assert.equal(created.status, "Applied");
    const source = created.content.sourceAggregate,
      set = source.optionSetReference;
    const old = source.draft.options[0];
    assert(old);
    assert.deepEqual((await read(set, 1)).content, created.content);
    const edit = {
      optionSetReference: set,
      expectedAggregateVersion: 1,
      draft: {
        ...command.draft,
        options: [
          {
            ...command.draft.options[0],
            stableCode: "TWO",
            localizedNames: { "en-CA": "Synthetic two" },
            identity: { kind: "New" },
          },
        ],
      },
      additionalContent: {
        ...command.additionalContent,
        optionDetails: [{ ...command.additionalContent.optionDetails[0], stableCode: "TWO" }],
      },
      archiveOptionReferences: [old.optionReference],
      operationReference: reference(),
      occurredAt: at,
      reasonCode: "SYNTHETIC_OPTION_NATIVE",
    };
    const changed = await owner().edit(edit);
    assert.equal(changed.status, "Applied");
    assert.equal(changed.content.sourceAggregate.aggregateVersion, 2);
    const added = changed.content.sourceAggregate.draft.options.find((o) => o.stableCode === "TWO");
    assert(added);
    const archived = changed.content.sourceAggregate.draft.options.find(
      (o) => o.optionReference === old.optionReference,
    );
    assert(archived);
    assert.equal(archived.lifecycle, "Archived");
    assert.equal(archived.defaultEligible, false);
    assert.equal(archived.createdAt, old.createdAt);
    assert.equal(archived.createdByActorReference, old.createdByActorReference);
    assert.equal(added.createdAt, at);
    assert.equal(added.createdByActorReference, actor);
    assert.equal(allocations, 1);
    assert.notEqual(added.optionReference, old.optionReference);
    assert.deepEqual(
      changed.content.optionDetails.find((d) => d.optionReference === old.optionReference),
      created.content.optionDetails.find((d) => d.optionReference === old.optionReference),
    );
    assert.deepEqual((await read(set, 2)).content, changed.content);
    const committedCounts = await counts();
    assert.deepEqual(committedCounts, { operations: 2, snapshots: 2, audit: 2, outbox: 2 });
    assert.deepEqual(
      (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.option_set_draft_content_snapshot WHERE operation_id=$1",
          [createOperation],
        )
      ).rows[0].snapshot_json,
      created.content,
    );
    const replay = await owner().edit(edit);
    assert.equal(replay.status, "Replayed");
    assert.deepEqual(replay.content, changed.content);
    assert.equal(allocations, 1);
    assert.deepEqual(await counts(), committedCounts);
    await assert.rejects(
      owner().edit({ ...edit, reasonCode: "SYNTHETIC_CHANGED_INTENT" }),
      (error) => error.code === "CATALOG_IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(await counts(), committedCounts);
    const next = {
      ...edit,
      expectedAggregateVersion: 2,
      operationReference: reference(),
      draft: { ...edit.draft, options: [{ ...edit.draft.options[0], stableCode: "THREE" }] },
      additionalContent: {
        ...edit.additionalContent,
        optionDetails: [{ ...edit.additionalContent.optionDetails[0], stableCode: "THREE" }],
      },
      archiveOptionReferences: [old.optionReference, added.optionReference],
    };
    afterWork = () => {
      allowed = false;
    };
    await assert.rejects(owner().edit(next), (error) => error.code === "CATALOG_PERMISSION_DENIED");
    allowed = true;
    assert.deepEqual(await counts(), committedCounts);
    assert.deepEqual((await read(set, 2)).content, changed.content);
    // Existing SQL rules intentionally refuse immutable rewrites by affected
    // row count zero (not an exception). Verify persisted original identity.
    await transactions.run(async (tx) => {
      for (const [column, value] of [
        ["stable_code", "SYNTHETIC_REKEY"],
        ["created_by_actor_id", id(999)],
        ["created_at", new Date(Date.parse(at) + 1000).toISOString()],
      ]) {
        const result = await tx.query(
          "UPDATE rms_catalog.option SET " + column + "=$1 WHERE option_id=$2",
          [value, old.optionReference],
        );
        assert.equal(result.rowCount, 0);
      }
      assert.equal(
        (
          await tx.query(
            "UPDATE rms_catalog.option_set_draft_content_snapshot SET snapshot_json='{}'::jsonb WHERE operation_id=$1",
            [edit.operationReference],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await tx.query(
            "DELETE FROM rms_catalog.option_set_draft_content_snapshot WHERE operation_id=$1",
            [edit.operationReference],
          )
        ).rowCount,
        0,
      );
    });
    assert.deepEqual((await read(set, 2)).content, changed.content);
    assert.deepEqual(await counts(), committedCounts);
  } finally {
    try {
      if (createdRole) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
    } finally {
      await admin.end();
    }
  }
}
