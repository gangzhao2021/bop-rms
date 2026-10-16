import { parseDiningInstant, parseDiningReference } from "../../contracts/dining-session.js";
import { parseQrSignedPayload, type QrSignedPayload } from "../../contracts/qr-table-context.js";

/**
 * WP-2423 Q11 (DEC-TABLE-QR-ISSUANCE): the table QR codes a Store prints. One row per IssueQr table
 * operation; the signed code is kept exactly as printed (it is public and carries no secret) so a
 * damaged sticker can be reprinted unchanged. A table keeps one public table reference across
 * replacements. Callers own the transaction and current Staff or Guest authority.
 */
export const diningTableQrLifetimeDays = 180;
const lifetimeMilliseconds = diningTableQrLifetimeDays * 24 * 60 * 60 * 1000;

export interface DiningTableQrIssue {
  readonly qrReference: string;
  readonly tableReference: string;
  readonly publicStoreReference: string;
  readonly publicTableReference: string;
  readonly qrVersion: number;
  readonly operationReference: string;
  readonly keyId: string;
  readonly qrToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface DiningTableQrTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DiningTableQrScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}

const fail = (): never => {
  throw new Error("DINING_TABLE_QR_UNAVAILABLE");
};
const keyIdPattern = /^[A-Za-z0-9._-]{1,64}$/u;
const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/u;

/** The signed payload of a table code: DineIn, versioned by the table's QR version, 180 days. */
export function createDiningTableQrPayload(input: {
  readonly qrReference: string;
  readonly publicStoreReference: string;
  readonly publicTableReference: string;
  readonly qrVersion: number;
  readonly locale: string;
  readonly issuedAt: string;
}): QrSignedPayload {
  const issuedAt = parseDiningInstant(input.issuedAt);
  if (!Number.isSafeInteger(input.qrVersion) || input.qrVersion < 1) return fail();
  return parseQrSignedPayload(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        qrReference: String(parseDiningReference(input.qrReference)),
        publicStoreReference: String(parseDiningReference(input.publicStoreReference)),
        publicTableReference: String(parseDiningReference(input.publicTableReference)),
        channel: "DineIn",
        locale: input.locale,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + lifetimeMilliseconds).toISOString(),
        revocationVersion: input.qrVersion,
      }),
    ).toString("base64url"),
  );
}

/** The payload a stored code carries; the code must be exactly the row's signed payload. */
export function readDiningTableQrPayload(issue: DiningTableQrIssue): QrSignedPayload {
  const payload = parseQrSignedPayload(issue.qrToken.split(".")[1] ?? "");
  if (
    payload.qrReference !== issue.qrReference ||
    payload.publicStoreReference !== issue.publicStoreReference ||
    payload.publicTableReference !== issue.publicTableReference ||
    payload.channel !== "DineIn" ||
    payload.revocationVersion !== issue.qrVersion ||
    payload.issuedAt !== issue.issuedAt ||
    payload.expiresAt !== issue.expiresAt
  )
    return fail();
  return payload;
}

const columns =
  "qr_id::text AS qr_id,table_id::text AS table_id,public_store_id::text AS public_store_id," +
  "public_table_id::text AS public_table_id,qr_version::text AS qr_version,operation_id::text AS operation_id," +
  "key_id,qr_token,to_char(issued_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS issued_at," +
  "to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires_at";

function issueFrom(row: unknown): DiningTableQrIssue {
  if (row === null || typeof row !== "object") return fail();
  const value = row as Record<string, unknown>;
  const version = Number(value.qr_version);
  if (
    typeof value.key_id !== "string" ||
    !keyIdPattern.test(value.key_id) ||
    typeof value.qr_token !== "string" ||
    !tokenPattern.test(value.qr_token) ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return fail();
  const issue = Object.freeze({
    qrReference: String(parseDiningReference(value.qr_id)),
    tableReference: String(parseDiningReference(value.table_id)),
    publicStoreReference: String(parseDiningReference(value.public_store_id)),
    publicTableReference: String(parseDiningReference(value.public_table_id)),
    qrVersion: version,
    operationReference: String(parseDiningReference(value.operation_id)),
    keyId: value.key_id,
    qrToken: value.qr_token,
    issuedAt: parseDiningInstant(value.issued_at),
    expiresAt: parseDiningInstant(value.expires_at),
  });
  readDiningTableQrPayload(issue);
  return issue;
}

function rowsOf(result: unknown, maximum: number): readonly unknown[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length > maximum) return fail();
  return rows;
}

