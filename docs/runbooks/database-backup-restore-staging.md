# Database Backup / Restore Staging Runbook

## Purpose and authority

This runbook is the WP-0025 operator contract for one bounded Amazon RDS for PostgreSQL Staging restore drill。It implements the recovery preparation required by Canonical Sections 50.29 and 87.8 without claiming the production failover、cross-Region application recovery or final RPO / RTO evidence owned by WP-2053。

Use this runbook only after the exact AWS account、Region、source backup / PITR window、new restore target、operator authority、cost ceiling and cleanup action are separately approved。Opening this file is not authorization to call AWS、connect to Staging or delete a resource。

Current AWS behavior must be rechecked immediately before a drill against the official Amazon RDS documentation：

- [Amazon RDS for PostgreSQL versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html)
- [Amazon RDS automated backups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)
- [Restore a DB instance to a specified time](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html)
- [Cross-Region automated backup support](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RDS_Fea_Regions_DB-eng.Feature.CrossRegionAutomatedBackups.html)

Public compatibility preflight on `2026-07-21` confirmed that Amazon RDS documents PostgreSQL `18.4` as available and documents automated-backup replication for currently available RDS for PostgreSQL versions。This does not prove that the exact engine、instance class、KMS、network or source / destination combination is enabled in the Owner's account；the drill still requires authenticated account-level evidence。

## Ownership boundary

WP-0025 covers Staging backup / PITR discovery、a restore into a new isolated Staging target、database control-plane verification、measured drill evidence and exact-target cleanup。WP-2053 owns production and cross-Region failover、write fencing、endpoint rotation、application / Provider reconciliation and the final transaction SLO claim。

This runbook does not create backup policy、RDS infrastructure、KMS keys、IAM roles、networking or deployment automation。It does not restore production data into Staging。

## Hard stops

Stop before mutation when any item is missing、ambiguous or conflicts with observed state：

- approved change / drill reference and named operator、approver、Security / Privacy reviewer and cleanup owner；
- exact AWS account and Region observed through a read-only identity check；
- source is the approved Staging RDS instance or its approved replicated automated backup，never inferred from a name fragment；
- source data classification proves that the restore will not introduce unmasked production data or unnecessary PII；
- PostgreSQL engine / version、backup status、earliest / latest restorable UTC time and chosen restore point are observed；
- unique new target identifier、private subnet group、security groups、parameter / option choices、KMS key、retention、tags and expiry are approved；
- target is not an existing instance and no command would modify、replace or delete the source；
- cost ceiling、maximum drill duration and timeout / escalation contacts are recorded；
- a private approved network path、`verify-full` TLS CA、dedicated read-only verification authority and separately stored credentials are available；
- cleanup of the exact new target and temporary access has separate approval。

Never bypass a stop with `--no-verify-ssl`、public accessibility、shared credentials、an unmasked production snapshot、a broad resource search / delete、migration `apply`、repair、baseline、force、mark-applied or checksum override。

## Phase 1 — Read-only preflight

1. Copy [the evidence template](database-restore-drill-evidence-template.md) to the approved evidence system outside Git。Do not put account IDs、resource ARNs、endpoint names or credentials in this repository。
2. Observe the authenticated account and active Region。Record only the approved safe evidence reference and reviewer result。
3. Read the source RDS configuration and automated-backup state。Record engine/version、encryption state、backup retention、earliest and latest restorable UTC timestamps、Multi-AZ posture and safe source reference。
4. Confirm the chosen UTC restore point is inside the observed restorable window。Do not translate through an unrecorded local timezone。
5. Compare the proposed target configuration with the approved Staging recovery profile：new identifier、private network、no public endpoint、approved KMS key、least privilege、finite retention / expiry and WP-0025 ownership tags。
6. Record the baseline timestamp immediately before the restore request。This is a drill measurement point，not proof of the production RPO。

If read-only observations disagree with the approved plan，stop and revise the plan through the owning change process。Do not make the source conform during a recovery drill。

## Phase 2 — Restore into a new isolated target

