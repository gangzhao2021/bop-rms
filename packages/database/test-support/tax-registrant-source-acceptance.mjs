import assert from "node:assert/strict";
import pg from "pg";
import {
  createOperatingEntity,
  createOperatingEntityProfileVersion,
  createStoreOperatingEntityAssignment,
} from "../../bop/operating-entity/src/index.ts";
import {
  createPostgresTaxRegistrantSource,
  TaxRegistrantSourceError,
  taxRegistrantSourceRequiredFields,
} from "../../bop/operating-entity/src/infrastructure/persistence/tax-registrant-source.ts";
import {
  createBrand,
  createStore,
  createTenantContext,
  parseCanonicalInstant,
} from "../../bop/tenant/src/index.ts";
import {
  evaluatePermission,
  parseBusinessAction,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
} from "../../bop/permission/src/index.ts";

const id = (n) => `01902601-0020-7000-8000-${n.toString(16).padStart(12, "0")}`;
const now = () => new Date().toISOString();
const scope = Object.freeze({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
});
const plus = (at, milliseconds) => new Date(Date.parse(at) + milliseconds).toISOString();

/** Actual owning SQL and writer barriers. Entity declarations, Tenant context
 * and public Permission evidence are controlled fixtures, not actual IAM,
 * professional registration, approval or legal applicability evidence. */
