# Recipe

`@rms/recipe` owns versioned Recipe configuration for WP-2105. It owns Ingredient Requirements,
Yield and loss, version-pinned Sub-recipes and unit conversions, Preparation Steps, theoretical
Inventory consumption, exact cost derivation, structured Allergen evidence union, SKU / Store
bindings and publication lifecycle.

The module does not own Catalog Product / SKU / Option definitions, Inventory quantities,
Procurement or Supplier facts, Kitchen execution, Pricing or Order lifecycle. Those Domains supply
only public references or version-pinned evidence through ports; Recipe never reads their private
tables.

## Public contract

- Commands: create / replace Draft, dual-reviewed Publish, Invalidate and Archive.
- Writes require Brand scope, Actor, purpose, `recipe.manage`, Expected Version, idempotency,
  append-only Audit and an atomic minimal Event. Publish additionally requires independent Cost and
  Food Safety reviewers with exact evidence.
- Queries use the rebuildable `recipe_admin_v1` projection. Public events are additive `v1`
  lifecycle facts and contain no Ingredient narrative, supplier document, PII or health fact.
- Quantity and conversion values use bounded integer microunits / rational factors. Cost uses exact
  integer minor units. UTC instants and IANA time zones remain explicit.

## Persistence and security

`rms_recipe` is the sole write-owned schema. Aggregate versions, requirements, Allergen evidence,
steps, bindings, reviews, operations and projection generations are append-only; all twelve tables
enforce Brand RLS and revoke PUBLIC access. Historical corrections use a new version or an explicit
Invalidation, never an edit to accepted history.

No secret, token, customer identity, medical narrative, unrestricted supplier document or private
cross-Domain object is accepted in logs, URLs, events, analytics or fixtures. Tests use synthetic
UUIDs and controlled codes only.

## Verification

```bash
pnpm --filter @rms/recipe test
pnpm recipe-management:acceptance
pnpm verify
```

Real Inventory mappings, Supplier evidence, professional reviews, cost facts and Store overrides
remain External Evidence and are not claimed by repository fixtures.
