import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import {
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  samePublishingScope,
  createPublishingReleaseRecord,
  parsePublishingDigest,
  type PublishingLifecycleRecord,
  type PublishingValidationEvidence,
  type PublishingApprovalEvidence,
} from "@bop/publishing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
} from "../../contracts/product.js";
import type {
  MenuPublicationCommand,
  MenuPublicationRecord,
} from "../../contracts/menu-publication.js";
import type {
  MenuPublicationOperationRecord,
  MenuPublicationPorts,
} from "../../application/ports/menu-publication-ports.js";
import {
  transitionMenuPublication,
  validateMenuEffectivePeriod,
} from "../../domain/menu-publication.js";
import { createMenuPublishedEnvelope } from "../../application/menu-published-event.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const ds = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) if (!ds[key]?.enumerable || !("value" in ds[key])) return fail();
  return value as Record<string, unknown>;
}
function normalize(value: unknown): MenuPublicationOperationRecord {
  const r = closed(value, ["command", "intentHash", "result"]);
  const c = closed(r.command, [
    "action",
    "operationReference",
    "menuReference",
    "menuVersionReference",
    "expectedVersion",
    "snapshotDigest",
    "requestedAt",
    "effectivePeriod",
  ]);
  if (
    !["SubmitReview", "Approve", "Publish", "Archive"].includes(String(c.action)) ||
    !Number.isSafeInteger(c.expectedVersion) ||
    (c.expectedVersion as number) < 1
  )
    return fail();
  const command: MenuPublicationCommand = {
    action: c.action as MenuPublicationCommand["action"],
    operationReference: parseCatalogReference(c.operationReference),
    menuReference: parseCatalogReference(c.menuReference),
    menuVersionReference: parseCatalogReference(c.menuVersionReference),
    expectedVersion: c.expectedVersion as number,
    snapshotDigest: parsePublishingDigest(c.snapshotDigest),
    requestedAt: parseCatalogInstant(c.requestedAt),
    effectivePeriod:
      c.effectivePeriod === null ? null : validateMenuEffectivePeriod(c.effectivePeriod as never),
  };
  const result = closed(r.result, ["lifecycle", "effectivePeriod", "release"]);
  const lifecycle = createPublishingLifecycleRecord(result.lifecycle as never);
  const release =
    result.release === null ? null : createPublishingReleaseRecord(result.release as never);
  const effectivePeriod =
    result.effectivePeriod === null
      ? null
      : validateMenuEffectivePeriod(result.effectivePeriod as never);
  const intentHash = parseCatalogHash(r.intentHash);
  const digest = sha256Hex(
    JSON.stringify([
      command.action,
      command.menuReference,
      command.menuVersionReference,
      command.expectedVersion,
      command.snapshotDigest,
      command.requestedAt,
      command.effectivePeriod,
    ]),
  );
  if (
    intentHash !== digest ||
    String(lifecycle.familyReference) !== command.menuReference ||
    String(lifecycle.snapshotReference) !== command.menuVersionReference ||
    lifecycle.snapshotDigest !== command.snapshotDigest ||
    String(lifecycle.changedAt) !== command.requestedAt ||
    lifecycle.version !== command.expectedVersion + 1 ||
    lifecycle.configurationType !== "MENU" ||
    lifecycle.purposeCode !== "CUSTOMER_ORDERING" ||
    lifecycle.scope.kind !== "Brand" ||
    lifecycle.scope.storeReference !== null
  )
    return fail();
  return { command, intentHash, result: { lifecycle, release, effectivePeriod } };
}
const eventValue = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as unknown;

/** Catalog owner capability. Current publication evidence is mandatory and must
 * come from its owner, never from client fields or this repository's snapshots. */
