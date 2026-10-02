# Cross-Region recovery evidence template

All fields start **Unrecorded**. Keep completed records restricted; use safe references, not credentials, customer data or unrestricted resource identities. Follow the [procedure](cross-region-disaster-recovery.md).

| Evidence field            | Required record                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Authority and ownership   | Drill/incident approval reference; operator, approvers, Operations/Security/Domain roles                            |
| Candidate and environment | Exact source/image/schema versions; approved primary/recovery target reference; actual support verification date    |
| Recovery point            | Backup/replica references; last confirmed position; lag; start/end timestamps; measured RPO/RTO                     |
| Safety fence              | Primary write-fence proof; destination read-only proof; promotion authority; split-brain prevention                 |
| Restore coverage          | Transactions/jobs/Outbox/Inbox/Idempotency/revocation/Audit coverage; projection rebuild                            |
| Traffic gate              | Schema/Audit/object/malware/authorization/tombstone results; both endpoint checks; DNS authority and communications |
| Reconciliation            | Original-key Payment/webhook/email reconciliation; unresolved Unknown operations and owner                          |
| Failure/return plan       | Kept fences; escalation; compatible rollback/fail-forward approval; no automatic unfencing                          |
| Closeout                  | Outcome; restricted artifacts; isolated-resource destruction; next quarterly/semiannual evidence due                |

Unrecorded fields block a completion claim. This template contains no passing drill result.
