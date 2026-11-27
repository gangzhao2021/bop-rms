import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  parsePublishingDigest,
} from "@bop/publishing";
import {
  parseReviewedMenuContent,
  parsePublishedMenuSnapshot,
  type ReviewedMenuContent,
} from "../../contracts/published-menu-projection.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import { validateMenuEffectivePeriod } from "../../domain/menu-publication.js";
import type { MenuPublicationRecord } from "../../contracts/menu-publication.js";
import type { PublishedMenuProjectionPorts } from "../../application/ports/published-menu-projection-ports.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
export interface MenuReviewContentInput {
  lifecycleReference: string;
  configurationDigest: string;
  dependencyDigest?: string;
  content: ReviewedMenuContent;
  createdByActorReference: string;
  createdAt: string;
}
export function createMenuReviewContent(input: MenuReviewContentInput) {
  const content = parseReviewedMenuContent(input.content);
  if (!equal(content, input.content)) return fail("CATALOG_INPUT_INVALID");
  const configurationDigest = parsePublishingDigest(input.configurationDigest);
  const dependency =
    input.dependencyDigest === undefined
      ? {}
      : {
          dependencyDigest: parsePublishingDigest(input.dependencyDigest),
        };
  return Object.freeze({
    lifecycleReference: parseCatalogReference(input.lifecycleReference),
    configurationDigest,
    ...dependency,
    content,
    snapshotDigest: parsePublishingDigest(
      "sha256:" + sha256Hex(canonicalizeRfc8785({ configurationDigest, ...dependency, content })),
    ),
    createdByActorReference: parseCatalogReference(input.createdByActorReference),
    createdAt: parseCatalogInstant(input.createdAt),
  });
}
export type MenuReviewContent = ReturnType<typeof createMenuReviewContent>;
function normalize(value: MenuReviewContent): MenuReviewContent {
  const record = createMenuReviewContent(value);
  if (!equal(record, value)) return fail();
  return record;
}

/** Structural storage only: a caller must separately validate the underlying
 * Product/option/allergen facts. Saving content creates neither review nor approval.
 * All methods retain the caller's transaction and use this Domain's owned tables.
 */
