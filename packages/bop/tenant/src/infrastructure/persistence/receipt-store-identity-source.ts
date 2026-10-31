import {
  createStore,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
} from "../../domain/brand-store.js";

export interface ReceiptStoreIdentityTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface ReceiptStoreIdentityScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly purpose: "ReceiptIssuance";
  readonly evaluatedAt: string;
}
export interface ReceiptStoreIdentity extends ReceiptStoreIdentityScope {
  readonly storeVersion: number;
  readonly storeDisplayName: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
}
export class ReceiptStoreIdentityError extends Error {
  constructor(
    readonly code:
      | "RECEIPT_STORE_INPUT_INVALID"
      | "RECEIPT_STORE_PERMISSION_DENIED"
      | "RECEIPT_STORE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "ReceiptStoreIdentityError";
  }
}
function unavailable(): never {
  throw new ReceiptStoreIdentityError("RECEIPT_STORE_UNAVAILABLE");
}

/** Canonical organizational identity, not localized entry content or a receipt template. */
export function createPostgresReceiptStoreIdentitySource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(
    transaction: ReceiptStoreIdentityTransaction,
    scope: ReceiptStoreIdentityScope,
  ): Promise<boolean>;
}) {
  const brandReference = String(parseBrandReference(options.brandReference));
  const storeReference = String(parseStoreReference(options.storeReference));
  return Object.freeze({
    async resolve(input: {
      transaction: ReceiptStoreIdentityTransaction;
      evaluatedAt: string;
    }): Promise<ReceiptStoreIdentity | null> {
      let evaluatedAt: string;
      try {
        evaluatedAt = String(parseCanonicalInstant(input.evaluatedAt));
      } catch {
        throw new ReceiptStoreIdentityError("RECEIPT_STORE_INPUT_INVALID");
      }
      const scope = Object.freeze({
        brandReference,
        storeReference,
        purpose: "ReceiptIssuance" as const,
        evaluatedAt,
      });
      const tx = input.transaction;
      const authorize = async () => {
        if ((await options.authorize(tx, scope)) !== true)
          throw new ReceiptStoreIdentityError("RECEIPT_STORE_PERMISSION_DENIED");
      };
      try {
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        const result = await tx.query(
          'SELECT store_id AS "storeReference",brand_id AS "brandReference",code,' +
            'display_name AS "displayName",time_zone AS "timeZone",locale,currency_code AS "currencyCode",lifecycle,version,' +
            'created_at AS "createdAt",updated_at AS "updatedAt" FROM bop_tenant.store ' +
            "WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Active' AND updated_at<=$3::timestamptz FOR SHARE",
          [brandReference, storeReference, evaluatedAt],
        );
        await authorize();
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return unavailable();
        const row = result.rows[0];
        if (!row) return unavailable();
        const instant = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
        const store = createStore({
          ...row,
          createdAt: instant(row.createdAt),
          updatedAt: instant(row.updatedAt),
        });
        if (
          store.brandReference !== brandReference ||
          store.storeReference !== storeReference ||
          store.lifecycle !== "Active" ||
          store.updatedAt > evaluatedAt
        )
          return unavailable();
        return Object.freeze({
          ...scope,
          storeVersion: store.version,
          storeDisplayName: store.displayName,
          defaultLocale: store.locale,
          currencyCode: store.currencyCode,
        });
      } catch (error) {
        if (error instanceof ReceiptStoreIdentityError) throw error;
        return unavailable();
      }
    },
  });
}