1. A separately authorized operator submits an Amazon RDS point-in-time restore or restores the approved backup into the exact new target。The target identifier must be unique and must not equal any existing database instance identifier。
2. Supply the approved private subnet group、security groups、KMS key、parameter choices、retention and WP-0025 ownership / expiry tags explicitly。Do not rely on defaults that were not reviewed。
3. Keep the target disconnected from application、worker、migration runtime、Customer、Provider and public network traffic。
4. Observe the operation until RDS reports a terminal result or the approved drill timeout is reached。Record safe status and UTC timestamps only；do not stream unrestricted service events into evidence。
5. On failure or timeout，keep the exact target fenced，record the safe failure class and obtain cleanup or investigation approval。Do not retry automatically and do not delete a partially created target through a wildcard or guessed identifier。

Amazon RDS point-in-time restore creates a new DB instance；this runbook never treats it as an in-place rewind。

## Phase 3 — Private connectivity and read-only verification

1. Confirm again that the target is private、isolated and carries the exact approved ownership / expiry tags。
2. Create the ignored `.local` environment、password and CA files using the accepted Section 94 controls。The password file is current-user-owned mode `0600`；no password、DSN、`DATABASE_URL` or `PGPASSWORD` is accepted。
3. Set `BOP_RMS_ENVIRONMENT=staging` and `BOP_RMS_POSTGRES_SSL_MODE=verify-full`。The hostname must match the verified certificate path。
4. Run only the existing read-only repository commands：

   ```bash
   pnpm db:migrate -- verify --env-file .local/<approved-staging-restore-env>
   pnpm foundation:verify -- --env-file .local/<approved-staging-restore-env>
   pnpm helpers:verify -- --env-file .local/<approved-staging-restore-env>
   ```

5. Record command names、exit results、bounded diagnostic codes and UTC timestamps。Do not capture environment files、stdout containing unrestricted identities、database rows、SQL or server logs in Git。
6. Verify separately that no application or Provider traffic reached the target and that no write-capable runtime received access。

Expected success is byte-exact migration history plus compliant foundation schema / ACL and helper objects。Any pending、drift、wrong owner、unsafe ACL、unexpected object or verifier configuration failure quarantines the target。Do not run migration `apply` or repair the restored state as part of this drill。

## Phase 4 — Measurement and decision

Record the following observed intervals using UTC instants and monotonic duration measurements where available：

- restore request to RDS target available；
- target available to private verification start；
- verification start to all required checks complete；
- total request-to-verified-recovery duration。

Record whether the selected restore point was available and the distance between that point and the source's observed latest restorable time。This is bounded Staging evidence。It does not by itself prove the production `RPO ≤ 5 minutes / RTO ≤ 60 minutes` target，cross-Region readiness or application recovery。

A drill passes only when the new target is restored、remains isolated、all database verifiers pass read-only、evidence is complete and authorized cleanup finishes without residue。Otherwise record the exact failed gate and leave the WP external-evidence status blocked。

## Phase 5 — Exact-target cleanup

1. Obtain the recorded cleanup approval for the exact restored target。Re-resolve the authenticated account、Region、target identifier、ownership tags and source / target inequality immediately before deletion。
2. Revoke temporary verification access and remove local password / CA / environment files from the ignored `.local` boundary。
3. Delete only the exact restored target according to the approved evidence-retention decision。Never delete the source、its backup、an unowned snapshot or a target discovered only by prefix / wildcard。
4. Observe terminal deletion and verify that temporary network access and WP-0025-owned temporary resources are absent。
5. Record cleanup timestamps、safe result and reviewer confirmation。If cleanup fails，open an incident and retain exact ownership evidence；do not broaden deletion scope。

## Evidence handling

The completed evidence record lives in the approved restricted evidence system，not Git。Repository documentation may state only that an external record was observed and reviewed，using an approved safe reference。Never record credentials、account IDs、ARNs、endpoints、database names、customer / employee data、payment data、health / allergy facts、row counts that reveal business volume or unrestricted AWS error payloads。

Backup media is recovery media，not the legal-record archive。Retention、legal hold、privacy deletion replay and statutory archive remain owned by their later Work Packages and professional evidence gates。
