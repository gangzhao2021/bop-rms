import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AuditTransaction,
} from "@bop/audit";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import {
  parsePaymentTipSelection,
  samePaymentTipSelection,
  PaymentTipSelectionError,
  type PaymentTipSelection,
} from "../../application/payment-tip-selection.js";

export interface PaymentTipTransactionRunner {
  /** Supplies one bounded transaction and owns commit, rollback and connection/context cleanup. */
  run<T>(action: (transaction: AuditTransaction) => Promise<T>): Promise<T>;
}
const fail = (code: PaymentTipSelectionError["code"] = "PAYMENT_TIP_UNAVAILABLE"): never => {
  throw new PaymentTipSelectionError(code);
};
const normalize = (error: unknown): never => {
  if (error instanceof PaymentTipSelectionError) throw error;
  return fail();
};
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return fail();
  const list: unknown = descriptor.value;
  if (
    !Array.isArray(list) ||
    Object.getPrototypeOf(list) !== Array.prototype ||
    list.length > 1 ||
    Reflect.ownKeys(list).length !== list.length + 1
  )
    return fail();
  if (list.length === 0) return [];
  const item = Object.getOwnPropertyDescriptor(list, "0");
  if (!item?.enumerable || !("value" in item)) return fail();
  return [item.value];
}

/** Owner storage only: current Guest/CSRF authority must be established by application composition. */
export function createPostgresPaymentTipSelectionStore(
  runner: PaymentTipTransactionRunner,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  clock: { now(): string },
) {
  const scope = exactPaymentObject(scopeInput, ["brandReference", "storeReference"]);
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference);
  const scoped = (record: PaymentTipSelection) => {
    if (record.brandReference !== brand || record.storeReference !== store)
      return fail("PAYMENT_TIP_CONFLICT");
    return record;
  };
  const context = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const load = async (tx: AuditTransaction, reference: string) => {
    const found = rows(
      await tx.query(
        'SELECT selection_id::text AS "selectionReference", payment_operation_id::text AS "paymentOperationReference", submission_id::text AS "submissionReference", cart_id::text AS "cartReference", cart_version::text AS "cartVersion", quote_id::text AS "quoteReference", guest_session_id::text AS "guestSessionReference", brand_id::text AS "brandReference", store_id::text AS "storeReference", tip_minor::text AS "tipMinor", to_char(selected_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "selectedAt" FROM rms_payment.payment_tip_selection WHERE brand_id=$1 AND store_id=$2 AND selection_id=$3',
        [brand, store, reference],
      ),
    );
    if (found.length === 0) return null;
    const raw = exactPaymentObject(found[0], [
      "selectionReference",
      "paymentOperationReference",
      "submissionReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "guestSessionReference",
      "brandReference",
      "storeReference",
      "tipMinor",
      "selectedAt",
    ]);
    if (
      typeof raw.tipMinor !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/u.test(raw.tipMinor) ||
      typeof raw.cartVersion !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(raw.cartVersion)
    )
      return fail();
    const { tipMinor, cartVersion, ...fields } = raw;
    const record = scoped(
      parsePaymentTipSelection({
        ...fields,
        cartVersion: Number(cartVersion),
        tip: { amountMinor: BigInt(tipMinor), currencyCode: "CAD" },
      }),
    );
    if (record.selectionReference !== reference) return fail();
    return record;
  };
  return Object.freeze({
    async load(referenceValue: unknown) {
      try {
        const reference = parsePaymentReference(referenceValue);
        return await runner.run(async (tx) => {
          await context(tx);
          return load(tx, reference);
        });
      } catch (error) {
        return normalize(error);
      }
    },
    async append(value: unknown) {
      try {
        const raw = exactPaymentObject(value, ["record", "audit"]);
        const record = scoped(parsePaymentTipSelection(raw.record));
        const observedAt = parsePaymentInstant(clock.now());
        if (record.selectedAt > observedAt) return fail("PAYMENT_TIP_INVALID");
        const audit = validateAuditRecord(raw.audit as never, Date.parse(observedAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "PAYMENT_TIP_SELECT" ||
          audit.targetType !== "PaymentTipSelection" ||
          audit.targetId !== record.selectionReference ||
          audit.reasonCode !== "AUTHORIZED_PAYMENT_TIP_SELECT" ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined ||
          audit.occurredAt !== record.selectedAt
        )
          return fail("PAYMENT_TIP_INVALID");
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentTip:" + brand + ":" + store + ":" + record.selectionReference,
          ]);
          const prior = await load(tx, record.selectionReference);
          if (prior !== null) {
            if (!samePaymentTipSelection(prior, record)) return fail("PAYMENT_TIP_CONFLICT");
            return Object.freeze({ status: "Existing" as const, record: prior });
          }
          const result = await tx.query(
            "INSERT INTO rms_payment.payment_tip_selection (selection_id,brand_id,store_id,payment_operation_id,submission_id,cart_id,cart_version,quote_id,guest_session_id,tip_minor,currency_code,selected_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CAD',$11)",
            [
              record.selectionReference,
              brand,
              store,
              record.paymentOperationReference,
              record.submissionReference,
              record.cartReference,
              record.cartVersion,
              record.quoteReference,
              record.guestSessionReference,
              record.tip.amountMinor.toString(),
              record.selectedAt,
            ],
          );
          if (
            result === null ||
            typeof result !== "object" ||
            Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
          )
            return fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Created" as const, record });
        });
      } catch (error) {
        return normalize(error);
      }
    },
  });
}
