-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_inventory.stock_lot_hold_version (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 hold_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
 status text NOT NULL CHECK (status IN ('Available','Quarantined')),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object'),
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,store_id,account_id,version),
 UNIQUE (tenant_id,brand_id,store_id,operation_id),
 UNIQUE (tenant_id,brand_id,store_id,hold_id,version),
 FOREIGN KEY (tenant_id,brand_id,store_id,account_id)
  REFERENCES rms_inventory.stock_account (tenant_id,brand_id,store_id,account_id),
 CHECK (isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
 CHECK ((
  record_json->>'operationReference'=operation_id::text AND record_json->>'intentHash'=intent_hash
  AND record_json->'hold'->>'tenantReference'=tenant_id::text
  AND record_json->'hold'->>'brandReference'=brand_id::text
  AND record_json->'hold'->>'holdReference'=hold_id::text
  AND record_json->'hold'->>'aggregateVersion'=version::text
  AND record_json->'hold'->>'status'=status
  AND record_json->'audit'->>'auditId'=audit_id::text
  AND record_json->'hold'->>'updatedAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 ) IS TRUE)
);
CREATE FUNCTION rms_inventory.enforce_lot_hold_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE account rms_inventory.stock_account%ROWTYPE;
DECLARE balance rms_inventory.stock_balance%ROWTYPE;
DECLARE previous rms_inventory.stock_lot_hold_version%ROWTYPE;
BEGIN
 SELECT * INTO STRICT account FROM rms_inventory.stock_account WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND account_id=NEW.account_id FOR UPDATE;
 SELECT * INTO STRICT balance FROM rms_inventory.stock_balance WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND account_id=NEW.account_id FOR UPDATE;
 IF (account.lot_id IS NOT NULL
  AND NEW.record_json->'hold'->>'itemReference'=account.item_id::text
  AND NEW.record_json->'hold'->>'locationReference'=account.location_id::text
  AND NEW.record_json->'hold'->>'lotReference'=account.lot_id::text
  AND (NEW.record_json->'hold'->>'expiryDate') IS NOT DISTINCT FROM account.expiry_date::text
  AND (NEW.record_json->'hold'->>'onHand')::numeric=balance.on_hand
  AND (NEW.record_json->'hold'->>'reserved')::numeric=balance.reserved
  AND (NEW.record_json->'hold'->>'balanceVersion')::bigint=balance.ledger_version
  AND NEW.occurred_at>=account.created_at) IS NOT TRUE THEN
  RAISE EXCEPTION 'Lot Hold account or balance conflict' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM rms_inventory.stock_lot_hold_version WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND account_id=NEW.account_id ORDER BY version DESC LIMIT 1;
 IF FOUND THEN
  IF NEW.version<>previous.version+1 OR NEW.hold_id<>previous.hold_id OR NEW.status=previous.status
    OR NEW.occurred_at<previous.occurred_at THEN
   RAISE EXCEPTION 'Lot Hold version conflict' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.version<>1 OR NEW.status<>'Quarantined' THEN
  RAISE EXCEPTION 'initial Lot Hold invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_lot_hold_version() FROM PUBLIC;
CREATE TRIGGER stock_lot_hold_sequence BEFORE INSERT ON rms_inventory.stock_lot_hold_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_lot_hold_version();
CREATE TRIGGER stock_lot_hold_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_lot_hold_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_lot_hold_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_lot_hold_version
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
ALTER TABLE rms_inventory.stock_lot_hold_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_lot_hold_version FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_lot_hold_scope ON rms_inventory.stock_lot_hold_version
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_lot_hold_version FROM PUBLIC;
