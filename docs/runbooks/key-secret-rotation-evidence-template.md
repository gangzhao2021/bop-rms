# Rotation evidence template

Status: **Unrecorded**. Complete only in an authorized restricted evidence store. Follow the [procedure](key-secret-rotation.md); record safe version references and never values.

| Evidence field     | Required record                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Scope and approval | Purpose/environment; operator/reviewers; applicable authorization; compromise versus scheduled path          |
| Dependencies       | Consumers, historical signatures/decryption, archive/hold dependencies and stop conditions                   |
| Transition         | Old/new version references; dual-read/single-write or sign/verify-only plan; actual timings                  |
| Bounds             | Applicable annual/90-day/180-day cadence; pepper ≤24-hour overlap or announced revocation                    |
| Verification       | New operations and historical verification/decryption; consumer convergence; alerts and restricted artifacts |
| Failure handling   | Advancement stopped; retained required read/verify ability; escalation and approved recovery decision        |
| Deletion           | Two-person approvals; ≥30-day window; dependency/hold clearance or explicit blocked status                   |
| Closeout           | Outcome; unresolved owners; next verification/review; daily/quarterly evidence references                    |

No value defaults to Passed, zero findings or approval. Missing evidence blocks its corresponding claim.
