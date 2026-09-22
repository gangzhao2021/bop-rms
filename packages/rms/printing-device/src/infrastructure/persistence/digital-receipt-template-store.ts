import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import { parseDeviceReference, parseDeviceInstant } from "../../contracts/device-management.js";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateVersion,
  resolveDigitalReceiptTemplate,
  type DigitalReceiptTemplateVersion,
} from "../../contracts/digital-receipt-template.js";

export interface ReceiptTemplateTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}
const fail = (): never => {
  throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
};
const encode = (version: DigitalReceiptTemplateVersion) =>
  canonicalizeRfc8785(JSON.parse(JSON.stringify(version)));
/** Caller retains owner/publication/artifact authorization fences through commit.
 * Publication callbacks must use actual owner evidence; references alone do not qualify.
 */
export function createPostgresDigitalReceiptTemplateStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    tx: ReceiptTemplateTransaction,
    input: {
      brandReference: string;
      storeReference: string;
      templateReference: string;
      action: "Read" | "Publish";
    },
  ): Promise<boolean>;
  validatePublication(
    tx: ReceiptTemplateTransaction,
    version: DigitalReceiptTemplateVersion,
    digest: string,
  ): Promise<boolean>;
  isCurrentPublication(
    tx: ReceiptTemplateTransaction,
    version: DigitalReceiptTemplateVersion,
    observedAt: string,
  ): Promise<boolean>;
}) {
  const brand = parseDeviceReference(options.brandReference),
    store = parseDeviceReference(options.storeReference);
  const authorize = async (
    tx: ReceiptTemplateTransaction,
    template: string,
    action: "Read" | "Publish",
  ) => {
    if (
      (await options.authorize(tx, {
        brandReference: brand,
        storeReference: store,
        templateReference: template,
        action,
      })) !== true
    )
      throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  };
  const fence = async (tx: ReceiptTemplateTransaction, template: string) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "ReceiptTemplate:" + brand + ":" + store + ":" + template,
    ]);
  };
  const decode = (row: Record<string, unknown>) => {
    const version = parseDigitalReceiptTemplateVersion(row.version_json);
    if (
      version.brandReference !== brand ||
      version.storeReference !== store ||
      version.versionReference !== row.version_id ||
      version.templateReference !== row.template_id ||
      String(version.versionNumber) !== row.version_number ||
      version.versionCode !== row.version_code ||
      version.publicationReference !== row.publication_id ||
      version.publishedAt !==
        (row.published_at instanceof Date ? row.published_at.toISOString() : row.published_at)
    )
      return fail();
    return version;
  };
  const read = async (tx: ReceiptTemplateTransaction, template: string) => {
    const result = await tx.query(
      "SELECT version_id,template_id,version_number::text AS version_number,version_code,publication_id,published_at,version_json FROM rms_device.digital_receipt_template_version WHERE brand_id=$1 AND store_id=$2 AND template_id=$3 ORDER BY version_number LIMIT 101",
      [brand, store, template],
    );
    if (result.rows.length > 100) return fail();
    return result.rows.map(decode);
  };
  return Object.freeze({
    async resolve(
      tx: ReceiptTemplateTransaction,
      input: { templateReference: string; locale: string; observedAt: string },
    ) {
      try {
        const template = parseDeviceReference(input.templateReference),
          at = parseDeviceInstant(input.observedAt);
        await authorize(tx, template, "Read");
        await fence(tx, template);
        const versions = await read(tx, template),
          current = [];
        for (const version of versions) {
          const accepted = await options.isCurrentPublication(tx, version, at);
          if (accepted !== true && accepted !== false) return fail();
          if (accepted) current.push(version);
        }
        const resolved = resolveDigitalReceiptTemplate({
          brandReference: brand,
          storeReference: store,
          templateReference: template,
          locale: input.locale,
          observedAt: at,
          versions: current,
        });
        await authorize(tx, template, "Read");
        return resolved;
      } catch (error) {
        if (error instanceof DigitalReceiptTemplateError) throw error;
        return fail();
      }
    },
    async appendPublished(
      tx: ReceiptTemplateTransaction,
      input: {
        version: unknown;
        operationReference: string;
        publicationDigest: string;
        audit: unknown;
      },
    ) {
      try {
        const version = parseDigitalReceiptTemplateVersion(input.version),
          operation = parseDeviceReference(input.operationReference);
        const audit = validateAuditRecord(input.audit);
        if (
          version.brandReference !== brand ||
          version.storeReference !== store ||
          !/^sha256:[0-9a-f]{64}$/u.test(input.publicationDigest) ||
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.targetType !== "DigitalReceiptTemplate" ||
          audit.targetId !== version.versionReference ||
          audit.actionCode !== "RECEIPT_TEMPLATE_PUBLISH" ||
          audit.correlationId !== operation ||
          audit.occurredAt !== version.publishedAt ||
          audit.dataClassification !== "Confidential" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail();
        await authorize(tx, version.templateReference, "Publish");
        await fence(tx, version.templateReference);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "ReceiptTemplateOperation:" + brand + ":" + store + ":" + operation,
        ]);
        await authorize(tx, version.templateReference, "Publish");
        const prior = await tx.query(
          "SELECT version_json,publication_digest,audit_id FROM rms_device.digital_receipt_template_version WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [brand, store, operation],
        );
        const existing = prior.rows[0];
        if (existing) {
          const record = parseDigitalReceiptTemplateVersion(existing.version_json);
          if (
            encode(record) !== encode(version) ||
            existing.publication_digest !== input.publicationDigest ||
            existing.audit_id !== audit.auditId
          )
            throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_CONFLICT");
          return Object.freeze({ status: "Existing" as const, version: record });
        }
        const versions = await read(tx, version.templateReference);
        if (version.versionNumber !== (versions.at(-1)?.versionNumber ?? 0) + 1)
          throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_CONFLICT");
        if ((await options.validatePublication(tx, version, input.publicationDigest)) !== true)
          return fail();
        const current = [];
        for (const priorVersion of versions) {
          const accepted = await options.isCurrentPublication(
            tx,
            priorVersion,
            version.effectiveFrom,
          );
          if (accepted !== true && accepted !== false) return fail();
          if (accepted) current.push(priorVersion);
        }
        resolveDigitalReceiptTemplate({
          brandReference: brand,
          storeReference: store,
          templateReference: version.templateReference,
          locale: version.locale,
          observedAt: version.effectiveFrom,
          versions: [...current, version],
        });
        await authorize(tx, version.templateReference, "Publish");
        await tx.query("SAVEPOINT receipt_template_publish", []);
        try {
          const inserted = await tx.query(
            "INSERT INTO rms_device.digital_receipt_template_version (version_id,brand_id,store_id,template_id,version_number,version_code,operation_id,audit_id,publication_id,publication_digest,published_at,version_json,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Confidential')",
            [
              version.versionReference,
              brand,
              store,
              version.templateReference,
              version.versionNumber,
              version.versionCode,
              operation,
              audit.auditId,
              version.publicationReference,
              input.publicationDigest,
              version.publishedAt,
              encode(version),
            ],
          );
          if (inserted.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query("RELEASE SAVEPOINT receipt_template_publish", []);
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT receipt_template_publish", []);
          await tx.query("RELEASE SAVEPOINT receipt_template_publish", []);
          return fail();
        }
        return Object.freeze({ status: "Created" as const, version });
      } catch (error) {
        if (error instanceof DigitalReceiptTemplateError) throw error;
        return fail();
      }
    },
  });
}
