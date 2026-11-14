-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- M108 (WP-2423): a guest whose visit on their phone has ended is told to ask the store to remove
-- the pickup contact they gave; staff now can. The removal is the same one-time change as the
-- customer's own and the retention removal (the checkout details guard is unchanged: contact
-- becomes null, receipt becomes "view here"); its evidence row names the policy and, for a staff
-- removal only, the staff member who did it. It never holds the removed value. Existing rows have
-- no staff member and keep their own rules.
ALTER TABLE rms_ordering.checkout_contact_redaction
 ADD COLUMN removed_by_actor_id platform_helpers.uuid_v7;
ALTER TABLE rms_ordering.checkout_contact_redaction
 DROP CONSTRAINT checkout_contact_redaction_policy;
ALTER TABLE rms_ordering.checkout_contact_redaction
 ADD CONSTRAINT checkout_contact_redaction_policy CHECK (
  (policy_code='CHECKOUT_CONTACT_RETENTION' AND retention_days BETWEEN 1 AND 3650
   AND removed_by_actor_id IS NULL)
  OR (policy_code='CUSTOMER_REQUEST' AND retention_days IS NULL AND removed_by_actor_id IS NULL)
  OR (policy_code='STAFF_ON_CUSTOMER_REQUEST' AND retention_days IS NULL
   AND removed_by_actor_id IS NOT NULL)
 );