export function createPostgresMenuReviewContentStore(options: {
  brandReference: string;
  menuReference: string;
  authorize(
    tx: ProductLifecycleTransaction,
    operation: "Read" | "Save",
    menuVersionReference: string,
  ): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference),
    menu = parseCatalogReference(options.menuReference);
  const allowed = async (
    tx: ProductLifecycleTransaction,
    operation: "Read" | "Save",
    version: string,
  ) => {
    if ((await options.authorize(tx, operation, version)) !== true)
      return fail("CATALOG_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  };
  const parse = (value: unknown) => {
    const record = normalize(value as MenuReviewContent);
    if (record.content.brandReference !== brand || record.content.menuReference !== menu)
      return fail();
    return record;
  };
  return {
    async save(
      tx: ProductLifecycleTransaction,
      input: MenuReviewContent,
      auditInput: AppendAuditRecordInput,
    ) {
      try {
        const record = parse(input),
          version = record.content.menuVersionReference;
        await allowed(tx, "Save", version);
        const audit = validateAuditRecord(auditInput, Date.parse(record.createdAt));
        if (
          audit.actor.type !== "User" ||
          audit.actor.reference !== record.createdByActorReference ||
          audit.brandId !== brand ||
          audit.storeId !== undefined ||
          audit.actionCode !== "CATALOG_MENU_SNAPSHOT_CREATED" ||
          audit.targetType !== "CatalogMenuVersion" ||
          audit.targetId !== version ||
          audit.occurredAt !== record.createdAt
        )
          return fail("CATALOG_PERMISSION_DENIED");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogMenuPublication:" + brand + ":" + menu,
        ]);
        const prior = await tx.query<{ snapshot_json: unknown }>(
          "SELECT snapshot_json FROM rms_catalog.menu_review_content WHERE brand_id=$1 AND menu_id=$2 AND (lifecycle_id=$3 OR (menu_version_id=$4 AND snapshot_digest=$5))",
          [brand, menu, record.lifecycleReference, version, record.snapshotDigest],
        );
        const priorRow = prior.rows[0];
        if (priorRow) {
          if (prior.rows.length !== 1 || !equal(parse(priorRow.snapshot_json), record))
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          await allowed(tx, "Save", version);
          return record;
        }
        await tx.query("SAVEPOINT catalog_menu_review_content", []);
        try {
          const inserted = await tx.query(
            "INSERT INTO rms_catalog.menu_review_content (lifecycle_id,brand_id,menu_id,menu_version_id,snapshot_digest,snapshot_json,audit_reference) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)",
            [
              record.lifecycleReference,
              brand,
              menu,
              version,
              record.snapshotDigest,
              JSON.stringify(record),
              audit.auditId,
            ],
          );
          if (inserted.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await allowed(tx, "Save", version);
          await tx.query("RELEASE SAVEPOINT catalog_menu_review_content", []);
          return record;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT catalog_menu_review_content", []);
          await tx.query("RELEASE SAVEPOINT catalog_menu_review_content", []);
          throw error;
        }
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
    async read(
      tx: ProductLifecycleTransaction,
      menuVersionReference: string,
      snapshotDigest: string,
      observedAt: string,
    ) {
      try {
        const version = parseCatalogReference(menuVersionReference),
          digest = parsePublishingDigest(snapshotDigest);
        const at = parseCatalogInstant(observedAt);
        await allowed(tx, "Read", version);
        const result = await tx.query<{ snapshot_json: unknown }>(
          "SELECT snapshot_json FROM rms_catalog.menu_review_content WHERE brand_id=$1 AND menu_id=$2 AND menu_version_id=$3 AND snapshot_digest=$4",
          [brand, menu, version, digest],
        );
        if (result.rows.length > 1) return fail();
        const record = result.rows[0] ? parse(result.rows[0].snapshot_json) : null;
        if (
          record &&
          (record.content.menuVersionReference !== version ||
            record.snapshotDigest !== digest ||
            record.createdAt > at)
        )
          return fail();
        await allowed(tx, "Read", version);
        return record;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
    async loadExact(
      tx: ProductLifecycleTransaction,
      input: Parameters<PublishedMenuProjectionPorts["snapshots"]["loadExact"]>[0],
    ) {
      try {
        const version = parseCatalogReference(input.menuVersionReference);
        const release = parseCatalogReference(input.releaseReference),
          digest = parsePublishingDigest(input.snapshotDigest);
        await allowed(tx, "Read", version);
        if (input.brandReference !== brand || input.menuReference !== menu)
          return fail("CATALOG_PERMISSION_DENIED");
        const rows = (
          await tx.query<{ snapshot_json: unknown; operation_json: unknown }>(
            "SELECT c.snapshot_json,s.operation_json FROM rms_catalog.menu_review_content c JOIN rms_catalog.menu_publication_release r ON r.lifecycle_id=c.lifecycle_id AND r.menu_version_id=c.menu_version_id AND r.menu_id=c.menu_id AND r.brand_id=c.brand_id AND r.snapshot_digest=c.snapshot_digest JOIN rms_catalog.menu_publication_operation_snapshot s ON s.lifecycle_id=r.lifecycle_id AND s.lifecycle_version=r.lifecycle_version AND s.menu_id=r.menu_id AND s.menu_version_id=r.menu_version_id AND s.brand_id=r.brand_id WHERE c.brand_id=$1 AND c.menu_id=$2 AND c.menu_version_id=$3 AND c.snapshot_digest=$4 AND r.release_id=$5 AND r.release_kind='Publish'",
            [brand, menu, version, digest, release],
          )
        ).rows;
        if (rows.length > 1) return fail();
        if (!rows[0]) {
          await allowed(tx, "Read", version);
          return null;
        }
        const record = parse(rows[0].snapshot_json);
        const operation = rows[0].operation_json as {
          command: { action: string };
          result: MenuPublicationRecord;
        };
        const lifecycle = createPublishingLifecycleRecord(operation.result.lifecycle);
        const publication =
          operation.result.release === null
            ? null
            : createPublishingReleaseRecord(operation.result.release);
        if (
          operation.command.action !== "Publish" ||
          lifecycle.state !== "Published" ||
          String(lifecycle.lifecycleId) !== record.lifecycleReference ||
          String(lifecycle.familyReference) !== menu ||
          String(lifecycle.snapshotReference) !== version ||
          lifecycle.snapshotDigest !== digest ||
          String(lifecycle.scope.brandReference) !== brand ||
          lifecycle.scope.storeReference !== null ||
          !publication ||
          String(publication.releaseId) !== release ||
          publication.snapshotDigest !== digest ||
          String(publication.snapshotReference) !== version ||
          String(publication.familyReference) !== menu ||
          publication.sourceLifecycleId !== lifecycle.lifecycleId ||
          String(publication.scope.brandReference) !== brand ||
          publication.scope.storeReference !== null ||
          publication.kind !== "Publish" ||
          String(lifecycle.changedAt) < record.createdAt
        )
          return fail();
        const period = validateMenuEffectivePeriod(operation.result.effectivePeriod);
        const snapshot = parsePublishedMenuSnapshot({
          ...record.content,
          releaseReference: release,
          snapshotDigest: digest,
          timeZone: period.timeZone,
          effectiveFrom: parseCatalogInstant(period.effectiveFrom.instant),
          effectiveUntil:
            period.effectiveUntil === null
              ? null
              : parseCatalogInstant(period.effectiveUntil.instant),
        });
        await allowed(tx, "Read", version);
        return snapshot;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  };
}
