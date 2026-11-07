# Platform template setup workspace

## Scope and authority

This WP-2421 implementation interpretation completes the template prerequisite
for first Brand setup under Handoff 42.3–42.4, 87.6 and 88.18/88.21. The Owner
delegated software design and documentation clarification in
[project delivery inputs](project-delivery-decision-inputs.md). Actual setup,
approval and publication still require their recorded evidence.

Use a contextual “Brand setup templates” panel at the existing authentication
return route `/platform/tenants`. Do not introduce a standalone template route.
The parent Screen remains `PLT-TENANT-LIST`; fleet Tenant listing, support access
and `PLT-TENANT-DETAIL` retain their Phase 3, capability, purpose and case rules.
The prerequisite template panel operates before a Brand exists and therefore
cannot borrow a Brand or Store scope, or manufacture a FeatureControl decision.
Its explicit server configuration only makes the template service available;
each request separately requires the actual Platform Session, recent MFA and
the named template Permission. This interpretation does not activate fleet
operations or authorize production provisioning.

## Ordinary flow

1. Sign in through the configured Platform Provider. Display current session
   status, reauthentication and logout actions without exposing credentials.
2. Discover actual authored templates by name and code through bounded current
   owner pages. Select a returned template; users do not enter internal IDs.
3. Create or edit the name, code, default and supported locales, permitted
   override fields, hard requirements and effective period. Preserve the owning
   content contract and show each field error beside its control. Save creates
   immutable authored content; it does not publish it.
4. Create or update a publication Draft against the actual saved version and
   observed lifecycle. Submit requires an explicit finite review expiry.
5. A different authorized Actor opens the saved template, selects the real
   submitted version and approves it. Publishing retains the actual author,
   submitter, approver and original expiry; client visibility grants no action.
6. Publish the approved version, refresh the actual current release, and retain
   authored and publication history. New authored content or a new Draft does
   not hide an older review or remove the existing published release.
7. Archive only through the owner command. Show its recorded outcome and retain
   history. Template assignment and Theme selection are subsequent first-Brand
   steps and remain unfinished until implemented and verified.

The template list explicitly describes authored content. Approval state and
current publication come from the actual Publishing source, including an
explicitly selected historical lifecycle. They must not be inferred from list
labels, a saved version, or the highest revision alone.

## Recovery and state handling

Retain the exact mutation intent and operation reference before sending. On a
lost response, resolve the same original operation with its original digest;
do not silently allocate a new operation or apply stale edits to a refreshed
head. Committed and Abandoned results are terminal for that operation. A
conflict requires a fresh current read and a deliberate new intent.

Provide Loading, Empty, Permission Denied, MFA Required, Not Found, Unavailable,
Conflict, Command Failed and Offline states. Unconfigured setup is unavailable;
it supplies no fabricated template, permission or lifecycle. Uncertain writes
retain a recovery action. Offline disables writes. Expired review requires a
new owning review flow without changing the recorded expiry.

Step-up uses the existing CSRF-protected POST. Its closed response carries the
validated authorization destination and sets the one-use HttpOnly cookie; the
browser performs top-level navigation. Login and callback preserve their fixed
return destination. No return URL, Actor, scope, evidence or server time is
accepted from the form.

## Interface and verification

Reuse existing Merchant components and styles as the authorized local design
baseline; this is not a Figma parity claim. Keep visible labels and focus,
associated errors, non-color state text, keyboard operation, bounded history,
readable 320px reflow and 200% zoom. Avoid displaying opaque identifiers as
editable business fields. Do not log forms, cookies, CSRF, Provider payloads or
authorization URLs.

Acceptance requires normal browser discovery, save, independent review,
publication and post-write refresh, plus recovery, permission loss, expired
review, concurrent head change and responsive/accessibility evidence. Actual
owner tests and isolated PostgreSQL integration are supporting evidence; they
do not establish this ordinary UI or installed startup by themselves.
