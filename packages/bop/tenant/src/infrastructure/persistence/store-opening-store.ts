import { createHash } from "node:crypto";
import { parseBrandReference, parseStoreReference } from "../../domain/brand-store.js";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a: a Brand's Owner opens another Store.
 * In the caller's transaction (whose Owner, permission and membership the caller resolved): the
 * Store record (organisation Active; customers order only once its configuration and go-live check
 * are published), then the caller's `withinStore` work (the opener's Store assignment by Membership
 * and the audit record), then the append-only opening record, all under the new Store's scope; the
 * caller's Store scope is restored after.
 * The new Store's identity is the request's opening reference, so a retry finds its own result:
 * the same request answers AlreadyOpened, a different one Conflict. A code already used by another
 * Store of the Brand answers CodeTaken.
 */
export interface StoreOpeningTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}
export class StoreOpeningError extends Error {
  constructor(readonly code: "Invalid" | "CodeTaken" | "Conflict" | "Unavailable") {
    super("STORE_OPENING_" + code.toUpperCase());
  }
}
/** Canadian IANA time zones a Store may open in (the pilot's market). */
export const storeOpeningTimeZones = Object.freeze([
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Regina",
  "America/Halifax",
  "America/St_Johns",
  "America/Moncton",
  "America/Whitehorse",
]);
export const storeOpeningLocales = Object.freeze(["en-CA", "fr-CA"]);

export interface StoreOpeningRequest {
  readonly openingReference: string;
  readonly brandReference: string;
  readonly openedFromStoreReference: string;
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly storeAssignmentReference: string;
  readonly auditReference: string;
  readonly code: string;
  readonly displayName: string;
  readonly timeZone: string;
  readonly locale: string;
  readonly openedAt: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : invalid();
const invalid = (): never => {
  throw new StoreOpeningError("Invalid");
};

/** The request a person made, as recorded (whitespace normalized, code upper case). */
export function parseStoreOpeningRequest(input: StoreOpeningRequest): StoreOpeningRequest {
  const displayName =
    typeof input.displayName === "string" ? input.displayName.replace(/\s+/gu, " ").trim() : "";
  const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
  if (
    displayName.length < 1 ||
    displayName.length > 160 ||
    /[\p{Cc}\p{Cf}]/u.test(displayName) ||
    !/^[A-Z][A-Z0-9_-]{0,62}$/u.test(code) ||
    !storeOpeningTimeZones.includes(input.timeZone) ||
    !storeOpeningLocales.includes(input.locale) ||
    typeof input.openedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.openedAt)
  )
    return invalid();
  const parsed = {
    openingReference: reference(input.openingReference),
    brandReference: String(parseBrandReference(input.brandReference)),
    openedFromStoreReference: String(parseStoreReference(input.openedFromStoreReference)),
    actorReference: reference(input.actorReference),
    membershipReference: reference(input.membershipReference),
    storeAssignmentReference: reference(input.storeAssignmentReference),
    auditReference: reference(input.auditReference),
    code,
    displayName,
    timeZone: input.timeZone,
    locale: input.locale,
    openedAt: input.openedAt,
  };
  if (parsed.openingReference === parsed.openedFromStoreReference) return invalid();
  return Object.freeze(parsed);
}
/** What identifies a request (not when it ran, nor the references the server allocated). */
export function storeOpeningIntentDigest(request: StoreOpeningRequest): string {
  const intent = [
    request.brandReference,
    request.openedFromStoreReference,
    request.actorReference,
    request.code,
    request.displayName,
    request.timeZone,
    request.locale,
  ];
  return "sha256:" + createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export async function openStore(
  tx: StoreOpeningTransaction,
  input: StoreOpeningRequest,
  withinStore: (tx: StoreOpeningTransaction, request: StoreOpeningRequest) => Promise<void>,
): Promise<{ readonly status: "Opened" | "AlreadyOpened"; readonly storeReference: string }> {
  const request = parseStoreOpeningRequest(input);
  const digest = storeOpeningIntentDigest(request);
  const store = request.openingReference;
  const scope = (brand: string, storeId: string) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      storeId,
    ]);
  await scope(request.brandReference, store);
  // On failure the caller's transaction rolls back; the caller's Store scope is restored on success.
  const done = async <T>(value: T) => {
    await scope(request.brandReference, request.openedFromStoreReference);
    return value;
  };
  {
    const [prior] = (
      await tx.query(
        "SELECT intent_digest FROM bop_tenant.store_opening WHERE brand_id=$1 AND opening_id=$2",
        [request.brandReference, store],
      )
    ).rows;
    if (prior !== undefined) {
      if (prior.intent_digest !== digest) throw new StoreOpeningError("Conflict");
      return done(Object.freeze({ status: "AlreadyOpened" as const, storeReference: store }));
    }
    try {
      await tx.query("SAVEPOINT store_opening_code", []);
      await tx.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'CAD','Active',1,$7,$7)",
        [
          store,
          request.brandReference,
          request.code,
          request.displayName,
          request.timeZone,
          request.locale,
          request.openedAt,
        ],
      );
      await tx.query("RELEASE SAVEPOINT store_opening_code", []);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT store_opening_code", []);
      if ((error as { constraint?: unknown }).constraint === "store_brand_code_unique")
        throw new StoreOpeningError("CodeTaken");
      throw error;
    }
    // The opener's Store assignment (Membership's own command) and the audit record, in the new
    // Store's scope, before the opening record that names them.
    await withinStore(tx, request);
    await tx.query(
      "INSERT INTO bop_tenant.store_opening (opening_id,brand_id,store_id,opened_from_store_id,actor_id,membership_id,store_assignment_id,code,display_name,time_zone,locale,intent_digest,audit_id,opened_at) VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        store,
        request.brandReference,
        request.openedFromStoreReference,
        request.actorReference,
        request.membershipReference,
        request.storeAssignmentReference,
        request.code,
        request.displayName,
        request.timeZone,
        request.locale,
        digest,
        request.auditReference,
        request.openedAt,
      ],
    );
    return done(Object.freeze({ status: "Opened" as const, storeReference: store }));
  }
}
