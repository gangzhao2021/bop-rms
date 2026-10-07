# Brand Store topology preparation

WP-2421 implements the missing Tenant-owned preparation identified by the
accepted Product scope disposition and UniqueScope designs. Existing Brand
configuration and Brand-to-Store membership records retain their closed meanings.
This scoped software design supplies no operational, professional or external
approval fact.

## Draft intent and original recovery

A Brand-scoped Draft names Region and StoreGroup selector identities and explicit
Store assignments. Fresh saves validate every assigned Store against the actual
complete owning Tenant Store roster. An empty proposed Draft is not evidence of
known-empty effective membership. Draft saves do not change live scope resolution.
Region cardinality and independent approval remain pending Owner choices; no
active publication or governance default is defined by this preparation.

Tenant stores append-only Draft revisions and terminal original-operation records
in its own schema. The existing Brand root serializes writes. The original request
binds Tenant, Brand, Actor, operation identity, expected revision and the complete
canonical intent. Each committed revision binds its original author, audit,
operation, timestamps and full snapshot digest. Revision continuity preserves the
Draft identity and creation time. Current readers may differ from historical
authors; original recovery still binds the original request Actor.

A lost response is resolved using the exact original intent. Resolution can retain
an existing committed result or atomically record Abandoned when no original
exists. A late save cannot resurrect that terminal operation. Different intent,
Actor or expected revision is a conflict, not a new attempt. Historical records
are not rewritten to today's Store roster or Draft.

## Source and transaction authority

The preparation uses `organization.manage` with the explicit server purpose
`BRAND_STORE_TOPOLOGY_DRAFT`. The API must supply actual current scoped authority,
a complete owning Tenant Store reader and the actual public Audit writer on the
same borrowed READ COMMITTED transaction. Callback types alone do not constitute
real IAM or Audit integration evidence.

Original five-second authorization, captured source ports, root serialization,
exact stored tuple re-reads and final guards remain through COMMIT. Source history
and configured Draft presence never authorize current membership or Store sales.
No credential, current topology default, legal fact or fee policy is inferred.

## Remaining workflow

Owning schema/write/replay/rollback acceptance is recorded in
[WP-2421](../work-packages/WP-2421.md). Normal Brand navigation, post-save
refresh, history and original recovery now have local API, rendered browser and
actual encrypted Session/IAM/Feature/PostgreSQL acceptance. Navigation derives
its Brand from the server's selected context and holds independent Brand
`organization.manage`, Store `merchant.access` and current Feature admission
through transaction finalization. Disabled hides the entry; missing configuration
is unavailable. Synthetic Store publication fixtures do not supply external
StoreReady evidence. After
the Owner's governance choice, implement independent submission/approval when
required, effective topology publication, complete held current membership and
its consumer integration. The Tax coverage workflow also requires actual
Published scope policy, fee contexts, exception evidence and qualified material.
This Draft preparation is an internal dependency, not completed topology,
completed Tax coverage or whole-project completion.
