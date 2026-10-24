import { parseCanonicalInstant } from "../../domain/brand-store.js";
import {
  SoleOperatorApprovalError,
  evaluateSoleOperatorApproval,
  parseSoleOperatorPermissionCode,
  parseSoleOperatorReference,
  parseSoleOperatorSettingReason,
  type SoleOperatorApprovalStatus,
  type SoleOperatorSettingReason,
  type SoleOperatorSettingState,
} from "../../contracts/sole-operator-approval.js";

/** WP-2423 Q19: Organization owner of the Brand sole-operator setting (append-only records). */
export interface SoleOperatorSettingTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (code: SoleOperatorApprovalError["code"]): never => {
  throw new SoleOperatorApprovalError(code);
};
function resultRows(value: unknown, maximum: number): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail("SOLE_OPERATOR_UNAVAILABLE");
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > maximum)
    return fail("SOLE_OPERATOR_UNAVAILABLE");
  return d.value as readonly Record<string, unknown>[];
}
function rowCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const d = Object.getOwnPropertyDescriptor(value, "rowCount");
  return d && "value" in d && typeof d.value === "number" ? d.value : null;
}
const instant = (value: unknown): string =>
  parseCanonicalInstant(value instanceof Date ? value.toISOString() : value);
const recencyMilliseconds = 15 * 60 * 1000;
interface BrandQuery {
  readonly tenantReference: string;
  readonly brandReference: string;
}
export interface SoleOperatorSettingRecord {
  readonly settingReference: string;
  readonly version: number;
  readonly state: SoleOperatorSettingState;
  readonly reasonCode: SoleOperatorSettingReason;
  readonly actorReference: string;
  readonly recordedAt: string;
}
const selectColumns =
  "setting_id::text AS setting,tenant_id::text AS tenant,version::text AS version,state,reason_code,actor_id::text AS actor,actor_mfa_at,recorded_at,operation_id::text AS operation,audit_id::text AS audit";
function parseRecord(row: Record<string, unknown>, query: BrandQuery): SoleOperatorSettingRecord {
  const state = row.state === "On" || row.state === "Off" ? row.state : null;
  const version = typeof row.version === "string" ? Number(row.version) : NaN;
  if (
    state === null ||
    row.tenant !== query.tenantReference ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return fail("SOLE_OPERATOR_UNAVAILABLE");
  return Object.freeze({
    settingReference: parseSoleOperatorReference(row.setting),
    version,
    state,
    reasonCode: parseSoleOperatorSettingReason(state, row.reason_code),
    actorReference: parseSoleOperatorReference(row.actor),
    recordedAt: instant(row.recorded_at),
  });
}
async function scopeBrand(tx: SoleOperatorSettingTransaction, brandReference: string) {
  // Brand-scoped records: only the Brand GUC is set; the caller's Store selection is untouched.
  await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brandReference]);
}
function parseBrandQuery(value: BrandQuery & { readonly observedAt: string }) {
  return Object.freeze({
    tenantReference: parseSoleOperatorReference(value.tenantReference),
    brandReference: parseSoleOperatorReference(value.brandReference),
    observedAt: instant(value.observedAt),
  });
}

/**
 * Current setting and recent history as of an instant. Authorization is the caller's: the
 * authorize port must hold the reader's current Brand access through the read.
 */
export function createPostgresSoleOperatorSettingSource(options: {
  authorize(
    tx: SoleOperatorSettingTransaction,
    query: BrandQuery & { readonly observedAt: string },
  ): Promise<boolean>;
}) {
  return async (
    tx: SoleOperatorSettingTransaction,
    value: BrandQuery & { readonly observedAt: string; readonly historyLimit?: number },
  ) => {
    const query = parseBrandQuery(value);
    const limit = value.historyLimit ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      return fail("SOLE_OPERATOR_INPUT_INVALID");
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) fail("SOLE_OPERATOR_DENIED");
    };
    await authorize();
    await scopeBrand(tx, query.brandReference);
    const rows = resultRows(
      await tx.query(
        "SELECT " +
          selectColumns +
          " FROM bop_tenant.brand_sole_operator_setting WHERE brand_id=$1 AND recorded_at<=$2 ORDER BY brand_sole_operator_setting.version DESC LIMIT $3",
        [query.brandReference, query.observedAt, limit],
      ),
      limit,
    );
    const history = Object.freeze(rows.map((row) => parseRecord(row, query)));
    for (let i = 1; i < history.length; i++)
      if (history[i]?.version !== (history[i - 1]?.version ?? 0) - 1)
        fail("SOLE_OPERATOR_UNAVAILABLE");
    await authorize();
    const latest = history[0] ?? null;
    return Object.freeze({
      state: latest?.state ?? null,
      version: latest?.version ?? 0,
      latest,
      history,
    });
  };
}

