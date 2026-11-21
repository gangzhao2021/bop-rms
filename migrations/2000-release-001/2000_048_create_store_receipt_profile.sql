-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): what the Store's Owner has entered for its
-- customer receipts and privacy notice — the GST/HST, QST and PST registration numbers printed on
-- receipts (each optional: a Store that is not registered for a tax prints none) and the link to
-- the Store's own privacy notice. Legal facts are the Owner's; nothing here is inferred. Each change
-- is an append-only version (who, when, operation, audit); the current details are the highest
-- version. Receipts already issued keep the numbers they were issued with.
CREATE FUNCTION rms_store.reject_store_receipt_profile_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only store receipt profile' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_store.reject_store_receipt_profile_mutation() FROM PUBLIC;

CREATE TABLE rms_store.store_receipt_profile (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 gst_hst_number text CHECK (gst_hst_number ~ '^[0-9]{9}RT[0-9]{4}$'),
 qst_number text CHECK (qst_number ~ '^[0-9]{10}TQ[0-9]{4}$'),
 pst_number text CHECK (pst_number ~ '^[A-Z0-9][A-Z0-9 -]{2,30}[A-Z0-9]$'),
 privacy_notice_url text CHECK (
  length(privacy_notice_url) BETWEEN 12 AND 500
  AND privacy_notice_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]<>"]*)?$'
 ),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT store_receipt_profile_operation_unique UNIQUE (brand_id,store_id,operation_id)
);

-- Versions are contiguous per Store, never go back in time, and every version changes something.
CREATE FUNCTION rms_store.check_store_receipt_profile_sequence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 previous rms_store.store_receipt_profile;
BEGIN
 SELECT p.* INTO previous FROM rms_store.store_receipt_profile p
 WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id ORDER BY p.version DESC LIMIT 1;
 IF NEW.version<>COALESCE(previous.version,0)+1
  OR (previous.version IS NOT NULL AND (NEW.recorded_at<previous.recorded_at OR (
   NEW.gst_hst_number IS NOT DISTINCT FROM previous.gst_hst_number
   AND NEW.qst_number IS NOT DISTINCT FROM previous.qst_number
   AND NEW.pst_number IS NOT DISTINCT FROM previous.pst_number
   AND NEW.privacy_notice_url IS NOT DISTINCT FROM previous.privacy_notice_url)))
 THEN
  RAISE EXCEPTION 'store receipt profile out of sequence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_receipt_profile_sequence() FROM PUBLIC;

CREATE TRIGGER store_receipt_profile_sequence BEFORE INSERT ON rms_store.store_receipt_profile
 FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_receipt_profile_sequence();
CREATE TRIGGER store_receipt_profile_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_receipt_profile
 FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_receipt_profile_mutation();
CREATE TRIGGER store_receipt_profile_no_truncate BEFORE TRUNCATE ON rms_store.store_receipt_profile
 FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_receipt_profile_mutation();
ALTER TABLE rms_store.store_receipt_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_receipt_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY store_receipt_profile_scope ON rms_store.store_receipt_profile
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_receipt_profile FROM PUBLIC;
