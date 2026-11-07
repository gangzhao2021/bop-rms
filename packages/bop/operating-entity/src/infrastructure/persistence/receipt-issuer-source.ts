import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
  parseStoreReference,
} from "@bop/tenant";
import {
  parseAssignmentReference,
  parseOperatingEntityReference,
} from "../../domain/operating-entity.js";

export interface ReceiptIssuerTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface ReceiptIssuerScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly businessFunction: "SalesReceiptIssuer";
  readonly effectiveAt: string;
}
export interface ReceiptIssuerSource extends ReceiptIssuerScope {
  readonly assignmentReference: string;
  readonly assignmentVersion: number;
  readonly operatingEntityReference: string;
  readonly entityVersion: number;
  readonly legalName: string;
}
export class ReceiptIssuerSourceError extends Error {
  constructor(
    readonly code:
      | "RECEIPT_ISSUER_INPUT_INVALID"
      | "RECEIPT_ISSUER_PERMISSION_DENIED"
      | "RECEIPT_ISSUER_UNAVAILABLE",
  ) {
    super(code);
    this.name = "ReceiptIssuerSourceError";
  }
}
const unavailable = (): never => {
  throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_UNAVAILABLE");
};

/** Owner facts for new receipt issuance. Retain this transaction's locks until receipt commit. */
export function createPostgresReceiptIssuerSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(transaction: ReceiptIssuerTransaction, scope: ReceiptIssuerScope): Promise<boolean>;
}) {
  const brandReference = String(parseBrandReference(options.brandReference));
  const storeReference = String(parseStoreReference(options.storeReference));
  return Object.freeze({
    async resolve(input: {
      transaction: ReceiptIssuerTransaction;
      effectiveAt: string;
    }): Promise<ReceiptIssuerSource | null> {
      let effectiveAt: string;
      try {
        effectiveAt = String(parseCanonicalInstant(input.effectiveAt));
      } catch {
        throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_INPUT_INVALID");
      }
      const scope = Object.freeze({
        brandReference,
        storeReference,
        businessFunction: "SalesReceiptIssuer" as const,
        effectiveAt,
      });
      const tx = input.transaction;
      const authorize = async () => {
        if ((await options.authorize(tx, scope)) !== true)
          throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_PERMISSION_DENIED");
      };
      try {
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        const result = await tx.query(
          'SELECT a.assignment_id AS "assignmentReference",a.version AS "assignmentVersion",' +
            'a.brand_id AS "brandReference",a.store_id AS "storeReference",' +
            'e.operating_entity_id AS "operatingEntityReference",e.version AS "entityVersion",e.legal_name AS "legalName" ' +
            "FROM bop_operating_entity.store_operating_entity_assignment a " +
            "JOIN bop_operating_entity.operating_entity e ON e.operating_entity_id=a.operating_entity_id " +
            "WHERE a.brand_id=$1 AND a.store_id=$2 AND a.business_function='SalesReceiptIssuer' " +
            "AND a.lifecycle='Active' AND a.effective_from<=$3::timestamptz " +
            "AND (a.effective_until IS NULL OR a.effective_until>$3::timestamptz) " +
            "AND a.updated_at<=$3::timestamptz AND e.updated_at<=$3::timestamptz " +
            "AND e.lifecycle='Active' AND e.evidence_reference IS NOT NULL " +
            "ORDER BY a.assignment_id LIMIT 2 FOR SHARE OF a,e",
          [brandReference, storeReference, effectiveAt],
        );
        await authorize();
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return unavailable();
        const row = result.rows[0];
        if (
          !row ||
          row.brandReference !== brandReference ||
          row.storeReference !== storeReference ||
          typeof row.legalName !== "string" ||
          row.legalName.length === 0 ||
          row.legalName.length > 200 ||
          row.legalName.trim() !== row.legalName
        )
          return unavailable();
        return Object.freeze({
          ...scope,
          assignmentReference: String(parseAssignmentReference(row.assignmentReference)),
          assignmentVersion: Number(parseOrganizationVersion(row.assignmentVersion)),
          operatingEntityReference: String(
            parseOperatingEntityReference(row.operatingEntityReference),
          ),
          entityVersion: Number(parseOrganizationVersion(row.entityVersion)),
          legalName: row.legalName,
        });
      } catch (error) {
        if (error instanceof ReceiptIssuerSourceError) throw error;
        return unavailable();
      }
    },
  });
}

/**
 * v15 2026-11-01 (coordinator): the business a Store's receipts name, recorded when the Store's
 * Owner saves "Receipts and privacy" (Store setup). A Store's receipt issuer is its own explicit
 * Store Assignment (WP-0101 §17: a Brand's issuer is never an implicit Store fallback). The same
 * name changes nothing; a new name ends the current Store Assignment at `recordedAt` and starts one
 * to a new Active Operating Entity of that name, whose evidence is the Owner's recorded save
 * (`evidenceReference`, its audit). Receipts already issued keep the issuer they were issued with.
 * The schema admits Ontario entities only (`CA-ON`); the caller's transaction and audit append.
 */
