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
