-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.digital_receipt_record (
  record_id platform_helpers.uuid_v7 PRIMARY KEY,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  receipt_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('Original','Correction','Void','Refund','Reissue')),
  previous_record_id platform_helpers.uuid_v7,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL CHECK (
    isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)
  ),
  receipt_record_json jsonb NOT NULL,
  UNIQUE (brand_id,store_id,operation_id),
  UNIQUE (brand_id,store_id,audit_id),
  UNIQUE (brand_id,store_id,order_id,version),
  UNIQUE (record_id,brand_id,store_id,order_id,receipt_id,guest_session_id),
  FOREIGN KEY (order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
  FOREIGN KEY (previous_record_id,brand_id,store_id,order_id,receipt_id,guest_session_id)
    REFERENCES rms_ordering.digital_receipt_record
      (record_id,brand_id,store_id,order_id,receipt_id,guest_session_id),
  CHECK ((version=1 AND kind='Original' AND previous_record_id IS NULL)
    OR (version>1 AND kind<>'Original' AND previous_record_id IS NOT NULL)),
  CONSTRAINT digital_receipt_record_binding_check CHECK ((
    jsonb_typeof(receipt_record_json)='object'
    AND receipt_record_json - ARRAY['recordReference','version','kind','recordedAt',
      'previousRecordReference','reasonCode','snapshot']='{}'::jsonb
    AND receipt_record_json ?& ARRAY['recordReference','version','kind','recordedAt',
      'previousRecordReference','reasonCode','snapshot']
    AND receipt_record_json->>'recordReference'=record_id::text
    AND receipt_record_json->'version'=to_jsonb(version)
    AND receipt_record_json->>'kind'=kind
    AND (receipt_record_json->>'recordedAt')::timestamptz=recorded_at
    AND (receipt_record_json->>'previousRecordReference') IS NOT DISTINCT FROM previous_record_id::text
    AND ((version=1 AND receipt_record_json->'reasonCode'='null'::jsonb)
      OR (version>1 AND receipt_record_json->>'reasonCode' ~ '^[A-Z][A-Z0-9_]{0,63}$'))
    AND jsonb_typeof(receipt_record_json->'snapshot')='object'
    AND receipt_record_json #>> '{snapshot,orderReference}'=order_id::text
    AND receipt_record_json #>> '{snapshot,receiptReference}'=receipt_id::text
    AND receipt_record_json #>> '{snapshot,guestSessionReference}'=guest_session_id::text
    AND receipt_record_json #>> '{snapshot,brandReference}'=brand_id::text
    AND receipt_record_json #>> '{snapshot,storeReference}'=store_id::text
    AND (receipt_record_json #>> '{snapshot,issuedAt}')::timestamptz <= recorded_at
  ) IS TRUE)
);
CREATE RULE digital_receipt_record_no_update AS
  ON UPDATE TO rms_ordering.digital_receipt_record DO INSTEAD NOTHING;
CREATE RULE digital_receipt_record_no_delete AS
  ON DELETE TO rms_ordering.digital_receipt_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.digital_receipt_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.digital_receipt_record FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_record_scope ON rms_ordering.digital_receipt_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.digital_receipt_record FROM PUBLIC;
