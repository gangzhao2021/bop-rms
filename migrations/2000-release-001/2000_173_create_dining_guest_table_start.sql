-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINING-GUEST-TABLE-START: at a Store that turned the switch on, a guest scanning a free
-- table can start it with no staff. Pay first only, so nothing reaches the kitchen unpaid: the
-- database refuses the switch at a pay-later Store, pay later while the switch is on, and a guest
-- start at a table that was not opened pay first. Each start is recorded with the setting version it
-- relied on, and at most 3 per table and 40 per Store start in any 10 minutes. Off until the owner
-- turns it on (existing versions read as off); append-only, Store RLS.
-- Grants: api SELECT/INSERT on dining_session_guest_start (Owner standing approval 2026-10-14,
-- WP-2423); dining_service_setting keeps its grants.
ALTER TABLE rms_dining.dining_service_setting
 ADD COLUMN guest_table_start boolean NOT NULL DEFAULT false;

CREATE TABLE rms_dining.dining_session_guest_start (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 table_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 service_setting_version integer NOT NULL,
 started_at timestamptz NOT NULL CHECK (isfinite(started_at) AND started_at=date_trunc('milliseconds',started_at)),
 PRIMARY KEY (brand_id,store_id,session_id),
 CONSTRAINT dining_session_guest_start_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_session_guest_start_session FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_session_guest_start_setting FOREIGN KEY (brand_id,store_id,service_setting_version)
  REFERENCES rms_dining.dining_service_setting(brand_id,store_id,version)
);
CREATE INDEX dining_session_guest_start_table ON rms_dining.dining_session_guest_start (brand_id,store_id,table_id,started_at);
CREATE INDEX dining_session_guest_start_store ON rms_dining.dining_session_guest_start (brand_id,store_id,started_at);

-- The start names the Session it opened, at that table and instant; the Session pays first, the
-- switch is on now, and the budgets hold. The Store lock counts concurrent starts at other tables.
CREATE FUNCTION rms_dining.validate_dining_session_guest_start() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 session_row rms_dining.dining_session%ROWTYPE;
 timing text;
 latest rms_dining.dining_service_setting%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningGuestTableStartBudget:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT * INTO session_row FROM rms_dining.dining_session s
  WHERE s.tenant_id=NEW.tenant_id AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id;
 IF NOT FOUND OR session_row.table_id<>NEW.table_id OR session_row.phase<>'Active' OR session_row.started_at<>NEW.started_at THEN
  RAISE EXCEPTION 'guest start only for the Session it opened' USING ERRCODE='23514';
 END IF;
 SELECT t.payment_timing INTO timing FROM rms_dining.dining_session_payment_timing t
  WHERE t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id AND t.session_id=NEW.session_id;
 IF timing IS DISTINCT FROM 'PayFirst' THEN
  RAISE EXCEPTION 'guest start only at a table that pays first' USING ERRCODE='23514';
 END IF;
 SELECT * INTO latest FROM rms_dining.dining_service_setting v
  WHERE v.brand_id=NEW.brand_id AND v.store_id=NEW.store_id ORDER BY v.version DESC LIMIT 1;
 IF NOT FOUND OR latest.guest_table_start IS NOT TRUE OR latest.version<>NEW.service_setting_version THEN
  RAISE EXCEPTION 'guest start switch is off' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM rms_dining.dining_session_guest_start g
      WHERE g.brand_id=NEW.brand_id AND g.store_id=NEW.store_id AND g.table_id=NEW.table_id
       AND g.started_at>NEW.started_at-interval '10 minutes')>=3 THEN
  RAISE EXCEPTION 'too many guest starts at this table' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM rms_dining.dining_session_guest_start g
      WHERE g.brand_id=NEW.brand_id AND g.store_id=NEW.store_id
       AND g.started_at>NEW.started_at-interval '10 minutes')>=40 THEN
  RAISE EXCEPTION 'too many guest starts at this store' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_session_guest_start_order BEFORE INSERT ON rms_dining.dining_session_guest_start
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_session_guest_start();

CREATE FUNCTION rms_dining.reject_dining_session_guest_start_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only guest start' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_session_guest_start_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_session_guest_start
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_session_guest_start_mutation();
CREATE TRIGGER dining_session_guest_start_no_truncate BEFORE TRUNCATE ON rms_dining.dining_session_guest_start
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_session_guest_start_mutation();