export async function verifyTaxRegistrantSource(context) {
  const admin = new pg.Client(context.clientConfig);
  const role = `wp2421_tax_registrant_${context.runId}`;
  assert.match(role, /^wp2421_tax_registrant_[a-f0-9]+$/u);
  await admin.connect();
  let createdRole = false;
  const seedAt = plus(now(), -1000);
  const entity = createOperatingEntity({
    operatingEntityReference: id(10),
    kind: "LegalEntity",
    legalName: "Controlled TaxRegistrant fixture",
    tradeName: null,
    jurisdictionCode: "CA-ON",
    registrationReference: id(11),
    taxRegistrationReference: null,
    billingIdentityReference: null,
    settlementReference: null,
    evidenceReference: id(12),
    lifecycle: "Active",
    version: 1,
    createdAt: seedAt,
    updatedAt: seedAt,
  });
  const profile = (reference, revision, recordedAt = seedAt) =>
    createOperatingEntityProfileVersion({
      profileVersionReference: reference,
      operatingEntityReference: entity.operatingEntityReference,
      profileVersion: revision,
      legalName: entity.legalName,
      tradeName: entity.tradeName,
      jurisdictionCode: entity.jurisdictionCode,
      registrationReference: entity.registrationReference,
      taxRegistrationReference: entity.taxRegistrationReference,
      registeredAddressReference: null,
      billingIdentityReference: null,
      settlementReference: null,
      evidenceReferences: [entity.evidenceReference],
      recordedByReference: id(13),
      recordedAt,
      dataClassification: "RestrictedReferenceMetadata",
    });
  const assignment = (reference, storeReference) =>
    createStoreOperatingEntityAssignment({
      assignmentReference: reference,
      brandReference: scope.brandReference,
      storeReference,
      operatingEntityReference: entity.operatingEntityReference,
      businessFunction: "TaxRegistrant",
      lifecycle: "Active",
      effectiveFrom: seedAt,
      effectiveUntil: null,
      version: 1,
      createdAt: seedAt,
      updatedAt: seedAt,
    });
  const setScope = (client, selected) =>
    client.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [selected.tenantReference, selected.brandReference, selected.storeReference],
    );
  const insertAssignment = (client, value) =>
    client.query(
      `INSERT INTO bop_operating_entity.store_operating_entity_assignment(
      assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,
      effective_from,effective_until,version,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        value.assignmentReference,
        value.brandReference,
        value.storeReference,
        value.operatingEntityReference,
        value.businessFunction,
        value.lifecycle,
        value.effectiveFrom,
        value.effectiveUntil,
        value.version,
        value.createdAt,
        value.updatedAt,
      ],
    );
  const insertProfile = (client, value) =>
    client.query(
      `INSERT INTO bop_operating_entity.operating_entity_profile_version(
      profile_version_id,brand_id,store_id,operating_entity_id,profile_version,legal_name,
      trade_name,jurisdiction_code,registration_reference,tax_registration_reference,
      registered_address_reference,billing_identity_reference,settlement_reference,
      evidence_references,recorded_by_reference,recorded_at,data_classification
    ) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid[],$14,$15,$16)`,
      [
        value.profileVersionReference,
        scope.brandReference,
        value.operatingEntityReference,
        value.profileVersion,
        value.legalName,
        value.tradeName,
        value.jurisdictionCode,
        value.registrationReference,
        value.taxRegistrationReference,
        value.registeredAddressReference,
        value.billingIdentityReference,
        value.settlementReference,
        value.evidenceReferences,
        value.recordedByReference,
        value.recordedAt,
        value.dataClassification,
      ],
    );
  const counts = async () =>
    (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM bop_operating_entity.operating_entity) entities,
      (SELECT count(*)::int FROM bop_operating_entity.store_operating_entity_assignment) assignments,
      (SELECT count(*)::int FROM bop_operating_entity.operating_entity_profile_version) profiles`,
      )
    ).rows[0];
  async function reader(work, selected = scope) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    let committed = false,
      sqlFailure = null;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SET LOCAL ROLE ${role}`);
      await setScope(client, selected);
      const origin = now(),
        deadline = plus(origin, 5000);
      const hooks = [],
        queries = [];
      const state = { allowed: true, lease: deadline };
      const tx = Object.freeze({
        async query(sql, values) {
          queries.push(sql);
          try {
            return await client.query(sql, values);
          } catch (error) {
            const stage = sql.startsWith("SELECT jsonb_build_object")
              ? "CurrentMetadata"
              : sql.startsWith("SELECT operating_entity_id")
                ? "AssignmentIdentity"
                : sql.includes("pg_advisory_xact_lock_shared")
                  ? "SourceBarrier"
                  : sql.startsWith("SELECT set_config")
                    ? "RestoreScope"
                    : sql.includes("transaction_isolation")
                      ? "TransactionIsolation"
                      : "OtherSourceSql";
            if (sqlFailure === null)
              sqlFailure = {
                stage,
                code:
                  typeof error.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
                    ? error.code
                    : "UNKNOWN",
              };
            throw error;
          }
        },
      });
      const brand = createBrand({
        brandReference: selected.brandReference,
        code: "TAX_REGISTRANT",
        displayName: "Controlled brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: seedAt,
        updatedAt: seedAt,
      });
      const store = createStore({
        storeReference: selected.storeReference,
        brandReference: selected.brandReference,
        code: "CONTROLLED_STORE",
        displayName: "Controlled store",
        locale: "en-CA",
        timeZone: "America/Toronto",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: seedAt,
        updatedAt: seedAt,
      });
      const source = createPostgresTaxRegistrantSource({
        ...selected,
        originalObservedAt: origin,
        originalValidUntil: deadline,
        clock: { now },
        registerBeforeCommit(actual, guard, final) {
          assert.equal(actual, tx);
          assert.equal(hooks.length, 0);
          hooks.push({ guard, final });
        },
        authority: {
          async holdUntilTransactionCompletes(actual, request) {
            assert.equal(actual, tx);
            for (const [key, value] of Object.entries(selected)) assert.equal(request[key], value);
            assert.equal(request.actorKind, "User");
            assert.equal(request.permission, "organization.manage");
            assert.equal(request.purposeCode, "TAX_REGISTRANT_SOURCE");
            assert.equal(request.businessFunction, "TaxRegistrant");
            assert.equal(request.effectiveAt, origin);
            assert.deepEqual(request.requiredFields, taxRegistrantSourceRequiredFields);
            assert.ok(request.observedAt >= origin && request.observedAt <= now());
            assert.ok(request.validUntil <= deadline);
            const tenantContext = createTenantContext(
              {
                actorType: "User",
                actorReference: selected.actorReference,
                accountKind: "Workforce",
                status: "Active",
                authenticationMethod: "Oidc",
                verificationLevel: "SingleFactor",
                authenticatedAt: origin,
                recentMfaAt: null,
              },
              brand,
              store,
              now(),
            );
            const action = parseBusinessAction(request.permission);
            const permission = evaluatePermission({
              tenantContext,
              action,
              resourceScope: {
                kind: "Store",
                brandReference: brand.brandReference,
                storeReference: store.storeReference,
              },
              policySnapshotReference: parsePolicyReference(id(30)),
              policyVersion: parsePolicyVersion(1),
              evidence: state.allowed
                ? [
                    {
                      source: "RolePermission",
                      evidenceReference: parseEvidenceReference(id(31)),
                      action,
                      actorReference: tenantContext.actor.actorReference,
                      roleReference: parseRoleReference(id(32)),
                      brandReference: brand.brandReference,
                      storeReference: store.storeReference,
                      effectiveFrom: parseCanonicalInstant(origin),
                      effectiveUntil: null,
                    },
                  ]
                : [],
            });
            if (permission.effect !== "Allow")
              throw new TaxRegistrantSourceError("TAX_REGISTRANT_PERMISSION_DENIED");
            return { scope: selected, tenantContext, permission, validUntil: state.lease };
          },
        },
      });
      const read = () => source.resolve({ transaction: tx, effectiveAt: origin });
      const finish = async () => {
        assert.equal(hooks.length, 1);
        for (const hook of hooks) await hook.guard();
        for (const hook of hooks) hook.final();
        await client.query("COMMIT");
        committed = true;
        return source.assertFinalized(tx);
      };
      return await work({ client, tx, source, state, origin, deadline, read, finish, queries });
    } catch (error) {
      if (sqlFailure !== null)
        throw new Error(
          `TaxRegistrant source native failed: stage=${sqlFailure.stage} SQLSTATE=${sqlFailure.code}`,
          { cause: error },
        );
      throw error;
    } finally {
      if (!committed) await client.query("ROLLBACK");
      await client.end();
    }
  }
  // The INSERT actually reaches the owning BEFORE trigger and blocks there;
  // retry occurs in a new transaction after the held reader really commits.
  async function blockedInsert(readHeld, selected, insert) {
    const writer = new pg.Client(context.clientConfig);
    await writer.connect();
    try {
      const baseline = await counts();
      await reader(async (held) => {
        await readHeld(held);
        await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await writer.query("SET LOCAL lock_timeout='100ms'");
        await writer.query("SET LOCAL statement_timeout='2s'");
        await setScope(writer, selected);
        await assert.rejects(insert(writer), (error) => error.code === "55P03");
        await writer.query("ROLLBACK");
        assert.deepEqual(await counts(), baseline);
        await held.finish();
      }, selected);
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await writer.query("SET LOCAL lock_timeout='1s'");
      await writer.query("SET LOCAL statement_timeout='2s'");
      await setScope(writer, selected);
      assert.equal((await insert(writer)).rowCount, 1);
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
    }
  }
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    createdRole = true;
    await admin.query(`GRANT USAGE ON SCHEMA bop_operating_entity,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON bop_operating_entity.operating_entity,bop_operating_entity.brand_operating_entity_assignment,bop_operating_entity.store_operating_entity_assignment,bop_operating_entity.operating_entity_profile_version TO ${role}`,
    );
    await admin.query(
      `GRANT UPDATE(version) ON bop_operating_entity.operating_entity,bop_operating_entity.store_operating_entity_assignment TO ${role}`,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'bop_operating_entity.operating_entity_profile_version','UPDATE') allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.operating_entity(
        operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,
        tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,
        lifecycle,version,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        entity.operatingEntityReference,
        entity.kind,
        entity.legalName,
        entity.tradeName,
        entity.jurisdictionCode,
        entity.registrationReference,
        entity.taxRegistrationReference,
        entity.billingIdentityReference,
        entity.settlementReference,
        entity.evidenceReference,
        entity.lifecycle,
        entity.version,
        entity.createdAt,
        entity.updatedAt,
      ],
    );
    await insertAssignment(admin, assignment(id(40), scope.storeReference));
    await insertProfile(admin, profile(id(41), 7));
    await reader(async (held) => {
      const result = await held.read();
      assert.equal(result.entityVersion, 1);
      assert.equal(result.profileVersion, 7);
      assert.equal(result.operatingEntityProfileVersionReference, id(41));
      assert.equal(result.taxRegistrationReference, null);
      assert.equal(result.registrationReference, entity.registrationReference);
      assert.equal(result.qualification, "NotEvaluated");
      assert.equal(Object.hasOwn(result, "billingIdentityReference"), false);
      assert.ok(Object.isFrozen(result));
      assert.equal(await held.finish(), held.deadline);
    });
    await reader(
      async (held) => {
        assert.equal(await held.read(), null);
        assert.equal(
          held.queries.some((sql) => sql.startsWith("SELECT jsonb_build_object")),
          false,
        );
        await held.finish();
      },
      { ...scope, brandReference: id(99), storeReference: id(98) },
    );
    const absentScope = { ...scope, storeReference: id(50) };
    await blockedInsert(
      async (held) => {
        assert.equal(await held.read(), null);
      },
      absentScope,
      (writer) => insertAssignment(writer, assignment(id(51), absentScope.storeReference)),
    );
    await reader(async (held) => {
      assert.equal((await held.read()).assignmentReference, id(51));
      await held.finish();
    }, absentScope);
    await blockedInsert(
      async (held) => {
        assert.equal((await held.read()).operatingEntityProfileVersionReference, id(41));
      },
      scope,
      (writer) => insertProfile(writer, profile(id(42), 8, now())),
    );
    await reader(async (held) => {
      assert.equal((await held.read()).operatingEntityProfileVersionReference, id(42));
      await held.finish();
    });
    const baseline = await counts();
    await reader(async (held) => {
      await held.read();
      held.state.allowed = false;
      await assert.rejects(held.finish(), { code: "TAX_REGISTRANT_PERMISSION_DENIED" });
      assert.throws(() => held.source.assertFinalized(held.tx), {
        code: "TAX_REGISTRANT_UNAVAILABLE",
      });
    });
    await reader(async (held) => {
      held.state.lease = plus(held.origin, 1000);
      const result = await held.read();
      assert.equal(result.validUntil, held.state.lease);
      const remaining = Math.max(0, Date.parse(held.state.lease) - Date.now()) + 20;
      await new Promise((resolve) => setTimeout(resolve, remaining));
      await assert.rejects(held.finish(), { code: "TAX_REGISTRANT_UNAVAILABLE" });
    });
    await reader(async (held) => {
      await held.read();
      assert.equal(
        (
          await held.tx.query(
            "UPDATE bop_operating_entity.store_operating_entity_assignment SET version=version+1 WHERE assignment_id=$1",
            [id(40)],
          )
        ).rowCount,
        1,
      );
      await assert.rejects(held.finish(), { code: "TAX_REGISTRANT_UNAVAILABLE" });
    });
    assert.deepEqual(await counts(), baseline);
    await reader(async (held) => {
      assert.equal((await held.read()).assignmentVersion, 1);
      await held.finish();
    });
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("RESET ROLE");
    if (createdRole) {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
    await admin.end();
  }
}
import { setTimeout } from "node:timers";
