-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (same-table-ordering, sim M88): the table's QR budget counted every issue, so a party
-- scanning together, whose phones retry when two scan at the same instant, could be refused
-- 「这桌加入的人太多」 although fewer than 12 people joined. It now counts guests: in any 10 minutes
-- at most 16 different guest sessions (a 12-seat round table plus a few re-scans) may be issued a
-- code, a guest who already scanned in that window may always retry, and at most 96 issues in all
-- (16 x 6 attempts) stop hammering. The rest of the check is unchanged from 2000_105. No grants.
CREATE OR REPLACE FUNCTION rms_dining.validate_qr_join_issue() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 issues integer;
 guests integer;
 again boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningQrJoin:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.session_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_session s WHERE s.tenant_id=NEW.tenant_id
   AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id AND s.phase='Active') THEN
  RAISE EXCEPTION 'the table is not open for joining' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_join_capability c WHERE c.capability_id=NEW.capability_id
   AND c.tenant_id=NEW.tenant_id AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id
   AND c.session_id=NEW.session_id AND c.status='Active') THEN
  RAISE EXCEPTION 'QR join capability does not match' USING ERRCODE='23514';
 END IF;
 IF coalesce((SELECT c.state FROM rms_dining.dining_qr_join_control c WHERE c.tenant_id=NEW.tenant_id
   AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.session_id=NEW.session_id
   ORDER BY c.occurred_at DESC, c.operation_id DESC LIMIT 1),'Open') = 'Paused' THEN
  RAISE EXCEPTION 'QR joining is paused for the table' USING ERRCODE='23514';
 END IF;
 SELECT count(*), count(DISTINCT i.guest_session_id), coalesce(bool_or(i.guest_session_id=NEW.guest_session_id),false)
  INTO issues, guests, again
  FROM rms_dining.dining_qr_join_issue i WHERE i.tenant_id=NEW.tenant_id
   AND i.brand_id=NEW.brand_id AND i.store_id=NEW.store_id AND i.session_id=NEW.session_id
   AND i.occurred_at > NEW.occurred_at - interval '10 minutes';
 IF issues >= 96 OR (NOT again AND guests >= 16) THEN
  RAISE EXCEPTION 'too many joins for the table' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
