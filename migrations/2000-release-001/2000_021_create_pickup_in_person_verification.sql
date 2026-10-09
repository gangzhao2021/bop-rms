-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: a customer who arrives after the pickup proof expired (or before one could be issued)
-- is handed the order after staff verify them in person: the order number together with the name
-- on the order or the last four digits of the phone on it. The verification is its own append-only
-- fact naming the verifying staff member; a handoff references either a proof verification or an
-- in-person verification, never both. A valid proof is still required while one exists (enforced
-- by the owner writer, which holds the fulfillment fence).
CREATE TABLE rms_fulfillment.pickup_in_person_verification (
  pickup_in_person_verification_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  verified_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  identity_check text NOT NULL CHECK (
    identity_check IN ('OrderNumberAndName', 'OrderNumberAndPhoneLast4')
  ),
  reason text NOT NULL CHECK (reason IN ('ProofExpired', 'ProofNotIssued')),
  verified_at timestamp with time zone NOT NULL
    CHECK (verified_at = date_trunc('milliseconds', verified_at)),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_in_person_verification_pkey
    PRIMARY KEY (brand_id, store_id, pickup_in_person_verification_id),
  CONSTRAINT pickup_in_person_verification_scope_unique
    UNIQUE (brand_id, store_id, fulfillment_id, pickup_in_person_verification_id),
  CONSTRAINT pickup_in_person_verification_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_in_person_verification_distinct_check
    CHECK (pickup_in_person_verification_id::uuid <> correlation_id::uuid)
);
CREATE TRIGGER pickup_in_person_verification_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.pickup_in_person_verification FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_in_person_verification_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_in_person_verification DO INSTEAD NOTHING;
ALTER TABLE rms_fulfillment.pickup_in_person_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_in_person_verification FORCE ROW LEVEL SECURITY;
CREATE POLICY pickup_in_person_verification_store_scope_policy
  ON rms_fulfillment.pickup_in_person_verification
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.pickup_in_person_verification FROM PUBLIC;

ALTER TABLE rms_fulfillment.pickup_handoff_record
  ALTER COLUMN pickup_proof_verification_id DROP NOT NULL;
ALTER TABLE rms_fulfillment.pickup_handoff_record
  ADD COLUMN pickup_in_person_verification_id platform_helpers.uuid_v7;
ALTER TABLE rms_fulfillment.pickup_handoff_record
  DROP CONSTRAINT pickup_handoff_record_verification_method_check;
ALTER TABLE rms_fulfillment.pickup_handoff_record
  ADD CONSTRAINT pickup_handoff_record_verification_method_check CHECK (
    (verification_method IN ('Opaque', 'HumanCode')
      AND pickup_proof_verification_id IS NOT NULL
      AND pickup_in_person_verification_id IS NULL)
    OR (verification_method = 'InPerson'
      AND pickup_proof_verification_id IS NULL
      AND pickup_in_person_verification_id IS NOT NULL)
  );
ALTER TABLE rms_fulfillment.pickup_handoff_record
  ADD CONSTRAINT pickup_handoff_record_in_person_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, pickup_in_person_verification_id)
    REFERENCES rms_fulfillment.pickup_in_person_verification (
      brand_id, store_id, fulfillment_id, pickup_in_person_verification_id
    );
-- The FulfillmentCompleted publication carries how the customer was verified.
ALTER TABLE rms_fulfillment.fulfillment_completion_publication
  DROP CONSTRAINT fulfillment_completion_publication_verification_method_check;
ALTER TABLE rms_fulfillment.fulfillment_completion_publication
  ADD CONSTRAINT fulfillment_completion_publication_verification_method_check
    CHECK (verification_method IN ('Opaque', 'HumanCode', 'InPerson'));
