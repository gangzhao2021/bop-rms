-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.cart_line
  ADD COLUMN catalog_selection_evidence_json jsonb,
  ADD CONSTRAINT cart_line_catalog_selection_evidence_check CHECK (
    catalog_selection_evidence_json IS NULL
    OR (
      jsonb_typeof(catalog_selection_evidence_json) = 'object'
      AND catalog_selection_evidence_json ?& ARRAY[
        'menuVersionReference',
        'productVersionReference',
        'catalogChannelCode',
        'catalogOrderTypeCode',
        'ruleEvidence',
        'validatedAt'
      ]
      AND jsonb_typeof(catalog_selection_evidence_json -> 'menuVersionReference') = 'string'
      AND jsonb_typeof(catalog_selection_evidence_json -> 'productVersionReference') = 'string'
      AND jsonb_typeof(catalog_selection_evidence_json -> 'catalogChannelCode') = 'string'
      AND jsonb_typeof(catalog_selection_evidence_json -> 'catalogOrderTypeCode') = 'string'
      AND jsonb_typeof(catalog_selection_evidence_json -> 'ruleEvidence') = 'array'
      AND jsonb_array_length(catalog_selection_evidence_json -> 'ruleEvidence') <= 100
      AND jsonb_typeof(catalog_selection_evidence_json -> 'validatedAt') = 'string'
    )
  );
