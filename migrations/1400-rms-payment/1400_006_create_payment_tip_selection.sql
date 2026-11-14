-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_tip_selection (
  selection_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_operation_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version bigint NOT NULL CHECK (cart_version BETWEEN 1 AND 9007199254740991),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  tip_minor bigint NOT NULL CHECK (tip_minor >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code = 'CAD'),
  selected_at timestamptz NOT NULL CHECK (selected_at = date_trunc('milliseconds',selected_at)),
  CONSTRAINT payment_tip_selection_pk PRIMARY KEY (brand_id,store_id,selection_id)
);
CREATE INDEX payment_tip_selection_operation_idx
  ON rms_payment.payment_tip_selection (brand_id,store_id,payment_operation_id);
CREATE RULE payment_tip_selection_no_update AS
  ON UPDATE TO rms_payment.payment_tip_selection DO INSTEAD NOTHING;
CREATE RULE payment_tip_selection_no_delete AS
  ON DELETE TO rms_payment.payment_tip_selection DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_tip_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_tip_selection FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_tip_selection_scope_policy ON rms_payment.payment_tip_selection
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_tip_selection FROM PUBLIC;