export function createPostgresMenuPublicationRepository(options: {
  brandReference: string;
  menuReference: string;
  transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  authorize(tx: Transaction, operation: MenuPublicationOperationRecord | null): Promise<boolean>;
  evidence(
    tx: Transaction,
    command: MenuPublicationCommand,
  ): Promise<{
    draft: PublishingLifecycleRecord | null;
    validation: PublishingValidationEvidence | null;
    approval: PublishingApprovalEvidence | null;
  }>;
  timingReference(operationReference: string): string;
}): MenuPublicationPorts["repository"] {
  const brand: string = parseCatalogReference(options.brandReference),
    menu: string = parseCatalogReference(options.menuReference);
  const allowed = async (
    tx: Transaction,
    operation: MenuPublicationOperationRecord | null = null,
  ) => {
    if (!(await options.authorize(tx, operation))) return fail("CATALOG_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  };
  const fence = async (tx: Transaction) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "CatalogMenuPublication:" + brand + ":" + menu,
    ]);
  };
  const scoped = <T>(work: (tx: Transaction) => Promise<T>) =>
    options.transactions.run(async (tx) => {
      await allowed(tx);
      const result = await work(tx);
      await allowed(tx);
      return result;
    });
  const readOperation = async (
    tx: Transaction,
    reference: string,
  ): Promise<MenuPublicationOperationRecord | null> => {
    const { rows } = await tx.query(
      "SELECT o.*,s.operation_json,(date_trunc('milliseconds',o.occurred_at)=o.occurred_at) precise FROM rms_catalog.menu_publication_operation_record o LEFT JOIN rms_catalog.menu_publication_operation_snapshot s ON s.operation_id=o.operation_id WHERE o.brand_id=$1 AND o.operation_id=$2",
      [brand, reference],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.precise !== true ||
      row.menu_id !== menu ||
      !row.operation_json ||
      !(row.occurred_at instanceof Date)
    )
      return fail();
    const record = normalize(row.operation_json),
      c = record.command,
      l = record.result.lifecycle;
    if (
      c.operationReference !== reference ||
      c.menuReference !== menu ||
      c.menuVersionReference !== row.menu_version_id ||
      c.action !== row.action_code ||
      "sha256:" + record.intentHash !== row.intent_digest ||
      l.version !== row.result_lifecycle_version ||
      c.requestedAt !== row.occurred_at.toISOString() ||
      l.scope.brandReference !== brand
    )
      return fail();
    return record;
  };
  const load = async (tx: Transaction, version: string): Promise<MenuPublicationRecord | null> => {
    const { rows } = await tx.query(
      "SELECT r.lifecycle_id,r.lifecycle_version,r.state,r.snapshot_digest,s.operation_id FROM rms_catalog.menu_publication_revision r LEFT JOIN rms_catalog.menu_publication_operation_snapshot s ON s.lifecycle_id=r.lifecycle_id AND s.lifecycle_version=r.lifecycle_version WHERE r.brand_id=$1 AND r.menu_id=$2 AND r.menu_version_id=$3 ORDER BY r.lifecycle_version DESC LIMIT 1",
      [brand, menu, version],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row || typeof row.operation_id !== "string") return fail();
    const record = await readOperation(tx, row.operation_id),
      l = record?.result.lifecycle;
    if (
      !record ||
      !l ||
      l.lifecycleId !== row.lifecycle_id ||
      l.version !== row.lifecycle_version ||
      l.state !== row.state ||
      l.snapshotDigest !== row.snapshot_digest
    )
      return fail();
    return record.result;
  };
  const release = async (tx: Transaction) => {
    const { rows } = await tx.query(
      "SELECT r.release_id,r.release_sequence,s.operation_id FROM rms_catalog.menu_publication_release r LEFT JOIN rms_catalog.menu_publication_operation_snapshot s ON s.lifecycle_id=r.lifecycle_id AND s.lifecycle_version=r.lifecycle_version WHERE r.brand_id=$1 AND r.menu_id=$2 ORDER BY r.release_sequence DESC LIMIT 1",
      [brand, menu],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row || typeof row.operation_id !== "string") return fail();
    const result = (await readOperation(tx, row.operation_id))?.result.release;
    if (!result || result.releaseId !== row.release_id || result.sequence !== row.release_sequence)
      return fail();
    return result;
  };
  // DEC-MENU-REVISION: a period runs until its own end or the end recorded when it was superseded.
  const periods = `SELECT p.release_id,p.effective_from,
    CASE WHEN e.ended_at IS NULL THEN p.effective_until
      WHEN p.effective_until IS NULL THEN e.ended_at ELSE LEAST(p.effective_until,e.ended_at) END effective_until
    FROM rms_catalog.menu_release_effective_period p
    LEFT JOIN rms_catalog.menu_release_effective_end e ON e.release_id=p.release_id
    WHERE p.brand_id=$1 AND p.menu_id=$2`;
  /** The release in effect when a new release would start, which the new release supersedes. */
  const supersedable = async (tx: Transaction, from: string) => {
    const { rows } = await tx.query<{ release_id: string }>(
      `SELECT release_id FROM (${periods}) q WHERE q.effective_from<$3::timestamptz
        AND (q.effective_until IS NULL OR q.effective_until>$3::timestamptz)`,
      [brand, menu, from],
    );
    if (rows.length > 1) return fail();
    return rows[0]?.release_id ?? null;
  };
  const overlap = async (tx: Transaction, record: MenuPublicationRecord) => {
    if (
      !record.effectivePeriod ||
      record.lifecycle.scope.brandReference !== brand ||
      String(record.lifecycle.familyReference) !== menu
    )
      return fail();
    const p = validateMenuEffectivePeriod(record.effectivePeriod);
    const replaced = await supersedable(tx, p.effectiveFrom.instant);
    const { rows } = await tx.query<{ overlap: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM (${periods}) q WHERE ($5::uuid IS NULL OR q.release_id<>$5::uuid)
        AND tstzrange(q.effective_from,q.effective_until,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)')) overlap`,
      [brand, menu, p.effectiveFrom.instant, p.effectiveUntil?.instant ?? null, replaced],
    );
    if (rows.length !== 1 || typeof rows[0]?.overlap !== "boolean") return fail();
    return rows[0].overlap;
  };
  return Object.freeze({
    resolveOperation: (reference) =>
      scoped(async (tx) => {
        const op = parseCatalogReference(reference);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogMenuPublicationOperation:" + brand + ":" + op,
        ]);
        await fence(tx);
        return readOperation(tx, op);
      }),
    load: (version) =>
      scoped(async (tx) => {
        await fence(tx);
        return load(tx, parseCatalogReference(version));
      }),
    hasEffectiveOverlap: (record) =>
      scoped(async (tx) => {
        await fence(tx);
        return overlap(tx, record);
      }),
    nextReleaseSequence: (reference) =>
      scoped(async (tx) => {
        if (reference !== menu) return fail("CATALOG_PERMISSION_DENIED");
        await fence(tx);
        return ((await release(tx))?.sequence ?? 0) + 1;
      }),
    currentRelease: (reference) =>
      scoped(async (tx) => {
        if (reference !== menu) return fail("CATALOG_PERMISSION_DENIED");
        await fence(tx);
        return release(tx);
      }),
    commit: (input) => {
      const operation = normalize(input.operation),
        c = operation.command,
        l = operation.result.lifecycle;
      const audit = validateAuditRecord(input.audit, Date.parse(c.requestedAt));
      if (
        c.menuReference !== menu ||
        l.scope.brandReference !== brand ||
        input.expectedVersion !== c.expectedVersion ||
        audit.brandId !== brand ||
        audit.storeId !== undefined ||
        audit.actor.type === "System" ||
        audit.targetType !== "CatalogMenuVersion" ||
        audit.targetId !== c.menuVersionReference ||
        audit.actionCode !== "CATALOG_MENU_" + c.action.toUpperCase() ||
        audit.occurredAt !== c.requestedAt
      )
        return fail("CATALOG_PERMISSION_DENIED");
      const actorReference = audit.actor.reference;
      return scoped(async (tx) => {
        await allowed(tx, operation);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogMenuPublicationOperation:" + brand + ":" + c.operationReference,
        ]);
        await fence(tx);
        const prior = await readOperation(tx, c.operationReference);
        if (prior) {
          if (!equal(prior, operation)) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        const current = await load(tx, c.menuVersionReference);
        const evidence = await options.evidence(tx, c);
        const baseline =
          current?.lifecycle ??
          (evidence.draft === null ? null : createPublishingLifecycleRecord(evidence.draft));
        if (!baseline || baseline.version !== c.expectedVersion)
          return fail("CATALOG_VERSION_CONFLICT");
        if (
          String(baseline.familyReference) !== menu ||
          String(baseline.snapshotReference) !== c.menuVersionReference ||
          baseline.snapshotDigest !== c.snapshotDigest ||
          baseline.scope.brandReference !== brand ||
          baseline.scope.kind !== "Brand" ||
          baseline.scope.storeReference !== null ||
          (!current &&
            (c.action !== "SubmitReview" || baseline.state !== "Draft" || baseline.version !== 1))
        )
          return fail("CATALOG_LIFECYCLE_CONFLICT");
        if (
          c.action === "Approve" &&
          String(evidence.approval?.approvedActorReference) !== actorReference
        )
          return fail("CATALOG_PERMISSION_DENIED");
        if (c.action === "Publish") {
          if (!evidence.validation || !evidence.approval) return fail("CATALOG_LIFECYCLE_CONFLICT");
          const validation = createPublishingValidationEvidence(evidence.validation);
          const approval = createPublishingApprovalEvidence(evidence.approval);
          if (
            validation.evidenceReference !== baseline.validationEvidenceReference ||
            approval.evidenceReference !== baseline.approvalEvidenceReference ||
            validation.snapshotReference !== baseline.snapshotReference ||
            approval.snapshotReference !== baseline.snapshotReference ||
            validation.snapshotDigest !== baseline.snapshotDigest ||
            approval.snapshotDigest !== baseline.snapshotDigest ||
            !samePublishingScope(validation.scope, baseline.scope) ||
            !samePublishingScope(approval.scope, baseline.scope) ||
            approval.reviewLifecycleId !== baseline.lifecycleId ||
            approval.reviewVersion !== baseline.version - 1 ||
            String(validation.checkedAt) > c.requestedAt ||
            String(validation.validUntil) <= c.requestedAt ||
            String(approval.approvedAt) > c.requestedAt ||
            String(approval.validUntil) <= c.requestedAt
          )
            return fail("CATALOG_LIFECYCLE_CONFLICT");
        }
        const expected = transitionMenuPublication({
          operation: c.action,
          current: baseline,
          validation: c.action === "SubmitReview" ? evidence.validation : null,
          approval: c.action === "Approve" ? evidence.approval : null,
          at: c.requestedAt,
        });
        if (!equal(expected, l)) return fail("CATALOG_LIFECYCLE_CONFLICT");
        const r = operation.result.release,
          p = operation.result.effectivePeriod;
        if (c.action === "Publish") {
          const previous = await release(tx);
          if (
            !r ||
            !p ||
            !equal(p, c.effectivePeriod) ||
            r.familyReference !== menu ||
            String(r.snapshotReference) !== c.menuVersionReference ||
            r.snapshotDigest !== c.snapshotDigest ||
            r.sourceLifecycleId !== l.lifecycleId ||
            !equal(r.scope, l.scope) ||
            r.configurationType !== l.configurationType ||
            r.purposeCode !== l.purposeCode ||
            r.kind !== "Publish" ||
            r.sequence !== (previous?.sequence ?? 0) + 1 ||
            r.previousReleaseId !== (previous?.releaseId ?? null) ||
            String(r.createdAt) !== c.requestedAt ||
            (await overlap(tx, operation.result)) ||
            input.event === null
          )
            return fail("CATALOG_LIFECYCLE_CONFLICT");
          const expectedEvent = createMenuPublishedEnvelope({
            eventReference: input.event.eventId,
            operationReference: c.operationReference,
            correlationReference: audit.correlationId,
            actorReference,
            menuReference: menu,
            brandReference: brand,
            record: operation.result,
          });
          if (!equal(eventValue(expectedEvent), eventValue(input.event)))
            return fail("CATALOG_INPUT_INVALID");
        } else if (
          c.effectivePeriod !== null ||
          input.event !== null ||
          !equal(r, current?.release ?? null) ||
          !equal(p, current?.effectivePeriod ?? null)
        )
          return fail("CATALOG_INPUT_INVALID");
        await allowed(tx, operation);
        await tx.query("SAVEPOINT catalog_menu_publication", []);
        try {
          await tx.query(
            "INSERT INTO rms_catalog.menu_publication_revision VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              l.lifecycleId,
              l.version,
              menu,
              c.menuVersionReference,
              brand,
              l.snapshotDigest,
              l.state,
              l.validationEvidenceReference,
              l.approvalEvidenceReference,
              l.changedAt,
            ],
          );
          if (c.action === "Publish" && r && p) {
            const replaced = await supersedable(tx, p.effectiveFrom.instant);
            if (await overlap(tx, operation.result)) return fail("CATALOG_LIFECYCLE_CONFLICT");
            await tx.query(
              "INSERT INTO rms_catalog.menu_publication_release VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              [
                r.releaseId,
                l.lifecycleId,
                l.version,
                menu,
                c.menuVersionReference,
                brand,
                r.sequence,
                r.previousReleaseId,
                r.kind,
                r.snapshotDigest,
                r.createdAt,
              ],
            );
            await tx.query(
              "INSERT INTO rms_catalog.menu_release_effective_period VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
              [
                parseCatalogReference(options.timingReference(c.operationReference)),
                r.releaseId,
                menu,
                brand,
                p.timeZone,
                p.effectiveFrom.instant,
                p.effectiveUntil?.instant ?? null,
                "sha256:" + sha256Hex(canonicalizeRfc8785(p)),
                l.approvalEvidenceReference,
                c.requestedAt,
              ],
            );
            if (replaced !== null)
              await tx.query(
                "INSERT INTO rms_catalog.menu_release_effective_end(release_id,brand_id,menu_id,ended_at,superseded_by_release_id,operation_id) VALUES($1,$2,$3,$4,$5,$6)",
                [replaced, brand, menu, p.effectiveFrom.instant, r.releaseId, c.operationReference],
              );
          }
          await tx.query(
            "INSERT INTO rms_catalog.menu_publication_operation_record VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              c.operationReference,
              brand,
              menu,
              c.menuVersionReference,
              c.action,
              "sha256:" + operation.intentHash,
              l.version,
              c.requestedAt,
            ],
          );
          await tx.query(
            "INSERT INTO rms_catalog.menu_publication_operation_snapshot(operation_id,brand_id,menu_id,menu_version_id,lifecycle_id,lifecycle_version,operation_json) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              c.operationReference,
              brand,
              menu,
              c.menuVersionReference,
              l.lifecycleId,
              l.version,
              JSON.stringify(operation),
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          if (input.event !== null)
            await appendEventInTransaction(
              {
                query: async (sql, values) => {
                  const result = await tx.query(sql, values);
                  if (result.rowCount === undefined) return fail();
                  return { rowCount: result.rowCount };
                },
              },
              input.event,
            );
          await allowed(tx, operation);
          const saved = await readOperation(tx, c.operationReference);
          if (!equal(saved, operation)) return fail();
          await tx.query("RELEASE SAVEPOINT catalog_menu_publication", []);
          return operation;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT catalog_menu_publication", []);
          await tx.query("RELEASE SAVEPOINT catalog_menu_publication", []);
          throw error;
        }
      });
    },
  });
}
