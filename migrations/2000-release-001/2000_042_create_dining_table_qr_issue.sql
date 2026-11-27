-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q11 (DEC-TABLE-QR-ISSUANCE): each table QR code a Store prints. A row is written in the
-- same transaction as the IssueQr table operation that raised the table's QR version, and keeps
-- the signed code exactly as printed so the sticker can be reprinted without changing it. The code
-- is public (it is printed on the table); it carries no secret. A table keeps one public table
-- reference across replacements. Rows are append-only: a replaced or turned-off code stays as
-- history and is recognised at entry so the customer is told to ask staff.
CREATE TABLE rms_dining.dining_table_qr_issue (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 table_id platform_helpers.uuid_v7 NOT NULL,
 qr_id platform_helpers.uuid_v7 NOT NULL,
 public_store_id platform_helpers.uuid_v7 NOT NULL,
 public_table_id platform_helpers.uuid_v7 NOT NULL,
 qr_version bigint NOT NULL CHECK (qr_version BETWEEN 1 AND 9007199254740991),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
 qr_token text NOT NULL CHECK (octet_length(qr_token) BETWEEN 1 AND 2048
  AND qr_token ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$'),
 issued_at timestamptz NOT NULL CHECK (isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)),
 CONSTRAINT dining_table_qr_issue_pk PRIMARY KEY (brand_id,store_id,qr_id),
 CONSTRAINT dining_table_qr_issue_version UNIQUE (tenant_id,brand_id,store_id,table_id,qr_version),
 CONSTRAINT dining_table_qr_issue_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_table_qr_issue_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '180 days'),
 CONSTRAINT dining_table_qr_issue_table_fk FOREIGN KEY (tenant_id,brand_id,store_id,table_id)
  REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
 CONSTRAINT dining_table_qr_issue_operation_fk FOREIGN KEY (brand_id,store_id,operation_id)
  REFERENCES rms_dining.dining_table_operation(brand_id,store_id,operation_id)
);
CREATE INDEX dining_table_qr_issue_public_table_idx
 ON rms_dining.dining_table_qr_issue (brand_id,store_id,public_table_id,qr_version DESC);

-- The row must match the IssueQr operation that produced it (same table, same QR version, same
-- instant) and a table keeps one public reference that no other table of the Store uses.
CREATE FUNCTION rms_dining.check_dining_table_qr_issue() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_dining.dining_table_operation o
  WHERE o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id AND o.operation_id=NEW.operation_id
   AND o.tenant_id=NEW.tenant_id AND o.table_id=NEW.table_id
   AND o.record_json#>>'{audit,actionCode}'='DINING_TABLE_ISSUEQR'
   AND o.record_json#>>'{table,qrStatus}'='Active'
   AND (o.record_json#>>'{table,qrVersion}')::numeric=NEW.qr_version
   AND o.occurred_at=NEW.issued_at
 ) THEN
  RAISE EXCEPTION 'table QR issue does not match its table operation' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM rms_dining.dining_table_qr_issue q
  WHERE q.brand_id=NEW.brand_id AND q.store_id=NEW.store_id
   AND ((q.table_id=NEW.table_id AND q.public_table_id<>NEW.public_table_id)
    OR (q.table_id<>NEW.table_id AND q.public_table_id=NEW.public_table_id))
 ) THEN
  RAISE EXCEPTION 'table QR public reference conflict' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.check_dining_table_qr_issue() FROM PUBLIC;
CREATE TRIGGER dining_table_qr_issue_check BEFORE INSERT ON rms_dining.dining_table_qr_issue
 FOR EACH ROW EXECUTE FUNCTION rms_dining.check_dining_table_qr_issue();

CREATE FUNCTION rms_dining.reject_dining_table_qr_issue_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only table QR issue' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_table_qr_issue_mutation() FROM PUBLIC;
CREATE TRIGGER dining_table_qr_issue_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_table_qr_issue
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_table_qr_issue_mutation();

ALTER TABLE rms_dining.dining_table_qr_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_table_qr_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_qr_issue_scope ON rms_dining.dining_table_qr_issue
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_table_qr_issue FROM PUBLIC;
