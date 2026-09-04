# Guest Session lifecycle rollout inspection

This is a read-only evidence procedure, not production authorization.

1. Obtain an Owner-approved complete Brand/Store inventory and proof that every old Session writer
   for the exact scope has stopped. Neither item exists in this repository.
2. Use a least-privilege read role and the approved application composition to run the public
   Identity inspector separately for each exact Brand/Store at a trusted UTC instant. Do not query
   the table directly, copy rows, log identifiers, or aggregate scopes.
3. `LiveLegacyRowsPresent` is a hard stop. Keep lifecycle activation off for that scope.
   `InactiveLegacyRowsOnly` is not clearance to backfill or delete; retention disposition needs its
   own authority and evidence. `NoLegacyRows` is only one input to a later rollout decision.
4. A dependency failure, missing scope, partial inventory, old writer, unknown result, or changed
   observation instant is a hard stop. Never infer a pass from absent logs or stale evidence.

The repository has no real Store inventory, runtime role, deployment target, production HMAC/key,
old-writer shutdown evidence, retention authorization or executed inspection result. No production
status is claimed until each is supplied and reviewed through a separate WP.