export interface SoleOperatorApprovalQuery {
  readonly tenantReference: string;
  readonly brandReference: string;
  /** The Store whose gate is being approved; null for a Brand-level gate. */
  readonly storeReference: string | null;
  readonly permissionCode: string;
  readonly actorReference: string;
  readonly observedAt: string;
}

/**
 * Public read `soleOperatorApproval(scope, permissionCode, actorReference, at)`: Effective, NotSet
 * or OtherApprovers. Run it inside the approving transaction, at the approval instant. The holder
 * port must return every current active person holding the permission at that scope, read from
 * the Membership and Permission owners; an unreadable holder must be returned as a holder (fail
 * closed: the two-person rule applies).
 */
export function createSoleOperatorApprovalSource(options: {
  setting: ReturnType<typeof createPostgresSoleOperatorSettingSource>;
  holders(
    tx: SoleOperatorSettingTransaction,
    query: Omit<SoleOperatorApprovalQuery, "actorReference">,
  ): Promise<readonly string[]>;
}) {
  return async (
    tx: SoleOperatorSettingTransaction,
    value: SoleOperatorApprovalQuery,
  ): Promise<
    Readonly<{
      status: SoleOperatorApprovalStatus;
      otherHolderReferences: readonly string[];
      settingVersion: number;
    }>
  > => {
    const query = Object.freeze({
      tenantReference: parseSoleOperatorReference(value.tenantReference),
      brandReference: parseSoleOperatorReference(value.brandReference),
      storeReference:
        value.storeReference === null ? null : parseSoleOperatorReference(value.storeReference),
      permissionCode: parseSoleOperatorPermissionCode(value.permissionCode),
      actorReference: parseSoleOperatorReference(value.actorReference),
      observedAt: instant(value.observedAt),
    });
    const setting = await options.setting(tx, {
      tenantReference: query.tenantReference,
      brandReference: query.brandReference,
      observedAt: query.observedAt,
    });
    const holderReferences =
      setting.state === "On"
        ? await options.holders(tx, {
            tenantReference: query.tenantReference,
            brandReference: query.brandReference,
            storeReference: query.storeReference,
            permissionCode: query.permissionCode,
            observedAt: query.observedAt,
          })
        : [];
    const decision = evaluateSoleOperatorApproval({
      setting: setting.state,
      holderReferences,
      actorReference: query.actorReference,
    });
    return Object.freeze({ ...decision, settingVersion: setting.version });
  };
}

/** Audit record shape the store asks its caller's Audit port to append in the same transaction. */
export interface SoleOperatorSettingAudit {
  readonly auditId: string;
  readonly brandId: string;
  readonly actor: { readonly type: "User"; readonly reference: string };
  readonly actionCode: "ORGANIZATION_SOLE_OPERATOR_ENABLED" | "ORGANIZATION_SOLE_OPERATOR_DISABLED";
  readonly targetType: "BrandSoleOperatorSetting";
  readonly targetId: string;
  readonly beforeSummary: { readonly state: SoleOperatorSettingState | "NotSet" };
  readonly afterSummary: { readonly state: SoleOperatorSettingState; readonly version: number };
  readonly reasonCode: SoleOperatorSettingReason;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly sourceChannel: "MERCHANT_WEB";
  readonly dataClassification: "Internal";
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}

/**
 * Brand Owner command: turn sole operator On or Off with a reason, under a second-factor
 * verification at most 15 minutes old, at the expected version. Append-only and atomic with its
 * Audit; exact replay of the same operation returns the committed record. The authorize port must
 * re-check the actor's current Brand Owner permission (before and after the write).
 */
