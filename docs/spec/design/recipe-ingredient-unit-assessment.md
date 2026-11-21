# Recipe Ingredient unit assessment

[WP-2421](../work-packages/WP-2421.md) milestone71 adds Inventory-owned exact
unit comparison alongside [current owning facts](./current-recipe-ingredient-unit-source.md).
Accepted Handoff29.4 requires explicit compatible standard or Item-specific
conversion;72.7 owns Inventory base units, ledger precision and conversion
revisions. Recipe29.1 owns loss and29.3 owns child yield. Frozen Domain dependency
boundaries remain unchanged; neither Recipe nor API reads private Inventory
storage or implements Inventory rules.

`assessRecipeIngredientUnits` accepts a closed selector per Inventory Ingredient:
Recipe/version/requirement/Item/configuration-operation references, explicit
usage/target units and dimensions, conversion kind/reference, positive quantity
microunits and conversion numerator/denominator. Numbers are canonical integer
strings bounded by the existing Recipe limit of10^30. It requires exactly the
held source's selectors, current full unit digest and original exclusive5s lease.
A digest proves consistent content only. Invocation belongs inside the actual
owning holder; successful assessment is unusable until original transaction,
current permissions, source barrier and full final rereads complete. Client or
synthetic facts cannot establish provenance by satisfying this pure function.

Identity requires actual current base code/dimension and ratio1. Explicit G/KG
and ML/L standards use exact1000 or1/1000 within Mass/Volume; the fixed arithmetic
never supplies an unknown Item base unit. Recorded conversion must be the single
Active from-unit rule effective both at assessment and proposed activation, with
the exact reference and equivalent rational multiplier in the selected current
Item configuration. Retired/future/missing rules, current or future ambiguity,
wrong pins/factors/endpoints fail closed. Cross-dimension interpretation requires
the explicitly selected owning Item-specific recorded rule, not a generic unit
map. Reading a recorded rule is not a claim of legal/external approval; real
configuration and any required approval remain owning sources.

Inventory compares BigInt rational quantities without rounding. An amount that
cannot be represented in integral microunits and current ledger precision returns
`RoundingRequired`; overflow returns `QuantityOutOfRange`. Neither status returns
a base quantity. Successful results bind complete selectors, Item version,
ledger precision/rounding mode, unit/metadata digest/generation/observation and
current/activation time. All results leave loss, child yield, stock and selling
eligibility `NotEvaluated`.

This is an explicit conservative publication qualifier, not a change to existing
Recipe's two-stage HalfUp consumption calculator or Inventory movement rounding.
Loss-adjusted and recursive child demand need separate Recipe-owned exact
validation. History, parser, services, public source holders, permissions,
migrations and Module dependency manifests remain untouched. There is no V2
publication or full Product admission in this milestone.

Focused tests use synthetic full owning metadata/units and cover standards,
recorded/cross-dimension rational equality, future ambiguity, closed-input abuse,
lease/digest/pin refusal, precision and10^30 boundaries. Existing isolated Recipe
SQL additionally derives identity selectors from actual V2 draft recovery and
assesses actual current KG/Mass/precision4 facts inside the actual holder. Changed
standard/precision/pin test selectors are synthetic comparison inputs; they are
not persisted V2 content or configured conversion authority. A precision refusal
after an independently armed Recipe marker rolls back the exact18 related
tables. Configured-conversion positive remains protocol evidence because the
owning Inventory writer has no conversion-edit operation yet.

Next implement Recipe-owned loss and pinned child-yield comparison, then actual
V2 publication/review/current graph composition and ordinary Product release
flow. Store capability management, real IAM/Store/Provider facts, UAT and formal
release remain open; component evidence never establishes whole-project Done.
