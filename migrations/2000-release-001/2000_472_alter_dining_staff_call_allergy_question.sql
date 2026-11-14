-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M171, Owner decision 17, 2026-11-06): a seated guest may
-- call staff with "I have an allergy question". The reason is all that is recorded: the guest
-- tells staff in person, so no health fact is ever written here.
ALTER TABLE rms_dining.dining_staff_call DROP CONSTRAINT dining_staff_call_reason_check;
ALTER TABLE rms_dining.dining_staff_call ADD CONSTRAINT dining_staff_call_reason_check
 CHECK (reason IN ('Question','TableNeeds','OrderProblem','ReadyToPay','AllergyQuestion'));
