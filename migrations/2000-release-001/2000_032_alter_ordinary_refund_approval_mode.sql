-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): at a Brand whose Owner runs it alone (sole operator
-- in effect at the moment of approval), the Owner may request and approve the same escalated
-- ordinary refund; the record says so (approval_mode SoleOperator). Second-factor verification
-- within 15 minutes is still required. Every other approval stays independent. The same Owner may
-- also withdraw their own request (entered in error, or the customer withdrew). Existing rows are
-- Independent and keep their meaning.
ALTER TABLE rms_payment.ordinary_refund_approval
 ADD COLUMN approval_mode text NOT NULL DEFAULT 'Independent'
  CONSTRAINT ordinary_refund_approval_mode_check CHECK (approval_mode IN ('Independent','SoleOperator'));
ALTER TABLE rms_payment.ordinary_refund_approval
 DROP CONSTRAINT ordinary_refund_approval_independent;
ALTER TABLE rms_payment.ordinary_refund_approval
 ADD CONSTRAINT ordinary_refund_approval_independent CHECK (
  requester_id<>approver_id OR approval_mode='SoleOperator'
 );
ALTER TABLE rms_payment.ordinary_refund_approval
 ADD CONSTRAINT ordinary_refund_approval_sole_operator_same_person CHECK (
  approval_mode<>'SoleOperator' OR requester_id=approver_id
 );
ALTER TABLE rms_payment.ordinary_refund_approval
 ADD CONSTRAINT ordinary_refund_approval_mode_json_binding CHECK (
  (record_json->>'approvalMode') IS NOT DISTINCT FROM
   (CASE WHEN approval_mode='SoleOperator' THEN 'SoleOperator' END)
 );
CREATE INDEX ordinary_refund_approval_sole_operator_idx
 ON rms_payment.ordinary_refund_approval (brand_id,store_id,approved_at)
 WHERE approval_mode='SoleOperator';

ALTER TABLE rms_payment.ordinary_refund_decline
 ADD COLUMN decline_mode text NOT NULL DEFAULT 'Independent'
  CONSTRAINT ordinary_refund_decline_mode_check CHECK (decline_mode IN ('Independent','SoleOperator'));
ALTER TABLE rms_payment.ordinary_refund_decline
 DROP CONSTRAINT ordinary_refund_decline_independent;
ALTER TABLE rms_payment.ordinary_refund_decline
 ADD CONSTRAINT ordinary_refund_decline_independent CHECK (
  decliner_id<>requester_id
  OR (decline_mode='SoleOperator' AND reason_code IN ('ENTERED_IN_ERROR','CUSTOMER_WITHDREW'))
 );
ALTER TABLE rms_payment.ordinary_refund_decline
 ADD CONSTRAINT ordinary_refund_decline_sole_operator_same_person CHECK (
  decline_mode<>'SoleOperator' OR decliner_id=requester_id
 );
