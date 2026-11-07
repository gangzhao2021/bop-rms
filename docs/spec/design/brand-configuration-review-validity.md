# Brand configuration review validity

## Authority and scope

This WP-2421 implementation rule addresses the missing finite business review
bound under the Owner-authorized project completion and documentation remediation
scope. It preserves Handoff Sections 42.3–42.4, WP-2191 independent approval,
immutable configuration history and the existing Publishing evidence contract.
It does not establish a default review duration or change configuration periods.

## Ordinary submission

SubmitConfiguration requires the administrator to explicitly choose
`reviewValidUntil`, a canonical UTC instant. The ordinary UI must explain that
approval and publication must occur before this business review expires. No
five-second authorization lease or unrelated workflow duration supplies a default.

The stable original command retains this value before allocations and reference
qualification. SaveConfigurationDraft, ApproveConfiguration and
PublishConfiguration carry null for this field. Resolve retains the original
intent digest and scalar identity; it neither supplies a replacement expiry nor
reconstructs the original submission.

A fresh Submit requires the chosen expiry to be later than the current server
observation and, when configuration effectiveUntil is finite, no later than that
instant. Genuine reference qualification can shorten validation validity. A
published configuration with an indefinite effective period still needs an
explicit finite review expiry; its configuration period remains indefinite.

## Approval, publication and recovery

The real Publishing validation binds the actual configuration version, semantic
digest, scope and qualified references. Approve and Publish recheck actual current
references and the original immutable validation and approval evidence. They keep
the original validation identity and cannot extend its expiry on retry.

Original Committed or Abandoned arbitration precedes fresh preparation, expiry
checks, allocation and current configuration CAS. A successful original operation
remains recoverable after its business review expires; recovery does not grant a
new publication. A genuinely expired fresh approval or publication requires a new
review through the owning lifecycle rules, preserving earlier history.

Actual API, UI, Session/IAM, qualified reference producers and public Core
composition remain required workflow implementation. This rule and its tests are
not proof that the complete Brand workflow is delivered.