ALTER TABLE rms_dining.dining_session_guest_start ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_guest_start FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_guest_start_scope ON rms_dining.dining_session_guest_start
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_guest_start FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_session_guest_start() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_session_guest_start_mutation() FROM PUBLIC;

-- Both directions of "pay first only". The payment-timing lock comes first in both triggers, then
-- the service-setting lock, so neither order waits on the other.
CREATE OR REPLACE FUNCTION rms_dining.validate_dining_service_setting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer; timing text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreDiningPaymentTiming:'||NEW.brand_id||':'||NEW.store_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningServiceSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM rms_dining.dining_service_setting
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'service setting version out of order' USING ERRCODE='23514';
 END IF;
 IF NEW.guest_table_start THEN
  SELECT payment_timing INTO timing FROM rms_dining.store_dining_payment_timing
   WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id ORDER BY version DESC LIMIT 1;
  IF timing='PayLater' THEN
   RAISE EXCEPTION 'guests start tables only at a store that pays first' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rms_dining.validate_store_dining_payment_timing_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 latest rms_dining.store_dining_payment_timing%ROWTYPE;
 guest_start boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreDiningPaymentTiming:'||NEW.brand_id||':'||NEW.store_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningServiceSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT * INTO latest FROM rms_dining.store_dining_payment_timing
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id ORDER BY version DESC LIMIT 1;
 IF (NOT FOUND AND NEW.version<>1)
 OR (FOUND AND (NEW.version<>latest.version+1 OR NEW.changed_at<latest.changed_at OR NEW.tenant_id<>latest.tenant_id)) THEN
  RAISE EXCEPTION 'dining payment timing version out of order' USING ERRCODE='23514';
 END IF;
 IF NEW.payment_timing='PayLater' THEN
  SELECT guest_table_start INTO guest_start FROM rms_dining.dining_service_setting
   WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id ORDER BY version DESC LIMIT 1;
  IF guest_start IS TRUE THEN
   RAISE EXCEPTION 'guests start tables here: turn that off before paying later' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

-- The System releases the table of a guest-started Session it closed; staff release the others.
ALTER TABLE rms_dining.dining_table_release_operation DROP CONSTRAINT dining_table_release_operation_check;
ALTER TABLE rms_dining.dining_table_release_operation ADD CONSTRAINT dining_table_release_operation_check
 CHECK((jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=1048576
  AND record_json ?& ARRAY['command','intentDigest','session','beforeTable','afterTable','audit']
  AND record_json-ARRAY['command','intentDigest','session','beforeTable','afterTable','audit']='{}'::jsonb
  AND record_json->>'intentDigest'=intent_digest
  AND record_json#>>'{command,operationReference}'=operation_id::text
  AND record_json#>>'{command,diningSessionReference}'=session_id::text
  AND record_json#>>'{command,tableReference}'=table_id::text
  AND record_json#>>'{command,expectedSessionVersion}'=expected_session_version::text
  AND record_json#>>'{command,expectedTableVersion}'=expected_table_version::text
  AND (record_json#>>'{command,observedAt}')::timestamptz=occurred_at
  AND record_json#>>'{session,phase}'='Closed'
  AND record_json#>>'{session,diningSessionReference}'=session_id::text
  AND record_json#>>'{beforeTable,tenantReference}'=tenant_id::text
  AND record_json#>>'{beforeTable,brandReference}'=brand_id::text
  AND record_json#>>'{beforeTable,storeReference}'=store_id::text
  AND record_json#>>'{beforeTable,tableReference}'=table_id::text
  AND record_json#>>'{beforeTable,activeDiningSessionReference}'=session_id::text
  AND record_json#>>'{beforeTable,aggregateVersion}'=expected_table_version::text
  AND record_json->'afterTable'=(record_json->'beforeTable')||jsonb_build_object('activeDiningSessionReference',NULL,'aggregateVersion',expected_table_version+1,'observedAt',record_json#>>'{command,observedAt}')
  AND record_json#>>'{audit,actionCode}'='DINING_TABLE_RELEASED'
  AND record_json#>>'{audit,correlationId}'=operation_id::text
  AND record_json#>>'{audit,actor,type}' IN ('User','System')) IS TRUE);
