import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9e50-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T13:00:00.000Z";
const later = "2026-08-16T13:00:00.000Z";
const digest = `sha256:${"c".repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2190_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_operating_entity.operating_entity(
        operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,
        tax_registration_reference,billing_identity_reference,settlement_reference,
        evidence_reference,lifecycle,version,created_at,updated_at
      ) VALUES($1,'LegalEntity','Synthetic Ontario Incorporated','Synthetic Kitchen','CA-ON',
        $2,$3,$4,$5,$6,'Active',1,$7,$7)`,
      [id(10), id(11), id(12), id(13), id(14), id(15), at],
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.brand_operating_entity_assignment(
        assignment_id,brand_id,operating_entity_id,business_function,lifecycle,effective_from,
        effective_until,version,created_at,updated_at
      ) VALUES($1,$2,$3,'SalesReceiptIssuer','Active',$4,NULL,1,$4,$4)`,
      [id(20), id(1), id(10), at],
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.store_operating_entity_assignment(
        assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,
        effective_from,effective_until,version,created_at,updated_at
      ) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)`,
      [id(21), id(1), id(2), id(10), at],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO bop_operating_entity.store_operating_entity_assignment(
          assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,
          effective_from,effective_until,version,created_at,updated_at
        ) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)`,
        [id(22), id(1), id(2), id(10), later],
      ),
      /overlaps an active assignment/u,
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.operating_entity_profile_version(
        profile_version_id,brand_id,store_id,operating_entity_id,profile_version,legal_name,
        trade_name,jurisdiction_code,registration_reference,tax_registration_reference,
        registered_address_reference,billing_identity_reference,settlement_reference,
        evidence_references,recorded_by_reference,recorded_at,data_classification
      ) VALUES($1,$2,NULL,$3,1,'Synthetic Ontario Incorporated','Synthetic Kitchen','CA-ON',
        $4,$5,$6,$7,$8,ARRAY[$9]::uuid[],$10,$11,'RestrictedReferenceMetadata')`,
      [id(30), id(1), id(10), id(11), id(12), id(16), id(13), id(14), id(15), id(40), at],
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.operating_entity_approval_decision(
        decision_id,brand_id,store_id,operating_entity_id,entity_version,decision,
        submitted_by_reference,decided_by_reference,approval_evidence_reference,purpose_code,
        decided_at,data_classification
      ) VALUES($1,$2,NULL,$3,1,'Approved',$4,$5,$6,'LEGAL_ENTITY.ADMINISTRATION',$7,
        'RestrictedReferenceMetadata')`,
      [id(31), id(1), id(10), id(40), id(41), id(42), at],
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.operating_entity_authority_version(
        authority_version_id,brand_id,store_id,operating_entity_id,authority_subject_reference,
        authority_role_code,title_code,status,effective_from,effective_until,
        restricted_detail_reference,approval_evidence_reference,authority_version,recorded_at,
        data_classification
      ) VALUES($1,$2,NULL,$3,$4,'Officer','PRESIDENT','Active',$5,NULL,$6,$7,1,$5,
        'RestrictedReferenceMetadata')`,
      [id(32), id(1), id(10), id(43), at, id(44), id(42)],
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.business_function_assignment_decision(
        assignment_decision_id,brand_id,store_id,assignment_id,operating_entity_id,
        business_function,effective_from,effective_until,requested_by_reference,
        approved_by_reference,approval_evidence_reference,recorded_at,data_classification
      ) VALUES($1,$2,$3,$4,$5,'SalesReceiptIssuer',$6,NULL,$7,$8,$9,$6,
        'RestrictedReferenceMetadata')`,
      [id(33), id(1), id(2), id(21), id(10), at, id(40), id(41), id(42)],
    );
    await admin.query(
      `INSERT INTO bop_operating_entity.operating_entity_admin_operation(
        operation_id,brand_id,store_id,operating_entity_id,command_type,intent_digest,
        entity_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification
      ) VALUES($1,$2,NULL,$3,'ActivateEntity',$4,1,$5,'LEGAL_ENTITY.ADMINISTRATION',$6,$7,
        'RestrictedReferenceMetadata')`,
      [id(34), id(1), id(10), digest, id(41), id(45), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_operating_entity.operating_entity_profile_version
         SET legal_name='Changed' WHERE profile_version_id=$1`,
        [id(30)],
      ),
      /administration history is append-only/u,
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_operating_entity.operating_entity SET version=3,updated_at=$1
         WHERE operating_entity_id=$2`,
        [later, id(10)],
      ),
      /identity or revision is invalid/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_operating_entity,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON bop_operating_entity.operating_entity_profile_version,
       bop_operating_entity.operating_entity_approval_decision,
       bop_operating_entity.operating_entity_authority_version,
       bop_operating_entity.business_function_assignment_decision,
       bop_operating_entity.operating_entity_admin_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_operating_entity.operating_entity_profile_version`))
        .rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(1)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_operating_entity.operating_entity_profile_version`))
        .rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_operating_entity.operating_entity_authority_version`))
        .rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_operating_entity.operating_entity_admin_operation`))
        .rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Operating Entity revision, masked append-only administration, unique Store function and RLS", async () => {
  await withIsolatedDatabase({ caseId: "entity_admin", root }, prove);
}, 120_000);
