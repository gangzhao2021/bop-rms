# Complete V2 SubRecipe publication

[WP-2421](../work-packages/WP-2421.md) milestone77 extends
[direct Ingredient publication](./recipe-measurement-publication.md) with
[held complete V2 graph](./current-published-recipe-measurement-graph.md).
The API accepts SubRecipe candidates only when trusted owning graph and complete
measurement field authorities are configured. It constructs those owning sources
directly inside the original caller transaction. Unconfigured sources fail closed.

New distinctly named/profiled pinned graph factories read exact eligible Published
versions selected by Recipe/version pair, including when the current child root
holds a newer Draft. They never replace an explicit child pin with its current
version. They retain current root lifecycle/epoch, full physical publication/review
proof, complete attachments, field authority, period/cycle/cardinality limits,
Recipe barrier, exclusive lease and final rereads. The existing current-root
factories keep their original current Published selection and public profiles.
No new SQL asset, access pattern, migration or grant is introduced.

The API derives every reachable full V2 child and every unique direct Inventory
selector from the held graph. It nests owning current Inventory units within the
child holder, validates every direct conversion and exact base precision, calculates
loss, fixed child yield and batch ratios through every path, then qualifies the
scaled final demand without silent rounding. The shortest child/Inventory lease
continues to govern native independent review, expected version, CAS, complete V2
append, Audit and Outbox. Parent write refusal or late source/authority/query/lease
failure poisons the original transaction; its outer caller must roll back.

Exact original command recovery still validates current Recipe authority and
original intent. It reads immutable complete content and returns the original
native result without requalifying historical child/Item sources or appending
another review, Audit or Outbox. Changed full intent or revoked current native
permission refuses recovery.

Protocol tests cover source absence, field denial, shortest lease, incomplete graph,
exact historical pins under newer current Draft and original recovery. Actual isolated
SQL publishes a physical full V2 parent against the physical V2 child from milestone75,
qualifies current owning Item units, checks exact 2100000/1 final microunits with two
path steps, native two-review/CAS/Audit/Outbox/full content, and eighteen-table rollback
after late writes and fractional final precision refusal. A real owning Item Deactivate
inside the probe transaction precedes exact original parent recovery with zero child
or unit holder calls; the probe is intentionally rolled back.

Actual newer-child-Draft workflow evidence is unavailable: the existing native Recipe
service refuses Published to ReplaceDraft. The attempted SQL fixture transition was
rejected and recorded, then removed; no lower repository or direct table write bypass
was used. Exact historical-pin/newer-Draft behavior has synthetic owning-source protocol
evidence only. A new-version Draft command from Published is an independent repository
software design/implementation gap requiring owning lifecycle/action/persistence scope.
Identity, authorization, Cost/FoodSafety declarations and general reference validation
remain synthetic in local acceptance. Ordinary configured Product publishing HTTP/UI,
current independent review capture, Store management, UAT and formal release remain
open. This milestone supplies Recipe/Inventory source composition, not sale eligibility.
