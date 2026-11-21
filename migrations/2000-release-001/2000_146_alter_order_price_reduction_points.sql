-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 取舍 18 DEC-MEMBER-POINTS: points redeemed on a table's bill are recorded as a reduction on
-- each dish like any other discount, so the sale stays recorded at its price and reports, tax
-- rounding and settlement read it as they read a comp. Only a guest's redemption uses this reason,
-- and only with its own permission code; a manager's comp keeps its own reasons.
ALTER TABLE rms_ordering.order_item_price_reduction
 DROP CONSTRAINT order_item_price_reduction_reason_code_check,
 DROP CONSTRAINT order_item_price_reduction_permission_code_check,
 ADD CONSTRAINT order_item_price_reduction_reason_code_check CHECK (
  reason_code IN ('QUALITY','WRONG_DISH','LONG_WAIT','GOODWILL','POINTS_REDEMPTION')
 ),
 ADD CONSTRAINT order_item_price_reduction_permission_code_check CHECK (
  (reason_code='POINTS_REDEMPTION' AND permission_code='loyalty.points.redeem')
  OR (reason_code<>'POINTS_REDEMPTION' AND permission_code='ordering.order.comp')
 );
