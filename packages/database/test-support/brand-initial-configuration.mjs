import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseBrandConfigurationCommand } from "../../bop/tenant/src/index.ts";

/** A distinct ordinary runtime principal. Initial Membership/Policy imports keep
 * their separate writer role; this role cannot provision IAM, write Platform
 * templates or inspect private account bindings/Provider identity material. */
export async function createInitialBrandMerchantTransactions(f, context) {
  const role = `brand_initial_merchant_${context.runId}`,
    password = randomBytes(32).toString("hex");
  assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
  await f.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  f.extraRoles.push(role);
  await f.admin.query(
    `GRANT USAGE ON SCHEMA bop_identity,bop_tenant,bop_membership,bop_permission,bop_feature_control,bop_publishing,rms_catalog,platform_audit,platform_helpers TO ${role}`,
  );
  await f.admin.query(
    `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),bop_identity.workforce_account_binding_read(uuid,text,text,text),bop_identity.workforce_account_invitation_read(uuid,uuid),bop_tenant.platform_brand_template_reference_read(uuid,uuid,uuid),bop_publishing.brand_template_publication_read(uuid,uuid,uuid),bop_publishing.brand_template_publication_hold(uuid,uuid,uuid),bop_publishing.brand_template_publication_list(uuid,uuid,uuid,integer,boolean),rms_catalog.brand_catalog_source_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE(consumed_at,version) ON bop_identity.oidc_authorization_transaction TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,MAINTAIN,UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.authentication_session TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE(session_id) ON bop_identity.browser_brand_session_selection TO ${role}`,
  );
  await f.admin.query(`GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO ${role}`);
  await f.admin.query(
    `GRANT SELECT,MAINTAIN ON bop_membership.membership,bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT ON bop_feature_control.control_version,bop_feature_control.control_dependency TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT ON rms_catalog.brand_catalog_source,rms_catalog.brand_catalog_source_operation,bop_tenant.brand_configuration_authoring_revision,bop_tenant.brand_configuration_authoring_operation,bop_tenant.brand_configuration_version,platform_audit.audit_record TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,MAINTAIN ON bop_publishing.publishing_mutation_record TO ${role}`,
  );
  await f.admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
  for (const [table, privilege] of [
    ["bop_identity.workforce_account_binding", "SELECT"],
    ["bop_identity.workforce_account_binding", "INSERT"],
    ["bop_identity.workforce_invitation", "SELECT"],
    ["bop_tenant.store", "SELECT"],
    ["bop_membership.store_assignment", "SELECT"],
    ["bop_identity.browser_session_selection", "SELECT"],
    ["bop_membership.membership", "INSERT"],
    ["bop_permission.policy_state", "INSERT"],
    ["bop_permission.role", "INSERT"],
    ["bop_permission.role_assignment", "INSERT"],
    ["bop_permission.permission_grant", "INSERT"],
    ["bop_permission.permission_override", "INSERT"],
    ["bop_feature_control.control_version", "INSERT"],
    ["bop_tenant.platform_brand_template_revision", "SELECT"],
    ["bop_publishing.platform_template_publishing_head", "SELECT"],
  ])
    assert.equal(
      (
        await f.admin.query("SELECT has_table_privilege($1,$2,$3) allowed", [
          role,
          table,
          privilege,
        ])
      ).rows[0].allowed,
      false,
    );
  for (const fn of [
    "bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)",
    "bop_publishing.platform_template_publishing_family_admit(uuid,uuid,boolean)",
  ])
    assert.equal(
      (await f.admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, fn]))
        .rows[0].allowed,
      false,
    );
  assert.deepEqual(
    (
      await f.admin.query(
        "SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=$1",
        [role],
      )
    ).rows[0],
    { rolsuper: false, rolbypassrls: false, rolcreaterole: false },
  );
  const transactions = Object.freeze({
    async run(work) {
      const client = new pg.Client({ ...context.clientConfig, user: role, password });
      await client.connect();
      f.clients.add(client);
      let poisoned = false,
        active = true;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SET LOCAL lock_timeout='2s'");
        const tx = Object.freeze({
          async query(sql, values = []) {
            assert(active);
            try {
              if (f.state.onQuery) await f.state.onQuery({ client, sql, values });
              const result = await client.query(sql, [...values]);
              if (f.state.afterQuery) await f.state.afterQuery({ client, sql, values });
              return result;
            } catch (error) {
              poisoned = true;
              if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) f.state.lastSqlState = error.code;
              throw error;
            }
          },
        });
        const result = await work(tx);
        if (f.state.beforeCommit) await f.state.beforeCommit({ client, tx });
        assert.equal(poisoned, false);
        active = false;
        await client.query("COMMIT");
        return result;
      } catch (error) {
        active = false;
        await client.query("ROLLBACK");
        throw error;
      } finally {
        f.clients.delete(client);
        await client.end();
      }
    },
  });
  return Object.freeze({ role, password, transactions });
}

