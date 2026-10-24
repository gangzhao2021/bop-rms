-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.order_capacity_link DROP CONSTRAINT order_capacity_link_shape;
ALTER TABLE rms_ordering.order_capacity_link
ADD CONSTRAINT order_capacity_link_shape CHECK ((
  jsonb_typeof(link_json)='object' AND octet_length(link_json::text)<=16384
  AND link_json ?& ARRAY['commitmentReference','ownerContextReference','brandReference','storeReference','orderReference','orderBatchReference','submissionReference','cartReference','quoteReference','guestSessionReference','paymentOperationReference','owner','commitmentVersion','cartVersion','ownerIntentDigest','ownerSnapshotDigest','preparedAt','validUntil']
  AND link_json - ARRAY['commitmentReference','ownerContextReference','brandReference','storeReference','orderReference','orderBatchReference','submissionReference','cartReference','quoteReference','guestSessionReference','paymentOperationReference','owner','commitmentVersion','cartVersion','ownerIntentDigest','ownerSnapshotDigest','preparedAt','validUntil']='{}'::jsonb
  AND link_json->>'commitmentReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'ownerContextReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'brandReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'storeReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'orderReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'orderBatchReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'submissionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'cartReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'quoteReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'guestSessionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'paymentOperationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'brandReference'=brand_id::text
  AND link_json->>'storeReference'=store_id::text
  AND link_json->>'submissionReference'=submission_id::text
  AND link_json->>'orderReference'=order_id::text
  AND link_json->>'orderBatchReference'=order_batch_id::text
  AND link_json->>'commitmentReference'=commitment_id::text
  AND link_json->>'paymentOperationReference'=payment_operation_id::text
  AND link_json->>'owner' IN ('Dining','Fulfillment') AND link_json->'commitmentVersion'='1'::jsonb
  AND jsonb_typeof(link_json->'cartVersion')='number'
  AND (link_json->>'cartVersion')::numeric BETWEEN 1 AND 9007199254740991
  AND (link_json->>'cartVersion')::numeric=trunc((link_json->>'cartVersion')::numeric)
  AND link_json->>'ownerIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
  AND link_json->>'ownerSnapshotDigest' ~ '^sha256:[0-9a-f]{64}$'
  AND link_json->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND link_json->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (link_json->>'preparedAt')::timestamptz <= created_at
  AND created_at < (link_json->>'validUntil')::timestamptz
 ) IS TRUE);

CREATE FUNCTION rms_ordering.validate_order_capacity_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_ordering.order_header h
  WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id AND h.order_id=NEW.order_id
   AND ((NEW.link_json->>'owner'='Dining' AND h.order_type='DineIn'
     AND h.dining_session_id::text=NEW.link_json->>'ownerContextReference')
    OR (NEW.link_json->>'owner'='Fulfillment' AND h.order_type='Pickup' AND h.dining_session_id IS NULL))
 ) THEN
  RAISE EXCEPTION 'invalid order capacity owner' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_capacity_owner() FROM PUBLIC;
CREATE TRIGGER order_capacity_owner_validate BEFORE INSERT ON rms_ordering.order_capacity_link
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_capacity_owner();
