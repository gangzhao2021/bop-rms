-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-18, DEC-KITCHEN-REWORK cancel): a remake opened on the wrong dish or by accident
-- recorded the "first dish" as Store waste although nothing was thrown away. When the kitchen
-- cancels that remake as opened by mistake, the Inventory consumer of KitchenReworkCancelled voids
-- the remake's own waste record (Correction movements put the quantity back), recorded as a review
-- with reason KITCHEN_REMAKE_OPENED_BY_MISTAKE by the staff member who cancelled the remake, who is
-- often the one who opened it. Only that system-applied reason may be recorded by the recorder;
-- every other review still needs someone other than the recorder (DEC-INV-WASTE). Existing rows
-- satisfy the new constraint. No new table or grant.
ALTER TABLE rms_inventory.store_waste_review DROP CONSTRAINT store_waste_review_independent;
ALTER TABLE rms_inventory.store_waste_review
 ADD CONSTRAINT store_waste_review_independent CHECK (
  reviewed_by_actor_id <> recorded_by_actor_id
  OR (decision = 'Voided' AND reason_code = 'KITCHEN_REMAKE_OPENED_BY_MISTAKE')
 );
