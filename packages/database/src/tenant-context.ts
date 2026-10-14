import type { Pool, PoolClient } from "pg";

export const tenantContextDatabaseErrorCodes = [
  "TENANT_DATABASE_SCOPE_INVALID",
  "TENANT_DATABASE_ACQUIRE_FAILED",
  "TENANT_DATABASE_TRANSACTION_FAILED",
  "TENANT_DATABASE_TRANSACTION_CONFLICT",
] as const;
export type TenantContextDatabaseErrorCode = (typeof tenantContextDatabaseErrorCodes)[number];

const safeMessages: Readonly<Record<TenantContextDatabaseErrorCode, string>> = {
  TENANT_DATABASE_SCOPE_INVALID: "tenant database scope is invalid",
  TENANT_DATABASE_ACQUIRE_FAILED: "tenant database connection is unavailable",
  TENANT_DATABASE_TRANSACTION_FAILED: "tenant database transaction failed",
  TENANT_DATABASE_TRANSACTION_CONFLICT: "tenant database transaction conflicted; it may be retried",
};

/**
 * Safe diagnostic identifiers of the underlying failure (never SQL, values or messages): the
 * PostgreSQL SQLSTATE, the violated constraint and the table, each only when it is a plain
 * identifier; `closed` when a query arrived after its transaction had ended.
 */
export interface TenantContextDatabaseDiagnostic {
  readonly sqlState: string | null;
  readonly constraint: string | null;
  readonly table: string | null;
  readonly closed: boolean;
}
const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
const state = /^[0-9A-Z]{5}$/u;
function own(error: unknown, key: string): unknown {
  return error !== null && typeof error === "object"
    ? Object.getOwnPropertyDescriptor(error, key)?.value
    : undefined;
}
/** Extract only safe identifiers from a driver error. */
export function tenantContextDatabaseDiagnostic(
  error: unknown,
  closed = false,
): TenantContextDatabaseDiagnostic {
  const pick = (key: string, pattern: RegExp) => {
    const value = own(error, key);
    return typeof value === "string" && pattern.test(value) ? value : null;
  };
  return Object.freeze({
    sqlState: pick("code", state),
    constraint: pick("constraint", identifier),
    table: pick("table", identifier),
    closed,
  });
}

export class TenantContextDatabaseError extends Error {
  readonly code: TenantContextDatabaseErrorCode;
  readonly diagnostic: TenantContextDatabaseDiagnostic | null;

  constructor(
    code: TenantContextDatabaseErrorCode,
    diagnostic: TenantContextDatabaseDiagnostic | null = null,
  ) {
    super(safeMessages[code]);
    this.name = "TenantContextDatabaseError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export interface TenantDatabaseScope {
  readonly brandId: string;
  readonly storeId?: string | null;
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function readScope(input: unknown): Readonly<{ brandId: string; storeId: string }> {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      throw new Error();
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.some((key) => typeof key !== "string" || (key !== "brandId" && key !== "storeId")) ||
      !ownKeys.includes("brandId") ||
      ownKeys.length > 2
    )
      throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const brandDescriptor = descriptors.brandId;
    const storeDescriptor = descriptors.storeId;
    if (
      !brandDescriptor ||
      !("value" in brandDescriptor) ||
      !brandDescriptor.enumerable ||
      (storeDescriptor !== undefined &&
        (!("value" in storeDescriptor) || !storeDescriptor.enumerable))
    )
      throw new Error();
    const brandId = brandDescriptor.value;
    const storeId = storeDescriptor === undefined ? null : storeDescriptor.value;
    if (
      typeof brandId !== "string" ||
      !uuidV7Pattern.test(brandId) ||
      (storeId !== null && (typeof storeId !== "string" || !uuidV7Pattern.test(storeId)))
    )
      throw new Error();
    return Object.freeze({ brandId, storeId: storeId ?? "" });
  } catch {
    throw new TenantContextDatabaseError("TENANT_DATABASE_SCOPE_INVALID");
  }
}

export async function withTenantContextTransaction<T>(
  pool: Pick<Pool, "connect">,
  scopeInput: TenantDatabaseScope,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const scope = readScope(scopeInput);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new TenantContextDatabaseError("TENANT_DATABASE_ACQUIRE_FAILED");
  }

  let began = false;
  let callbackActive = false;
  let result: T | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [scope.brandId]);
    await client.query("SELECT set_config('bop.store_id', $1, true)", [scope.storeId]);
    callbackActive = true;
    result = await callback(client);
    callbackActive = false;
    await client.query("COMMIT");
    began = false;
  } catch (error) {
    failed = true;
    primaryError = callbackActive
      ? error
      : new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
    if (began) await client.query("ROLLBACK").catch(() => undefined);
  }

  try {
    client.release(failed);
  } catch {
    failed = true;
    primaryError ??= new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
  }
  if (failed) throw primaryError;
  return result as T;
}
