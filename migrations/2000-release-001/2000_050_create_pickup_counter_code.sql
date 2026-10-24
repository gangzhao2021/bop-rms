-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (DEC-PICKUP-COUNTER-CODE): a guest reads a short six-digit pickup code to staff, who type
-- it at the counter when the long code cannot be scanned. The short code belongs to one pickup
-- proof generation (one order at one Store, valid only while that proof is valid: at most an hour
-- after the order is ready). Only keyed hashes are stored, never the code:
--   selector_hash  the code bound to this Brand/Store/Fulfillment (what a check compares);
--   lookup_hash    the code bound to the Store only, so two orders whose pickup windows overlap
--                  never share a code (the insert trigger refuses a collision; the issuer then
--                  derives the next candidate).
-- A wrong code is an append-only rejected check naming the staff member, never the code typed.
-- Five rejected checks lock code checks for that proof; staff then verify the guest in person
-- (order number with the name or the last four phone digits), recorded with reason CodeLocked.
CREATE TABLE rms_fulfillment.pickup_counter_code (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  capability_id platform_helpers.uuid_v7 NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  derivation_index smallint NOT NULL CHECK (derivation_index BETWEEN 0 AND 15),
  pepper_version integer NOT NULL CHECK (pepper_version > 0),
  selector_hash text NOT NULL CHECK (selector_hash ~ '^[0-9a-f]{64}$'),
  lookup_hash text NOT NULL CHECK (lookup_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedCredential'),
  CONSTRAINT pickup_counter_code_pkey PRIMARY KEY (brand_id, store_id, capability_id),
  CONSTRAINT pickup_counter_code_scope_unique
    UNIQUE (brand_id, store_id, fulfillment_id, capability_id, generation),
  CONSTRAINT pickup_counter_code_selector_unique UNIQUE (brand_id, store_id, selector_hash),
  CONSTRAINT pickup_counter_code_generation_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, capability_id, generation)
    REFERENCES rms_fulfillment.pickup_proof_generation (
      brand_id, store_id, fulfillment_id, capability_id, generation
    ),
  CONSTRAINT pickup_counter_code_lifetime_check CHECK (
    issued_at < expires_at AND expires_at <= issued_at + interval '60 minutes'
  )
);
CREATE INDEX pickup_counter_code_lookup_idx
  ON rms_fulfillment.pickup_counter_code (brand_id, store_id, lookup_hash, expires_at);

CREATE FUNCTION rms_fulfillment.reject_pickup_counter_code_collision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- Serialise issuers of the same code at this Store, then refuse a code still valid for another order.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'PickupCounterCodeV1:' || NEW.brand_id::text || ':' || NEW.store_id::text || ':' || NEW.lookup_hash,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM rms_fulfillment.pickup_counter_code c
    WHERE c.brand_id = NEW.brand_id
      AND c.store_id = NEW.store_id
      AND c.lookup_hash = NEW.lookup_hash
      AND c.expires_at > NEW.issued_at
      AND c.issued_at < NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'PICKUP_COUNTER_CODE_COLLISION' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.reject_pickup_counter_code_collision() FROM PUBLIC;
CREATE TRIGGER pickup_counter_code_collision_trigger
  BEFORE INSERT ON rms_fulfillment.pickup_counter_code
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_pickup_counter_code_collision();
CREATE TRIGGER pickup_counter_code_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.pickup_counter_code
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_counter_code_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_counter_code DO INSTEAD NOTHING;

CREATE TABLE rms_fulfillment.pickup_code_check_rejection (
  pickup_code_check_rejection_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  capability_id platform_helpers.uuid_v7 NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  entry_method text NOT NULL CHECK (entry_method IN ('Opaque', 'HumanCode')),
  checked_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  rejection_number integer NOT NULL CHECK (rejection_number BETWEEN 1 AND 5),
  rejected_at timestamp with time zone NOT NULL
    CHECK (rejected_at = date_trunc('milliseconds', rejected_at)),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_code_check_rejection_pkey
    PRIMARY KEY (brand_id, store_id, pickup_code_check_rejection_id),
  -- At most five rejected checks per proof generation; the fifth locks code checks.
  CONSTRAINT pickup_code_check_rejection_number_unique
    UNIQUE (brand_id, store_id, capability_id, rejection_number),
  CONSTRAINT pickup_code_check_rejection_generation_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, capability_id, generation)
    REFERENCES rms_fulfillment.pickup_proof_generation (
      brand_id, store_id, fulfillment_id, capability_id, generation
    ),
  CONSTRAINT pickup_code_check_rejection_distinct_check
    CHECK (pickup_code_check_rejection_id::uuid <> correlation_id::uuid)
);
CREATE TRIGGER pickup_code_check_rejection_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.pickup_code_check_rejection
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_code_check_rejection_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_code_check_rejection DO INSTEAD NOTHING;

ALTER TABLE rms_fulfillment.pickup_counter_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_counter_code FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_code_check_rejection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_code_check_rejection FORCE ROW LEVEL SECURITY;
CREATE POLICY pickup_counter_code_store_scope_policy
  ON rms_fulfillment.pickup_counter_code
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY pickup_code_check_rejection_store_scope_policy
  ON rms_fulfillment.pickup_code_check_rejection
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.pickup_counter_code FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.pickup_code_check_rejection FROM PUBLIC;

-- In person is also allowed once code checks are locked for a still-valid proof.
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  DROP CONSTRAINT pickup_in_person_verification_reason_check;
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  ADD CONSTRAINT pickup_in_person_verification_reason_check
    CHECK (reason IN ('ProofExpired', 'ProofNotIssued', 'CodeLocked'));
