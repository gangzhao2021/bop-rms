# Break-glass Access Runbook

## Purpose, authority and claim boundary

This runbook is the WP-2046 operator contract for exceptional workforce, database or cloud access.
It implements Handoff Sections 50.30, 86.4, 87.6, 87.7.1, 87.10.4 and 87.11.1. Normal named,
least-privilege access remains the default; urgency never converts this document into standing
authorization.

Opening this file does not authorize access, create a role, reset MFA, reveal PII, bypass retention,
run a command or change production. The exact incident/change authority, two distinct trained active
Actors, deployed identities and restricted evidence system are External Evidence gates.

## Mandatory hard stops

Stop before any privileged action when one item is absent or ambiguous:

- a safe case/change reference, declared purpose, affected environment and exact resource/action
  scope;
- a named requester/operator and a distinct active Owner, Finance or otherwise authorized
  privileged approver; no Actor may request, approve and execute the same elevation;
- verified identity, TOTP MFA and recent MFA for every interactive privileged Actor;
- a finite UTC start/expiry window, expected commands/actions, evidence owner and revocation owner;
- proof that normal least-privilege access cannot safely perform the bounded response;
- privacy/security classification and confirmation that evidence will not contain secrets, tokens,
  PAN/CVV, raw payment data, unrestricted PII or health/allergy detail;
- a purpose-built least-privilege role/task with no account-root, shared identity, reusable access
  key, public debug endpoint or unrestricted cross-Tenant access;
- an independent post-action reviewer and an executable revocation/verification path.

Never use email-only recovery, SMS MFA, a shared account, an unreviewed console role, a wildcard
resource/action, disabled logging, a permanent policy attachment or application/runtime credentials.
Never weaken RLS, append-only history, signature verification, encryption, Object Lock or legal hold
to make an emergency action easier.

## Roles and separation of duties

| Role           | Responsibility                                                                        | Prohibited combination          |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| Requester      | States incident, purpose, exact scope and finite window                               | Cannot self-approve             |
| Approver 1     | Confirms necessity, scope, identity and expiry                                        | Must differ from operator       |
| Approver 2     | Required for production break-glass, privileged recovery and archive-retention bypass | Must be a distinct active Actor |
| Operator       | Uses only the issued one-shot role/task and approved actions                          | Cannot expand own grant         |
| Evidence owner | Preserves safe append-only access/action/revocation references                        | Cannot edit provider logs       |
| Reviewer       | Reconciles actions, revocation and follow-up                                          | Must not be the sole operator   |

The Pilot requirement for two distinct trained active Actors applies even when one shareholder holds
multiple ordinary Roles. A role label is not evidence that two people participated.

## Phase 1 — Request and read-only preflight

1. Create a restricted case outside Git using the evidence template. Record safe references only.
2. Verify the named Actors, active Membership/assignment, TOTP/recent-MFA state and approver
   separation through the authoritative Identity/Permission path.
3. Resolve the exact account/environment, Tenant/Brand/Store when applicable, target resources,
   proposed actions, UTC start/expiry, reason and rollback/revocation owner.
4. Compare requested actions with normal access. Reject convenience, broad investigation and
   requests that can be completed through an existing safe operational control.
5. Confirm central Audit/provider logging, alert routing and evidence retention are active before
   issuance. A logging or time-source failure is a stop, not permission to proceed invisibly.

## Phase 2 — Two-person approval and issuance

1. Both required approvers review the same immutable request scope and record separate decisions.
2. Issue only a one-shot, purpose-built identity or task constrained to the approved actions,
   resources, environment and expiry. Do not copy a credential into the case, terminal transcript,
   chat or ticket.
3. Record only the safe grant/reference, actor roles, UTC issuance/expiry and policy version.
4. Alert Security/on-call that the break-glass window opened. Failure to route the alert stops use
   of the grant.

For identity recovery, revoke affected Sessions first and use the accepted admin-only,
identity-proofed workflow. Cognito may issue a one-time temporary credential only after approval;
the workflow never reveals or stores a TOTP seed. For cloud diagnosis, production ECS Exec, SSH and
public debug remain disabled; use a reviewed one-shot diagnostic task. Database access never uses an
Owner/shared role and remains Tenant/purpose scoped.

## Phase 3 — Bounded execution and monitoring

1. The named operator re-verifies target and scope immediately before each action.
2. Execute only approved actions. Any different target, command, data class, error response or need
   for more privilege stops the session and requires a new request.
3. Keep central provider/Audit collection enabled. Capture safe action/result codes and UTC times;
   do not paste command output, row data, payloads, environment values or secret material.
4. A second Actor monitors production archive-retention bypass and other high-risk actions in real
   time. Ordinary administrators never receive `s3:BypassGovernanceRetention`.
5. Stop at completion or expiry, whichever occurs first. Expiry is not extendable in place.

## Phase 4 — Immediate revocation and verification

1. Disable/delete the exact temporary grant, task or recovery path and revoke affected Sessions.
2. Re-resolve permissions and prove the operator no longer has the exceptional capability. Check
   that no temporary credential, policy attachment, session, task, network path or debug endpoint
   remains.
3. Reconcile requested versus observed actions using central Audit/provider evidence. Record gaps,
   unexpected access or missing logs as a Security incident; never edit history to make it match.
4. Verify business and security invariants affected by the action, including Tenant/Store scope,
   append-only records, retention/legal hold and service readiness.

## Phase 5 — Review and closure

An independent reviewer closes the case only when approval separation, exact actions, expiry,
revocation, access review and required corrective records are complete. Unexpected action, failed
revocation, missing evidence or sensitive-data exposure starts/updates the incident process and
keeps the case open.

Quarterly privileged-access review covers break-glass, KMS, database export and Support access.
Production launch additionally requires a tested contact tree and observed two-person exercise.
Repository validation proves only that this runbook/evidence contract is complete; it does not prove
that a real Actor, account, role, alert, drill or revocation exists.

## Evidence handling

Store the completed record in the approved restricted evidence system, never Git. Repository status
may contain only an approved safe reference and reviewer result. Do not record identity/contact
details, account IDs, ARNs, resource names, command text/output, URLs, IPs, credentials, tokens,
Customer/Employee data, payment data, health/allergy data or unrestricted provider errors.