export function createPostgresStoreReceiptIssuerRecorder(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(transaction: ReceiptIssuerTransaction, scope: ReceiptIssuerScope): Promise<boolean>;
}) {
  const brandReference = String(parseBrandReference(options.brandReference));
  const storeReference = String(parseStoreReference(options.storeReference));
  return async (input: {
    readonly transaction: ReceiptIssuerTransaction;
    readonly legalName: string;
    readonly evidenceReference: string;
    readonly recordedAt: string;
    readonly references: { readonly entity: string; readonly assignment: string };
  }): Promise<{ readonly status: "Unchanged" | "Recorded"; readonly legalName: string }> => {
    let recordedAt: string, legalName: string, references: string[];
    try {
      recordedAt = String(parseCanonicalInstant(input.recordedAt));
      legalName = parseReceiptIssuerName(input.legalName);
      references = [
        input.evidenceReference,
        input.references.entity,
        input.references.assignment,
      ].map((value) => String(parseAssignmentReference(value)));
    } catch {
      throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_INPUT_INVALID");
    }
    const [evidenceReference, entityReference, assignmentReference] = references as [
      string,
      string,
      string,
    ];
    const scope = Object.freeze({
      brandReference,
      storeReference,
      businessFunction: "SalesReceiptIssuer" as const,
      effectiveAt: recordedAt,
    });
    const tx = input.transaction;
    const authorize = async () => {
      if ((await options.authorize(tx, scope)) !== true)
        throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_PERMISSION_DENIED");
    };
    try {
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StoreReceiptIssuer:" + brandReference + ":" + storeReference,
      ]);
      const current = await tx.query(
        'SELECT a.assignment_id AS "assignmentReference",e.legal_name AS "legalName" ' +
          "FROM bop_operating_entity.store_operating_entity_assignment a " +
          "JOIN bop_operating_entity.operating_entity e ON e.operating_entity_id=a.operating_entity_id " +
          "WHERE a.brand_id=$1 AND a.store_id=$2 AND a.business_function='SalesReceiptIssuer' " +
          "AND a.lifecycle='Active' AND a.effective_from<=$3::timestamptz " +
          "AND (a.effective_until IS NULL OR a.effective_until>$3::timestamptz) " +
          "ORDER BY a.assignment_id LIMIT 2 FOR UPDATE OF a",
        [brandReference, storeReference, recordedAt],
      );
      if (current.rows.length > 1) return unavailable();
      const row = current.rows[0];
      if (row !== undefined && row.legalName === legalName) {
        await authorize();
        return Object.freeze({ status: "Unchanged" as const, legalName });
      }
      if (row !== undefined) {
        const ended = await tx.query(
          "UPDATE bop_operating_entity.store_operating_entity_assignment " +
            "SET effective_until=$2::timestamptz,updated_at=$2::timestamptz,version=version+1 " +
            "WHERE assignment_id=$1 AND effective_from<$2::timestamptz RETURNING assignment_id",
          [row.assignmentReference, recordedAt],
        );
        if (ended.rows.length !== 1) return unavailable();
      }
      // The Assignment first: the Operating Entity's row policy admits it through that Assignment
      // (the foreign key is checked at commit).
      await tx.query(
        "INSERT INTO bop_operating_entity.store_operating_entity_assignment " +
          "(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle," +
          "effective_from,effective_until,version,created_at,updated_at) " +
          "VALUES ($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5::timestamptz,NULL,1,$5::timestamptz,$5::timestamptz)",
        [assignmentReference, brandReference, storeReference, entityReference, recordedAt],
      );
      await tx.query(
        "INSERT INTO bop_operating_entity.operating_entity " +
          "(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,evidence_reference," +
          "lifecycle,version,created_at,updated_at) " +
          "VALUES ($1,'LegalEntity',$2,NULL,'CA-ON',$3,'Active',1,$4::timestamptz,$4::timestamptz)",
        [entityReference, legalName, evidenceReference, recordedAt],
      );
      await authorize();
      return Object.freeze({ status: "Recorded" as const, legalName });
    } catch (error) {
      if (error instanceof ReceiptIssuerSourceError) throw error;
      return unavailable();
    }
  };
}

/** The business name a receipt prints: 1–200 characters, trimmed, no control characters. */
export function parseReceiptIssuerName(value: unknown): string {
  if (typeof value !== "string") throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_INPUT_INVALID");
  const name = value.trim().replace(/\s+/gu, " ");
  if (
    name.length < 1 ||
    name.length > 200 ||
    Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new ReceiptIssuerSourceError("RECEIPT_ISSUER_INPUT_INVALID");
  return name;
}
