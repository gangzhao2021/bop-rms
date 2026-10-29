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
          // WP-2423 item 8 ⑦: a Store that turned tips off takes no tip (the database refuses too).
          if (
            record.tip.amountMinor > 0n &&
            !(await loadStoreTipSetting(tx, { brandReference: brand, storeReference: store }))
              .tipsEnabled
          )
            return fail("PAYMENT_TIP_TURNED_OFF");
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

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 11): the Store's tip choices
 * (2000_121). Never set: tips on, 10 / 15 / 18 %. While off, the database refuses a tip above zero
 * wherever one is chosen (a tip selection, a table's online payment or its settlement).
 */
export interface StoreTipSetting {
  /** 0: never set. */
  readonly version: number;
  readonly tipsEnabled: boolean;
  /** Three percentages, ascending, each 1–50. */
  readonly tierPercents: readonly [number, number, number];
  readonly changedAt: string | null;
}
export const defaultStoreTipTiers = Object.freeze([10, 15, 18] as const);
/** A change that saw another version first, or reused an operation for something else. */
export class StoreTipSettingConflictError extends Error {
  constructor() {
    super("STORE_TIP_SETTING_CHANGED");
    this.name = "StoreTipSettingConflictError";
  }
}
interface TipSettingTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const settingRows = (value: unknown): readonly Record<string, unknown>[] => {
  const list = (value as { rows?: unknown } | null)?.rows;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : fail();
};
/** Three ascending whole percentages, each 1–50. */
export function parseStoreTipTiers(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((n) => !Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 50) ||
    !(Number(value[0]) < Number(value[1]) && Number(value[1]) < Number(value[2]))
  )
    return fail("PAYMENT_TIP_INVALID");
  return Object.freeze([Number(value[0]), Number(value[1]), Number(value[2])] as const);
}
const tipScope = async (
  tx: TipSettingTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
) => {
  const brand = parsePaymentReference(scope.brandReference);
  const store = parsePaymentReference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return { brand, store };
};

/**
 * The Store's tip choices, in the caller's transaction (Store RLS): now, or as they were at `asOf`
 * (a payment taken during an outage is judged by the setting in force when it was taken).
 */
export async function loadStoreTipSetting(
  tx: TipSettingTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  asOf: string | null = null,
): Promise<StoreTipSetting> {
  const { brand, store } = await tipScope(tx, scope);
  const found = settingRows(
    await tx.query(
      "SELECT version,tips_enabled,tier_percents,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at FROM rms_payment.store_tip_setting WHERE brand_id=$1 AND store_id=$2 AND ($3::timestamptz IS NULL OR occurred_at<=$3::timestamptz) ORDER BY version DESC LIMIT 1",
      [brand, store, asOf === null ? null : parsePaymentInstant(asOf)],
    ),
  )[0];
  if (found === undefined)
    return Object.freeze({
      version: 0,
      tipsEnabled: true,
      tierPercents: defaultStoreTipTiers,
      changedAt: null,
    });
  const version = Number(found.version);
  if (!Number.isSafeInteger(version) || version < 1 || typeof found.tips_enabled !== "boolean")
    return fail();
  return Object.freeze({
    version,
    tipsEnabled: found.tips_enabled,
    tierPercents: parseStoreTipTiers(found.tier_percents),
    changedAt: parsePaymentInstant(String(found.occurred_at)),
  });
}

/**
 * The owner changes the tip choices: the next version, with who and when. `expectedVersion` is
 * the version they saw (another change in between is a conflict); the same operation again
 * returns the setting it made.
 */
export async function changeStoreTipSetting(
  tx: TipSettingTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly tipsEnabled: boolean;
    readonly tierPercents: readonly number[];
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<StoreTipSetting> {
  const { brand, store } = await tipScope(tx, scope);
  const operation = parsePaymentReference(input.operationReference);
  const tiers = parseStoreTipTiers(input.tierPercents);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `StoreTipSetting:${brand}:${store}`,
  ]);
  const prior = settingRows(
    await tx.query(
      "SELECT tips_enabled,tier_percents FROM rms_payment.store_tip_setting WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (
      prior.tips_enabled !== input.tipsEnabled ||
      JSON.stringify(parseStoreTipTiers(prior.tier_percents)) !== JSON.stringify(tiers)
    )
      throw new StoreTipSettingConflictError();
    return loadStoreTipSetting(tx, scope);
  }
  const current = await loadStoreTipSetting(tx, scope);
  if (current.version !== input.expectedVersion) throw new StoreTipSettingConflictError();
  if (
    current.tipsEnabled === input.tipsEnabled &&
    JSON.stringify(current.tierPercents) === JSON.stringify(tiers)
  )
    return current;
  await tx.query(
    "INSERT INTO rms_payment.store_tip_setting (tenant_id,brand_id,store_id,version,operation_id,tips_enabled,tier_percents,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7::integer[],$8,$9)",
    [
      parsePaymentReference(scope.tenantReference),
      brand,
      store,
      current.version + 1,
      operation,
      input.tipsEnabled,
      [...tiers],
      parsePaymentReference(input.actorReference),
      parsePaymentInstant(input.observedAt),
    ],
  );
  return loadStoreTipSetting(tx, scope);
}
