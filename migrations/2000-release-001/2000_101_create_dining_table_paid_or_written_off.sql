-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINE-IN-PAY-LATER (coordinator 2026-10-27, v15 DEMO-02): a table's Order is either
-- paid at the table once or written off by a manager when the guests left without paying, never
-- both — whichever is recorded first, the other is refused (both directions, under one Order
-- lock so two staff can't record both at once). No new grants.
CREATE FUNCTION rms_payment.check_dining_table_paid_or_written_off() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 IF TG_TABLE_NAME = 'dining_table_settlement' THEN
  IF EXISTS (SELECT 1 FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=NEW.brand_id
    AND w.store_id=NEW.store_id AND w.order_id=NEW.order_id) THEN
   RAISE EXCEPTION 'the table''s bill was written off' USING ERRCODE='23514';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
   AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'the table already paid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_paid_or_written_off() FROM PUBLIC;
CREATE TRIGGER dining_table_settlement_not_written_off BEFORE INSERT ON rms_payment.dining_table_settlement
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_paid_or_written_off();
CREATE TRIGGER order_unpaid_write_off_not_paid BEFORE INSERT ON rms_payment.order_unpaid_write_off
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_paid_or_written_off();