export function createPostgresDiningTableQrStore(
  transaction: DiningTableQrTransaction,
  scopeInput: DiningTableQrScope,
) {
  const tenant = String(parseDiningReference(scopeInput.tenantReference));
  const brand = String(parseDiningReference(scopeInput.brandReference));
  const store = String(parseDiningReference(scopeInput.storeReference));
  const context = () =>
    transaction.query(
      "SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)",
      [brand, store],
    );
  const one = async (where: string, values: readonly unknown[]) => {
    await context();
    const rows = rowsOf(
      await transaction.query(
        "SELECT " +
          columns +
          " FROM rms_dining.dining_table_qr_issue WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND " +
          where,
        [tenant, brand, store, ...values],
      ),
      1,
    );
    return rows.length === 0 ? null : issueFrom(rows[0]);
  };
  return Object.freeze({
    /** Writes the issue row in the caller's IssueQr transaction (after the table operation). */
    async recordIssue(issue: DiningTableQrIssue) {
      const parsed = issueFrom({
        qr_id: issue.qrReference,
        table_id: issue.tableReference,
        public_store_id: issue.publicStoreReference,
        public_table_id: issue.publicTableReference,
        qr_version: String(issue.qrVersion),
        operation_id: issue.operationReference,
        key_id: issue.keyId,
        qr_token: issue.qrToken,
        issued_at: issue.issuedAt,
        expires_at: issue.expiresAt,
      });
      await context();
      const result = await transaction.query(
        "INSERT INTO rms_dining.dining_table_qr_issue (tenant_id,brand_id,store_id,table_id,qr_id,public_store_id,public_table_id,qr_version,operation_id,key_id,qr_token,issued_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          tenant,
          brand,
          store,
          parsed.tableReference,
          parsed.qrReference,
          parsed.publicStoreReference,
          parsed.publicTableReference,
          parsed.qrVersion,
          parsed.operationReference,
          parsed.keyId,
          parsed.qrToken,
          parsed.issuedAt,
          parsed.expiresAt,
        ],
      );
      if ((result as { rowCount?: unknown } | null)?.rowCount !== 1) fail();
      return parsed;
    },
    loadByOperation: (operationReference: string) =>
      one("operation_id=$4", [String(parseDiningReference(operationReference))]),
    /** Any issued code of the Store, current or not (to recognise a replaced code). */
    loadByQrReference: (qrReference: string) =>
      one("qr_id=$4", [String(parseDiningReference(qrReference))]),
    /** The newest code issued for a public table reference. */
    loadLatestByPublicTable: (publicTableReference: string) =>
      one("public_table_id=$4 ORDER BY dining_table_qr_issue.qr_version DESC LIMIT 1", [
        String(parseDiningReference(publicTableReference)),
      ]),
    /** The newest code of a table (its public reference is reused on replacement). */
    loadLatestForTable: (tableReference: string) =>
      one("table_id=$4 ORDER BY dining_table_qr_issue.qr_version DESC LIMIT 1", [
        String(parseDiningReference(tableReference)),
      ]),
    /** The newest code of each listed table; tables never issued a code are absent. */
    async loadLatestForTables(tableReferences: readonly string[]) {
      if (tableReferences.length > 200) return fail();
      const tables = tableReferences.map((value) => String(parseDiningReference(value)));
      const latest = new Map<string, DiningTableQrIssue>();
      if (tables.length === 0) return latest;
      await context();
      const rows = rowsOf(
        await transaction.query(
          "SELECT DISTINCT ON (table_id) " +
            columns +
            " FROM rms_dining.dining_table_qr_issue WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=ANY($4::uuid[]) ORDER BY table_id, dining_table_qr_issue.qr_version DESC",
          [tenant, brand, store, tables],
        ),
        tables.length,
      );
      for (const row of rows) {
        const issue = issueFrom(row);
        if (!tables.includes(issue.tableReference) || latest.has(issue.tableReference)) fail();
        latest.set(issue.tableReference, issue);
      }
      return latest;
    },
  });
}
