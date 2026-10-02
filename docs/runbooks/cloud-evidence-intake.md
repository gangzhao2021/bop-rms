# Cloud control evidence intake

Authority: accepted Handoff 87.7.1/87.8, [organization baseline](../security/aws-organization-baseline.json), [operations baseline](../security/cloud-operations-evidence-baseline.json), and the owning WP. Static policy tests do not inspect a real account.

Operations/Security identify exact environment, candidate, observation date, named review roles and protected artifact references before intake. Collect organization/account separation, supported root removal or management-root safeguards, hardware MFA, no root access keys, grouped recovery contacts, tested emergency access, Identity Center MFA/short-lived human sessions and no long-lived human API keys. Keep identities and contact/account data in restricted evidence, not Git.

Collect telemetry isolation and minimization, encrypted least-privilege SNS transport, verified subscriptions, actual delivery/acknowledgement/escalation/recovery for `on_call_primary`, `on_call_backup` and `security_on_call`, cost/quota controls and required tags. Cost alarms notify only; they cannot stop transaction service or delete production data. Bind scaling/resource evidence to approved workload, rollout overlap and the accepted maximum 70% database-connection allocation.

For every control record: accepted source/control, observed value, environment/revision, artifact/time, reviewer and Pass/Fail/Unavailable. A role string or configured subscription alone does not prove human delivery. The four-hour session value in the synthetic organization validator fixture is that fixture's input; the source requires short-lived sessions and applicable real policy must be explicitly evidenced.

Route missing, conflicting or unsupported observations to the owning Operations/Security role and hold the corresponding readiness claim. Use [break-glass evidence](break-glass-access-evidence-template.md) for applicable recovery actions and [release intake](release-evidence-intake.md) for image evidence. No external account, subscription or credential is changed by this record.
