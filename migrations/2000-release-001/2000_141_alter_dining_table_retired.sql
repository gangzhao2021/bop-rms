-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-11-01): staff add, rename and
-- retire their Store's tables in the product. A retired table is kept, never deleted: lifecycle
-- 'Retired', with no open session, its code not active (turned off or never issued) and no block.
-- Every seating, move, join and checkout path already requires 'Published', so a retired table
-- takes no new guests. Rows already stored (Draft or Published) satisfy the new check unchanged.
ALTER TABLE rms_dining.dining_table DROP CONSTRAINT dining_table_snapshot_state;
ALTER TABLE rms_dining.dining_table ADD CONSTRAINT dining_table_snapshot_state CHECK ((
    table_snapshot->>'lifecycle' IN ('Draft','Published','Retired')
    AND table_snapshot->>'qrStatus' IN ('Inactive','Active','Revoked')
    AND table_snapshot->>'operationalState' IN ('Available','TemporarilyBlocked')
    AND jsonb_typeof(table_snapshot->'capacity')='number'
    AND (table_snapshot->>'capacity')::numeric BETWEEN 1 AND 1000
    AND (table_snapshot->>'capacity')::numeric=trunc((table_snapshot->>'capacity')::numeric)
    AND jsonb_typeof(table_snapshot->'qrVersion')='number'
    AND (table_snapshot->>'qrVersion')::numeric BETWEEN 0 AND 9007199254740991
    AND (table_snapshot->>'qrVersion')::numeric=trunc((table_snapshot->>'qrVersion')::numeric)
    AND ((table_snapshot->>'qrStatus'='Inactive')=((table_snapshot->>'qrVersion')::numeric=0))
    AND jsonb_typeof(table_snapshot->'accessibilityAttributes')='array'
    AND jsonb_array_length(table_snapshot->'accessibilityAttributes')<=16
    AND ((table_snapshot->>'operationalState'='TemporarilyBlocked')=(table_snapshot->'blockReasonCode'<>'null'::jsonb))
    AND (table_snapshot->>'lifecycle'<>'Draft' OR
      (table_snapshot->>'qrStatus'='Inactive' AND table_snapshot->>'operationalState'='Available'
       AND table_snapshot->'activeDiningSessionReference'='null'::jsonb))
    AND (table_snapshot->>'lifecycle'<>'Retired' OR
      (table_snapshot->>'qrStatus'<>'Active' AND table_snapshot->>'operationalState'='Available'
       AND table_snapshot->'activeDiningSessionReference'='null'::jsonb))
  ) IS TRUE);
