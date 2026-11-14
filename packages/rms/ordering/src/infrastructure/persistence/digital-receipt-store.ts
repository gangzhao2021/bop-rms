import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  decodeDigitalReceiptRecord,
  encodeDigitalReceiptRecord,
} from "../../domain/digital-receipt-codec.js";
import {
  DigitalReceiptError,
  parseDigitalReceiptChain,
  parseDigitalReceiptRecord,
  type DigitalReceiptRecord,
} from "../../domain/digital-receipt.js";

type ReceiptAccess =
  | { readonly action: "IssueOriginal"; readonly orderReference: string }
  | { readonly action: "IssueCorrection"; readonly orderReference: string }
  | { readonly action: "IssueRefund"; readonly orderReference: string }
  | { readonly action: "Read"; readonly orderReference: string }
  | {
      readonly action: "Append";
      readonly orderReference: string;
      readonly record: DigitalReceiptRecord;
    };

function fail(code: DigitalReceiptError["code"] = "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE"): never {
  throw new DigitalReceiptError(code);
}

/** All source/authorization fences must remain held by the caller through transaction commit. */
export function createPostgresDigitalReceiptStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, access: ReceiptAccess): Promise<boolean>;
  validateSources(
    transaction: ConsumerTransaction,
    record: DigitalReceiptRecord,
    sourceDigest: string,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const authorize = async (tx: ConsumerTransaction, access: ReceiptAccess) => {
    if ((await options.authorize(tx, access)) !== true)
      return fail("DIGITAL_RECEIPT_PERMISSION_DENIED");
  };
  const scope = async (tx: ConsumerTransaction) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  };
  const read = async (tx: ConsumerTransaction, order: string) => {
    const result = await tx.query(
      "SELECT receipt_record_json::text AS record FROM rms_ordering.digital_receipt_record " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY version LIMIT 101",
      [brand, store, order],
    );
    if (result.rows.length === 0) return null;
    const chain = parseDigitalReceiptChain({
      orderReference: order,
      records: result.rows.map((row) => decodeDigitalReceiptRecord(row.record)),
    });
    if (
      chain.records.some(
        (record) =>
          record.snapshot.brandReference !== brand || record.snapshot.storeReference !== store,
      )
    )
      return fail();
    return chain;
  };
  const repository = Object.freeze({
    async issueOriginal(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      create(): Promise<{
        operationReference: string;
        sourceDigest: string;
        record: unknown;
        audit: unknown;
      }>;
    }): Promise<{
      readonly status: "Created" | "Existing";
      readonly record: DigitalReceiptRecord;
    }> {
      const tx = input.transaction;
      const order = parseOrderingReference(input.orderReference);
      const access = { action: "IssueOriginal" as const, orderReference: order };
      await authorize(tx, access);
      await scope(tx);
      // Lock before source acquisition: all first issuers serialize in the same order.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingReceipt:" + brand + ":" + store + ":" + order,
      ]);
      await authorize(tx, access);
      const chain = await read(tx, order);
      const original = chain?.records[0];
      if (original) {
        await authorize(tx, access);
        return Object.freeze({ status: "Existing", record: original });
      }
      const candidate = await input.create();
      const record = parseDigitalReceiptRecord(candidate.record);
      if (
        record.kind !== "Original" ||
        record.version !== 1 ||
        record.snapshot.orderReference !== order
      )
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      await authorize(tx, access);
      return repository.append({ ...candidate, record, transaction: tx });
    },
    async issueRefund(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      create(chain: ReturnType<typeof parseDigitalReceiptChain>): Promise<{
        operationReference: string;
        sourceDigest: string;
        record: unknown;
        audit: unknown;
      } | null>;
    }) {
      const tx = input.transaction;
      const order = parseOrderingReference(input.orderReference);
      const access = { action: "IssueRefund" as const, orderReference: order };
      await authorize(tx, access);
      await scope(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingReceipt:" + brand + ":" + store + ":" + order,
      ]);
      await authorize(tx, access);
      const chain = await read(tx, order);
      const latest = chain?.records.at(-1);
      if (!chain || !latest || latest.kind === "Void")
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      const candidate = await input.create(chain);
      await authorize(tx, access);
      if (candidate === null) return Object.freeze({ status: "Existing" as const, record: latest });
      const record = parseDigitalReceiptRecord(candidate.record);
      if (
        record.kind !== "Refund" ||
        record.version !== latest.version + 1 ||
        record.previousRecordReference !== latest.recordReference ||
        record.snapshot.orderReference !== order
      )
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      return repository.append({ ...candidate, record, transaction: tx });
    },
    async issueCorrection(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      create(chain: ReturnType<typeof parseDigitalReceiptChain>): Promise<{
        operationReference: string;
        sourceDigest: string;
        record: unknown;
        audit: unknown;
      } | null>;
    }) {
      const tx = input.transaction;
      const order = parseOrderingReference(input.orderReference);
      const access = { action: "IssueCorrection" as const, orderReference: order };
      await authorize(tx, access);
      await scope(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingReceipt:" + brand + ":" + store + ":" + order,
      ]);
      await authorize(tx, access);
      const chain = await read(tx, order);
      const latest = chain?.records.at(-1);
      if (!chain || !latest || latest.kind === "Void")
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      const candidate = await input.create(chain);
      await authorize(tx, access);
      if (candidate === null) return Object.freeze({ status: "Existing" as const, record: latest });
      const record = parseDigitalReceiptRecord(candidate.record);
      if (
        record.kind !== "Correction" ||
        record.version !== latest.version + 1 ||
        record.previousRecordReference !== latest.recordReference ||
        record.snapshot.orderReference !== order
      )
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      return repository.append({ ...candidate, record, transaction: tx });
    },
    async load(input: { transaction: ConsumerTransaction; orderReference: string }) {
      const order = parseOrderingReference(input.orderReference);
      const access = { action: "Read" as const, orderReference: order };
      await authorize(input.transaction, access);
      await scope(input.transaction);
      const chain = await read(input.transaction, order);
      await authorize(input.transaction, access);
      return chain;
    },
    async append(input: {
      transaction: ConsumerTransaction;
      operationReference: string;
      sourceDigest: string;
      record: unknown;
      audit: unknown;
    }) {
      const record = parseDigitalReceiptRecord(input.record);
      const operation = parseOrderingReference(input.operationReference);
      const tx = input.transaction,
        snapshot = record.snapshot;
      const audit = validateAuditRecord(input.audit);
      if (
        snapshot.brandReference !== brand ||
        snapshot.storeReference !== store ||
        typeof input.sourceDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.sourceDigest) ||
        record.recordedAt < snapshot.issuedAt ||
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.targetType !== "DigitalReceipt" ||
        audit.targetId !== record.recordReference ||
        audit.actionCode !== "DIGITAL_RECEIPT_APPEND" ||
        audit.correlationId !== operation ||
        audit.occurredAt !== record.recordedAt ||
        audit.dataClassification !== "Restricted" ||
        audit.beforeSummary !== undefined ||
        audit.afterSummary !== undefined
      )
        return fail("DIGITAL_RECEIPT_INPUT_INVALID");
      const access = { action: "Append" as const, orderReference: snapshot.orderReference, record };
      await authorize(tx, access);
      await scope(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingReceipt:" + brand + ":" + store + ":" + snapshot.orderReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingReceiptOperation:" + brand + ":" + store + ":" + operation,
      ]);
      await authorize(tx, access);
      const prior = await tx.query(
        "SELECT receipt_record_json::text AS record,audit_id,source_digest FROM rms_ordering.digital_receipt_record " +
          "WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 LIMIT 1",
        [brand, store, operation],
      );
      const original = prior.rows[0];
      if (original) {
        const recovered = decodeDigitalReceiptRecord(original.record);
        if (
          original.audit_id !== audit.auditId ||
          original.source_digest !== input.sourceDigest ||
          encodeDigitalReceiptRecord(recovered) !== encodeDigitalReceiptRecord(record)
        )
          return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
        return Object.freeze({ status: "Existing" as const, record: recovered });
      }
      const chain = await read(tx, snapshot.orderReference);
      parseDigitalReceiptChain({
        orderReference: snapshot.orderReference,
        records: [...(chain?.records ?? []), record],
      });
      const previous = chain?.records.at(-1);
      if (previous && record.recordedAt < previous.recordedAt)
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      const order = await tx.query(
        "SELECT h.order_number,s.guest_session_id FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.submission_kind='Initial' " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 FOR SHARE OF h,s",
        [brand, store, snapshot.orderReference],
      );
      if (
        order.rows.length !== 1 ||
        order.rows[0]?.order_number !== snapshot.orderNumber ||
        order.rows[0]?.guest_session_id !== snapshot.guestSessionReference
      )
        return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
      if ((await options.validateSources(tx, record, input.sourceDigest)) !== true) return fail();
      await authorize(tx, access);
      await tx.query("SAVEPOINT ordering_receipt_append", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.digital_receipt_record " +
            "(record_id,operation_id,audit_id,brand_id,store_id,order_id,receipt_id,guest_session_id,version,kind,previous_record_id,source_digest,recorded_at,receipt_record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            record.recordReference,
            operation,
            audit.auditId,
            brand,
            store,
            snapshot.orderReference,
            snapshot.receiptReference,
            snapshot.guestSessionReference,
            record.version,
            record.kind,
            record.previousRecordReference,
            input.sourceDigest,
            record.recordedAt,
            encodeDigitalReceiptRecord(record),
          ],
        );
        if (inserted.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await authorize(tx, access);
        if ((await options.validateSources(tx, record, input.sourceDigest)) !== true) return fail();
        await tx.query("RELEASE SAVEPOINT ordering_receipt_append", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_receipt_append", []);
        await tx.query("RELEASE SAVEPOINT ordering_receipt_append", []);
        return fail();
      }
      return Object.freeze({ status: "Created" as const, record });
    },
  });
  return repository;
}
