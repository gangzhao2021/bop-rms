# Database Restore Drill Evidence Template

Store the completed record in the approved restricted evidence system。Do not commit a completed copy to Git。Use only safe references below；never enter credentials、account IDs、ARNs、endpoints、database names、DSNs、SQL、row data、PII、payment、health / allergy or Provider payloads。

## Control record

- Work Package: `WP-0025`
- Change / drill safe reference: `<required external evidence>`
- Operator role: `<role only>`
- Approver roles: `<roles only>`
- Security / Privacy reviewer roles: `<roles only>`
- Cleanup owner role: `<role only>`
- Approved UTC window: `<required external evidence>`
- Cost ceiling and timeout: `<required external evidence>`

## Read-only preflight

- Account / Region verification safe reference: `<required external evidence>`
- Source Staging classification review: `<pass/fail/blocked>`
- PostgreSQL engine / version observed: `<required external evidence>`
- Encryption / KMS review: `<pass/fail/blocked>`
- Backup retention observed: `<required external evidence>`
- Earliest restorable UTC instant: `<required external evidence>`
- Latest restorable UTC instant: `<required external evidence>`
- Selected restore UTC instant: `<required external evidence>`
- New-target / source inequality reviewed: `<pass/fail/blocked>`
- Private network / no-public-access review: `<pass/fail/blocked>`
- Temporary verification authority reviewed: `<pass/fail/blocked>`
- Cleanup authorization safe reference: `<required external evidence>`

## Restore timeline

- Restore requested at UTC: `<observed evidence>`
- RDS target available at UTC: `<observed evidence>`
- Private verification started at UTC: `<observed evidence>`
- Required verification completed at UTC: `<observed evidence>`
- Cleanup started at UTC: `<observed evidence>`
- Cleanup completed at UTC: `<observed evidence>`
- Request-to-available duration: `<observed evidence>`
- Available-to-verified duration: `<observed evidence>`
- Total request-to-verified duration: `<observed evidence>`

## Read-only verification

| Check                                                      | Result                | Safe diagnostic / evidence reference |
| ---------------------------------------------------------- | --------------------- | ------------------------------------ |
| Migration `verify`                                         | `<pass/fail/blocked>` | `<safe reference only>`              |
| Foundation verifier                                        | `<pass/fail/blocked>` | `<safe reference only>`              |
| Helper verifier                                            | `<pass/fail/blocked>` | `<safe reference only>`              |
| Target stayed isolated from application / Provider traffic | `<pass/fail/blocked>` | `<safe reference only>`              |
| No migration apply / repair / history mutation             | `<pass/fail/blocked>` | `<safe reference only>`              |
| No prohibited data or secret in captured evidence          | `<pass/fail/blocked>` | `<safe reference only>`              |

## Cleanup and result

- Exact target identity and ownership revalidated before cleanup: `<pass/fail/blocked>`
- Source / backup preserved: `<pass/fail/blocked>`
- Temporary verification access revoked: `<pass/fail/blocked>`
- Ignored local secret files removed: `<pass/fail/blocked>`
- Restored target reached terminal deletion: `<pass/fail/blocked>`
- Temporary WP-0025 resource inventory empty: `<pass/fail/blocked>`
- Drill result: `<pass/fail/blocked>`
- Failed gate or residual risk: `<bounded safe description>`
- Reviewer decision safe reference: `<required external evidence>`

## Claim boundary

- This record is bounded Staging evidence only: `<acknowledged>`
- Production RPO / RTO is not claimed by WP-0025 alone: `<acknowledged>`
- Cross-Region failover、application recovery and Provider reconciliation remain WP-2053: `<acknowledged>`
- Backup media is not represented as statutory archive or legal-hold evidence: `<acknowledged>`
