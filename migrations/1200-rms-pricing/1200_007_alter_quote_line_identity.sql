-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Domain line references survive requotes. Uniqueness belongs to each Quote.
-- The existing scoped unique key and tax-line foreign key remain intact.
ALTER TABLE rms_pricing.price_quote_line
  DROP CONSTRAINT price_quote_line_pkey,
  ADD CONSTRAINT price_quote_line_pkey PRIMARY KEY (price_quote_id, price_quote_line_id);

ALTER TABLE rms_pricing.price_quote_tax_line
  DROP CONSTRAINT price_quote_tax_component_unique,
  ADD CONSTRAINT price_quote_tax_component_unique
    UNIQUE (price_quote_id, price_quote_line_id, calculation_order, tax_component_code);