export function createPostgresSoleOperatorSettingStore(options: {
  authorize(
    tx: SoleOperatorSettingTransaction,
    query: BrandQuery & { readonly actorReference: string },
  ): Promise<boolean>;
  appendAudit(tx: SoleOperatorSettingTransaction, record: SoleOperatorSettingAudit): Promise<void>;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  return async (
    tx: SoleOperatorSettingTransaction,
    value: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly settingReference: string;
      readonly operationReference: string;
      readonly auditReference: string;
      readonly state: SoleOperatorSettingState;
      readonly reasonCode: string;
      readonly expectedVersion: number;
      /** The actor's latest second-factor verification (Identity owner read), or null. */
      readonly actorMfaAt: string | null;
    },
  ) => {
    if (value.state !== "On" && value.state !== "Off") return fail("SOLE_OPERATOR_INPUT_INVALID");
    const input = Object.freeze({
      tenantReference: parseSoleOperatorReference(value.tenantReference),
      brandReference: parseSoleOperatorReference(value.brandReference),
      actorReference: parseSoleOperatorReference(value.actorReference),
      settingReference: parseSoleOperatorReference(value.settingReference),
      operationReference: parseSoleOperatorReference(value.operationReference),
      auditReference: parseSoleOperatorReference(value.auditReference),
      state: value.state,
      reasonCode: parseSoleOperatorSettingReason(value.state, value.reasonCode),
      expectedVersion: value.expectedVersion,
      actorMfaAt: value.actorMfaAt === null ? null : instant(value.actorMfaAt),
    });
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
      return fail("SOLE_OPERATOR_INPUT_INVALID");
    const authorize = async () => {
      if (
        (await options.authorize(tx, {
          tenantReference: input.tenantReference,
          brandReference: input.brandReference,
          actorReference: input.actorReference,
        })) !== true
      )
        fail("SOLE_OPERATOR_DENIED");
    };
    await authorize();
    await scopeBrand(tx, input.brandReference);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "BrandSoleOperatorSetting:" + input.brandReference,
    ]);
    const clock = resultRows(
      await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []),
      1,
    );
    const recordedAt = instant(clock[0]?.now);
    const query = { tenantReference: input.tenantReference, brandReference: input.brandReference };
    const prior = resultRows(
      await tx.query(
        "SELECT " +
          selectColumns +
          " FROM bop_tenant.brand_sole_operator_setting WHERE brand_id=$1 AND operation_id=$2",
        [input.brandReference, input.operationReference],
      ),
      1,
    );
    const replay = prior[0];
    if (replay !== undefined) {
      const record = parseRecord(replay, query);
      if (
        record.settingReference !== input.settingReference ||
        record.state !== input.state ||
        record.reasonCode !== input.reasonCode ||
        record.actorReference !== input.actorReference ||
        record.version !== input.expectedVersion + 1 ||
        replay.audit !== input.auditReference
      )
        return fail("SOLE_OPERATOR_CONFLICT");
      await authorize();
      return Object.freeze({ status: "AlreadyCommitted" as const, record });
    }
    const latestRows = resultRows(
      await tx.query(
        "SELECT " +
          selectColumns +
          " FROM bop_tenant.brand_sole_operator_setting WHERE brand_id=$1 ORDER BY brand_sole_operator_setting.version DESC LIMIT 1",
        [input.brandReference],
      ),
      1,
    );
    const latest = latestRows[0] === undefined ? null : parseRecord(latestRows[0], query);
    if ((latest?.version ?? 0) !== input.expectedVersion)
      return fail("SOLE_OPERATOR_VERSION_CONFLICT");
    if ((latest?.state ?? "Off") === input.state) return fail("SOLE_OPERATOR_NO_CHANGE");
    const age =
      input.actorMfaAt === null ? -1 : Date.parse(recordedAt) - Date.parse(input.actorMfaAt);
    if (input.actorMfaAt === null || age < 0 || age > recencyMilliseconds)
      return fail("SOLE_OPERATOR_NEEDS_REVERIFICATION");
    const version = input.expectedVersion + 1;
    await tx.query("SAVEPOINT brand_sole_operator_setting_append", []);
    try {
      const inserted = await tx.query(
        "INSERT INTO bop_tenant.brand_sole_operator_setting (tenant_id,brand_id,setting_id,version,state,reason_code,actor_id,actor_mfa_at,recorded_at,operation_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          input.tenantReference,
          input.brandReference,
          input.settingReference,
          version,
          input.state,
          input.reasonCode,
          input.actorReference,
          input.actorMfaAt,
          recordedAt,
          input.operationReference,
          input.auditReference,
        ],
      );
      if (rowCount(inserted) !== 1) fail("SOLE_OPERATOR_CONFLICT");
      await options.appendAudit(
        tx,
        Object.freeze({
          auditId: input.auditReference,
          brandId: input.brandReference,
          actor: Object.freeze({ type: "User" as const, reference: input.actorReference }),
          actionCode:
            input.state === "On"
              ? ("ORGANIZATION_SOLE_OPERATOR_ENABLED" as const)
              : ("ORGANIZATION_SOLE_OPERATOR_DISABLED" as const),
          targetType: "BrandSoleOperatorSetting" as const,
          targetId: input.settingReference,
          beforeSummary: Object.freeze({ state: latest?.state ?? ("NotSet" as const) }),
          afterSummary: Object.freeze({ state: input.state, version }),
          reasonCode: input.reasonCode,
          correlationId: input.operationReference,
          occurredAt: recordedAt,
          sourceChannel: "MERCHANT_WEB" as const,
          dataClassification: "Internal" as const,
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        }),
      );
      await authorize();
      await tx.query("RELEASE SAVEPOINT brand_sole_operator_setting_append", []);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT brand_sole_operator_setting_append", []);
      await tx.query("RELEASE SAVEPOINT brand_sole_operator_setting_append", []);
      throw error;
    }
    return Object.freeze({
      status: "Created" as const,
      record: Object.freeze({
        settingReference: input.settingReference,
        version,
        state: input.state,
        reasonCode: input.reasonCode,
        actorReference: input.actorReference,
        recordedAt,
      }) satisfies SoleOperatorSettingRecord,
    });
  };
}