/** Ordinary HTTP only for commands/reads. The actual Platform producer supplies
 * the expected immutable version; it never substitutes a successful reference
 * lookup. Actor cookies come from two real verified Workforce login callbacks. */
export async function exerciseInitialBrandConfiguration(
  f,
  { send, author, reviewer, brandReference, publishedTemplate, nextReference, participantState },
) {
  const prefix = "/merchant/organization/brands",
    scope = {
      tenantReference: brandReference,
      brandReference,
      actorReference: author.actorReference,
    };
  assert.notEqual(author.actorReference, reviewer.actorReference);
  const request = (session, path, body) =>
    send(prefix + path, { method: "POST", cookie: session.cookie, csrf: session.csrf, body });
  const success = async (session, path, body) => {
    const response = await request(session, path, body);
    assert.equal(response.status, 200, "ORDINARY_BRAND_CONFIGURATION_HTTP_REQUIRED");
    assert.equal(response.headers["cache-control"], "no-store");
    return JSON.parse(response.body);
  };
  const counts = async () =>
    (
      await f.admin.query(
        `SELECT
    (SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_revision WHERE brand_id=$1) revisions,
    (SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_operation WHERE brand_id=$1) originals,
    (SELECT count(*)::int FROM bop_tenant.brand_configuration_version WHERE brand_id=$1) published,
    (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1) mutations,
    (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audits`,
        [brandReference],
      )
    ).rows[0];
  const current = (session = author) =>
    success(session, "/configuration/current", { brandReference });
  const history = (session = author, beforeRevision = null) =>
    success(session, "/configuration/history", { brandReference, beforeRevision });
  const head = (receipt) => ({
    revision: receipt.snapshot.revision,
    configurationVersionReference: receipt.snapshot.configuration.configurationVersionReference,
    sourceDigest: receipt.snapshot.sourceDigest,
  });
  const command = (name, previous, configuration = null, reviewValidUntil = null) => ({
    command: name,
    operationReference: nextReference(),
    expectedBrandVersion: 1,
    expectedHead: previous ? head(previous) : null,
    configuration,
    reviewValidUntil,
  });
  const execute = (session, value) =>
    success(session, "/configuration/execute", { brandReference, command: value });
  const resolve = async (session, value) => {
    const actual = parseBrandConfigurationCommand({
      profile: "TenantBrandConfigurationCommandV1",
      ...scope,
      actorReference: session.actorReference,
      purposeCode: "BRAND_CONFIGURATION",
      ...value,
    });
    return success(session, "/configuration/resolve", {
      brandReference,
      command: {
        command: value.command,
        operationReference: value.operationReference,
        expectedBrandVersion: value.expectedBrandVersion,
        expectedHead: value.expectedHead,
        intentDigest: `sha256:${sha256Hex(canonicalizeRfc8785(actual))}`,
      },
    });
  };
  f.mark("Ordinary first Brand real Published Template discovery and Catalog registration");
  const candidates = await success(author, "/configuration/templates", {
    brandReference,
    afterTemplateReference: null,
  });
  assert.equal(candidates.profile, "MerchantBrandTemplateCandidatesV1");
  const selected = candidates.items.find(
    (item) => item.templateVersionReference === publishedTemplate.template.templateVersionReference,
  );
  assert(selected);
  assert.equal(selected.contentDigest, publishedTemplate.template.contentDigest);
  assert.equal(selected.templateReference, publishedTemplate.template.templateReference);
  assert.equal((await current()).current, null);
  assert.equal((await current()).recordedReview, null);
  assert.deepEqual((await history()).entries, []);
  assert.equal((await success(author, "/catalog-source/current", { brandReference })).source, null);
  const registration = {
    operationReference: nextReference(),
    code: "INITIAL_BRAND_CATALOG",
    label: "Initial Brand catalogue",
  };
  const catalog = await success(author, "/catalog-source/register", {
    brandReference,
    command: registration,
  });
  assert.equal(catalog.outcome, "Committed");
  assert(catalog.source);
  assert.deepEqual(
    (await success(author, "/catalog-source/current", { brandReference })).source,
    catalog.source,
  );
  assert.deepEqual(
    (
      await success(author, "/catalog-source/exact", {
        brandReference,
        sourceReference: catalog.source.sourceReference,
      })
    ).source,
    catalog.source,
  );
  const editable = {
    defaultLocale: selected.defaultLocale,
    supportedLocales: selected.supportedLocales,
    mediaThemeReference: null,
    catalogSourceReference: catalog.source.sourceReference,
    platformTemplateReference: selected.templateVersionReference,
    overrideAllowedFieldCodes: selected.overrideAllowedFieldCodes,
    hardRequirementFieldCodes: selected.hardRequirementFieldCodes,
    effectiveFrom: f.state.now,
    effectiveUntil: selected.effectiveUntil,
    reasonCode: "INITIAL_BRAND_CONFIGURATION",
  };
  f.mark("Ordinary Draft Save edit current history and immutable recovery");
  const firstCommand = command("SaveConfigurationDraft", null, editable),
    first = await execute(author, firstCommand);
  assert.equal(first.outcome, "Committed");
  assert.equal(first.snapshot.configuration.lifecycle, "Draft");
  const editedCommand = command("SaveConfigurationDraft", first, {
    ...editable,
    reasonCode: "INITIAL_BRAND_REVIEW_READY",
  });
  // Discarding the first response simulates a lost reply; recovery carries only
  // the original intent, never fresh IDs, references or a guessed next state.
  await execute(author, editedCommand);
  const beforeRecovery = await counts(),
    edited = await resolve(author, editedCommand);
  assert.equal(edited.outcome, "Committed");
  assert.deepEqual(await execute(author, editedCommand), edited);
  assert.deepEqual(await counts(), beforeRecovery);
  assert.deepEqual((await current()).current, edited.snapshot);
  assert.deepEqual(
    (await history()).entries.map((row) => row.operationReference),
    [editedCommand.operationReference, firstCommand.operationReference],
  );
  const reviewValidUntil = new Date(Date.parse(f.state.now) + 600000).toISOString();
  assert(reviewValidUntil <= selected.effectiveUntil);
  const submitCommand = command("SubmitConfiguration", edited, null, reviewValidUntil);
  f.mark("Actual late Workforce withdrawal rolls back both Core mutations and Tenant original");
  const beforeWithdrawal = await counts(),
    previousHook = f.state.afterQuery,
    disabledBefore = participantState.disabledMemberCalls;
  let withdrew = false;
  f.state.afterQuery = async (input) => {
    if (previousHook) await previousHook(input);
    if (
      !withdrew &&
      input.sql.startsWith("INSERT INTO bop_tenant.brand_configuration_authoring_operation")
    ) {
      withdrew = true;
      participantState.membersEnabled = false;
    }
  };
  try {
    assert.notEqual(
      (await request(author, "/configuration/execute", { brandReference, command: submitCommand }))
        .status,
      200,
    );
  } finally {
    f.state.afterQuery = previousHook;
    participantState.membersEnabled = true;
  }
  assert.equal(withdrew, true);
  assert(
    participantState.disabledMemberCalls > disabledBefore,
    "ACTUAL_LATE_DISABLED_WORKFORCE_OBSERVATION_REQUIRED",
  );
  assert.deepEqual(await counts(), beforeWithdrawal);
  f.mark("Ordinary actual Submit and independently authenticated approval");
  const submitted = await execute(author, submitCommand);
  assert.equal(submitted.snapshot.configuration.lifecycle, "PendingApproval");
  const reloaded = await current(reviewer);
  assert.deepEqual(reloaded.current, submitted.snapshot);
  assert.equal(reloaded.recordedReview.reviewValidUntil, reviewValidUntil);
  assert.equal(reloaded.recordedReview.submittedByReference, author.actorReference);
  const selfBefore = await counts(),
    self = command("ApproveConfiguration", submitted);
  assert.notEqual(
    (await request(author, "/configuration/execute", { brandReference, command: self })).status,
    200,
  );
  assert.deepEqual(await counts(), selfBefore);
  const approveCommand = command("ApproveConfiguration", submitted),
    approved = await execute(reviewer, approveCommand);
  assert.equal(approved.snapshot.configuration.lifecycle, "Approved");
  assert.equal(approved.snapshot.configuration.authoredByReference, author.actorReference);
  assert.equal(approved.snapshot.configuration.approvedByReference, reviewer.actorReference);
  const publishCommand = command("PublishConfiguration", approved),
    published = await execute(reviewer, publishCommand);
  assert.equal(published.snapshot.configuration.lifecycle, "Published");
  assert.deepEqual((await current(author)).current, published.snapshot);
  const latestHistory = await history(reviewer);
  assert.equal(latestHistory.beforeRevision, null);
  assert.deepEqual(latestHistory.entries, [published.snapshot, approved.snapshot]);
  assert.equal(latestHistory.nextBeforeRevision, approved.snapshot.revision);
  const reviewHistory = await history(reviewer, latestHistory.nextBeforeRevision);
  assert.equal(reviewHistory.beforeRevision, approved.snapshot.revision);
  assert.deepEqual(reviewHistory.entries, [submitted.snapshot, edited.snapshot]);
  assert.equal(reviewHistory.nextBeforeRevision, edited.snapshot.revision);
  const firstHistory = await history(reviewer, reviewHistory.nextBeforeRevision);
  assert.equal(firstHistory.beforeRevision, edited.snapshot.revision);
  assert.deepEqual(firstHistory.entries, [first.snapshot]);
  assert.equal(firstHistory.nextBeforeRevision, null);
  assert.deepEqual(
    [...latestHistory.entries, ...reviewHistory.entries, ...firstHistory.entries].map(
      (row) => row.command,
    ),
    [
      "PublishConfiguration",
      "ApproveConfiguration",
      "SubmitConfiguration",
      "SaveConfigurationDraft",
      "SaveConfigurationDraft",
    ],
  );
  const afterPublish = await counts();
  assert.deepEqual(await resolve(reviewer, publishCommand), published);
  assert.deepEqual(await counts(), afterPublish);
  assert.equal(afterPublish.revisions, 5);
  assert.equal(afterPublish.originals, 5);
  assert.equal(afterPublish.published, 1);
  assert.equal(afterPublish.mutations, 4);
  const material = (
    await f.admin.query(
      "SELECT lifecycle,configuration_version_id,approved_by_reference,publication_reference,platform_template_reference,catalog_source_reference FROM bop_tenant.brand_configuration_version WHERE brand_id=$1",
      [brandReference],
    )
  ).rows;
  assert.deepEqual(material, [
    {
      lifecycle: "Published",
      configuration_version_id: published.snapshot.configuration.configurationVersionReference,
      approved_by_reference: reviewer.actorReference,
      publication_reference: published.snapshot.configuration.publicationReference,
      platform_template_reference: selected.templateVersionReference,
      catalog_source_reference: catalog.source.sourceReference,
    },
  ]);
  const mutations = (
    await f.admin.query(
      "SELECT operation_code,actor_id,store_id,mutation_json FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1 ORDER BY lifecycle_version",
      [brandReference],
    )
  ).rows;
  assert.deepEqual(
    mutations.map((row) => row.operation_code),
    ["CreateDraft", "SubmitReview", "Approve", "Publish"],
  );
  assert.deepEqual(
    mutations.map((row) => row.actor_id),
    [
      author.actorReference,
      author.actorReference,
      reviewer.actorReference,
      reviewer.actorReference,
    ],
  );
  assert(mutations.every((row) => row.store_id === null));
  assert.equal(mutations[1].mutation_json.validationEvidence.validUntil, reviewValidUntil);
  assert.equal(
    mutations[3].mutation_json.release.releaseId,
    published.snapshot.configuration.publicationReference,
  );
  assert.equal(
    (
      await f.admin.query(
        "SELECT count(*)::int n FROM platform_audit.audit_record WHERE brand_id=$1 AND audit_id=ANY($2::uuid[])",
        [
          brandReference,
          [
            ...mutations.map((row) => row.mutation_json.audit.auditId),
            first.auditReference,
            edited.auditReference,
            submitted.auditReference,
            approved.auditReference,
            published.auditReference,
            catalog.auditReference,
          ],
        ],
      )
    ).rows[0].n,
    10,
  );
  assert.equal(
    (
      await f.admin.query("SELECT lifecycle FROM bop_tenant.brand WHERE brand_id=$1", [
        brandReference,
      ])
    ).rows[0].lifecycle,
    "Draft",
  );
}
