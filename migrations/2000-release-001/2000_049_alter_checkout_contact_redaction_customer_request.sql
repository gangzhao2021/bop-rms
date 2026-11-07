-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): a customer may ask, from their own order page while
-- their visit is active, that the pickup contact they gave be removed now instead of after the
-- retention period. The removal is the same one-time change as the retention removal (the checkout
-- details guard is unchanged: contact becomes null, receipt becomes "view here"); its evidence row
-- says which policy removed it. A customer request carries no retention days and may happen any
-- time after the details were recorded; the retention removal keeps its existing rule.
ALTER TABLE rms_ordering.checkout_contact_redaction ALTER COLUMN retention_days DROP NOT NULL;
ALTER TABLE rms_ordering.checkout_contact_redaction
 DROP CONSTRAINT checkout_contact_redaction_policy_code_check,
 DROP CONSTRAINT checkout_contact_redaction_retention_days_check,
 DROP CONSTRAINT checkout_contact_redaction_after_retention;
ALTER TABLE rms_ordering.checkout_contact_redaction
 ADD CONSTRAINT checkout_contact_redaction_policy CHECK (
  (policy_code='CHECKOUT_CONTACT_RETENTION' AND retention_days BETWEEN 1 AND 3650)
  OR (policy_code='CUSTOMER_REQUEST' AND retention_days IS NULL)
 ),
 ADD CONSTRAINT checkout_contact_redaction_after_retention CHECK (
  CASE WHEN policy_code='CHECKOUT_CONTACT_RETENTION'
   THEN redacted_at >= details_recorded_at + make_interval(days => retention_days)
   ELSE redacted_at >= details_recorded_at
  END
 );
