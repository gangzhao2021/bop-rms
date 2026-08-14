export type CustomerProfileClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class CustomerProfileClientError extends Error {
  constructor(readonly code: CustomerProfileClientErrorCode) {
    super("Customer Profile unavailable");
    this.name = "CustomerProfileClientError";
  }
}
export interface CustomerProfileView {
  readonly projectionName: "customer_profile_v1";
  readonly projectionVersion: 1;
  readonly screenId: "CRM-CUSTOMER-LIST" | "CRM-CUSTOMER-DETAIL";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewContacts: boolean;
    readonly mayViewTransactions: boolean;
    readonly mayViewLoyalty: boolean;
    readonly mayViewConsent: boolean;
    readonly mayViewCommunications: boolean;
    readonly mayViewPrivacyCases: boolean;
    readonly mayViewServiceNotes: boolean;
    readonly mayViewAudit: boolean;
    readonly mayManage: boolean;
  };
  readonly rows: readonly {
    readonly customerReference: string;
    readonly displayName: string;
    readonly maskedContact: string | null;
    readonly relationshipStatus: "Active" | "Restricted" | "Closed";
    readonly loyaltyStatus: string | null;
    readonly tierCode: string | null;
    readonly lastInteractionAt: string | null;
    readonly consentSummary: string | null;
    readonly openCase: boolean | null;
  }[];
  readonly detail: {
    readonly customerReference: string;
    readonly aggregateVersion: number;
    readonly displayName: string;
    readonly preferredLocale: string | null;
    readonly relationshipStatus: "Active" | "Restricted" | "Closed";
    readonly creationBasis:
      | "Registration"
      | "Login"
      | "LoyaltyEnrollment"
      | "ExplicitRetentionConsent"
      | "StaffBusinessNeed";
    readonly userLinked: boolean;
    readonly verifiedContacts:
      | readonly {
          readonly contactReference: string;
          readonly contactType: "Email" | "Phone";
          readonly maskedValue: string;
          readonly verifiedAt: string;
        }[]
      | null;
    readonly transactionReferences:
      | readonly {
          readonly transactionType: "Order" | "Reservation";
          readonly transactionReference: string;
          readonly linkedAt: string;
        }[]
      | null;
    readonly loyaltyAccounts: readonly string[] | null;
    readonly consentSummary: string | null;
    readonly communicationCount: number | null;
    readonly privacyCaseReferences: readonly string[] | null;
    readonly serviceNotes:
      | readonly {
          readonly noteReference: string;
          readonly categoryCode: string;
          readonly note: string;
          readonly occurredAt: string;
        }[]
      | null;
    readonly auditReference: string | null;
  } | null;
}
export interface CustomerProfileProjectionClient {
  load(screenId: CustomerProfileView["screenId"], customerReference?: string): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (): never => {
  throw new CustomerProfileClientError("Unavailable");
};
const object = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
};
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const text = (value: unknown, max = 200) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length <= max &&
  /^[^\p{Cc}\p{Cf}<>{}$]+$/u.test(value)
    ? value
    : fail();
const integer = (value: unknown, min = 0) =>
  Number.isSafeInteger(value) && (value as number) >= min ? (value as number) : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
export function parseCustomerProfileView(value: unknown): CustomerProfileView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
    "detail",
  ]);
  if (
    raw.projectionName !== "customer_profile_v1" ||
    raw.projectionVersion !== 1 ||
    !["CRM-CUSTOMER-LIST", "CRM-CUSTOMER-DETAIL"].includes(raw.screenId as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200
  )
    fail();
  const p = object(raw.permissions, [
    "mayViewContacts",
    "mayViewTransactions",
    "mayViewLoyalty",
    "mayViewConsent",
    "mayViewCommunications",
    "mayViewPrivacyCases",
    "mayViewServiceNotes",
    "mayViewAudit",
    "mayManage",
  ]);
  if (Object.values(p).some((entry) => typeof entry !== "boolean")) fail();
  const permissions = p as unknown as CustomerProfileView["permissions"];
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((entry) => {
      const row = object(entry, [
        "customerReference",
        "displayName",
        "maskedContact",
        "relationshipStatus",
        "loyaltyStatus",
        "tierCode",
        "lastInteractionAt",
        "consentSummary",
        "openCase",
      ]);
      if (
        (!permissions.mayViewContacts && row.maskedContact !== null) ||
        (!permissions.mayViewLoyalty && (row.loyaltyStatus !== null || row.tierCode !== null)) ||
        (!permissions.mayViewConsent && row.consentSummary !== null) ||
        (!permissions.mayViewPrivacyCases && row.openCase !== null) ||
        (row.openCase !== null && typeof row.openCase !== "boolean")
      )
        fail();
      return Object.freeze({
        customerReference: ref(row.customerReference),
        displayName: text(row.displayName),
        maskedContact: row.maskedContact === null ? null : text(row.maskedContact),
        relationshipStatus: oneOf(row.relationshipStatus, ["Active", "Restricted", "Closed"]),
        loyaltyStatus: row.loyaltyStatus === null ? null : text(row.loyaltyStatus),
        tierCode: row.tierCode === null ? null : text(row.tierCode),
        lastInteractionAt: row.lastInteractionAt === null ? null : instant(row.lastInteractionAt),
        consentSummary: row.consentSummary === null ? null : text(row.consentSummary),
        openCase: row.openCase as boolean | null,
      });
    }),
  );
  let detail: CustomerProfileView["detail"] = null;
  if (raw.detail !== null) {
    const item = object(raw.detail, [
      "customerReference",
      "aggregateVersion",
      "displayName",
      "preferredLocale",
      "relationshipStatus",
      "creationBasis",
      "userLinked",
      "verifiedContacts",
      "transactionReferences",
      "loyaltyAccounts",
      "consentSummary",
      "communicationCount",
      "privacyCaseReferences",
      "serviceNotes",
      "auditReference",
    ]);
    if (
      typeof item.userLinked !== "boolean" ||
      (!permissions.mayViewContacts && item.verifiedContacts !== null) ||
      (!permissions.mayViewTransactions && item.transactionReferences !== null) ||
      (!permissions.mayViewLoyalty && item.loyaltyAccounts !== null) ||
      (!permissions.mayViewConsent && item.consentSummary !== null) ||
      (!permissions.mayViewCommunications && item.communicationCount !== null) ||
      (!permissions.mayViewPrivacyCases && item.privacyCaseReferences !== null) ||
      (!permissions.mayViewServiceNotes && item.serviceNotes !== null) ||
      (!permissions.mayViewAudit && item.auditReference !== null)
    )
      fail();
    const verifiedContacts =
      item.verifiedContacts === null
        ? null
        : Object.freeze(
            (item.verifiedContacts as unknown[]).map((entry) => {
              const c = object(entry, [
                "contactReference",
                "contactType",
                "maskedValue",
                "verifiedAt",
              ]);
              return Object.freeze({
                contactReference: ref(c.contactReference),
                contactType: oneOf(c.contactType, ["Email", "Phone"]),
                maskedValue: text(c.maskedValue),
                verifiedAt: instant(c.verifiedAt),
              });
            }),
          );
    const transactionReferences =
      item.transactionReferences === null
        ? null
        : Object.freeze(
            (item.transactionReferences as unknown[]).map((entry) => {
              const t = object(entry, ["transactionType", "transactionReference", "linkedAt"]);
              return Object.freeze({
                transactionType: oneOf(t.transactionType, ["Order", "Reservation"]),
                transactionReference: ref(t.transactionReference),
                linkedAt: instant(t.linkedAt),
              });
            }),
          );
    const loyaltyAccounts =
      item.loyaltyAccounts === null
        ? null
        : Object.freeze((item.loyaltyAccounts as unknown[]).map(ref));
    const privacyCaseReferences =
      item.privacyCaseReferences === null
        ? null
        : Object.freeze((item.privacyCaseReferences as unknown[]).map(ref));
    const serviceNotes =
      item.serviceNotes === null
        ? null
        : Object.freeze(
            (item.serviceNotes as unknown[]).map((entry) => {
              const n = object(entry, ["noteReference", "categoryCode", "note", "occurredAt"]);
              return Object.freeze({
                noteReference: ref(n.noteReference),
                categoryCode: text(n.categoryCode),
                note: text(n.note, 500),
                occurredAt: instant(n.occurredAt),
              });
            }),
          );
    detail = Object.freeze({
      customerReference: ref(item.customerReference),
      aggregateVersion: integer(item.aggregateVersion, 1),
      displayName: text(item.displayName),
      preferredLocale: item.preferredLocale === null ? null : text(item.preferredLocale),
      relationshipStatus: oneOf(item.relationshipStatus, ["Active", "Restricted", "Closed"]),
      creationBasis: oneOf(item.creationBasis, [
        "Registration",
        "Login",
        "LoyaltyEnrollment",
        "ExplicitRetentionConsent",
        "StaffBusinessNeed",
      ]),
      userLinked: item.userLinked as boolean,
      verifiedContacts,
      transactionReferences,
      loyaltyAccounts,
      consentSummary: item.consentSummary === null ? null : text(item.consentSummary),
      communicationCount:
        item.communicationCount === null ? null : integer(item.communicationCount),
      privacyCaseReferences,
      serviceNotes,
      auditReference: item.auditReference === null ? null : ref(item.auditReference),
    });
  }
  const screenId = raw.screenId as CustomerProfileView["screenId"];
  if (
    (screenId === "CRM-CUSTOMER-LIST" && detail !== null) ||
    (screenId === "CRM-CUSTOMER-DETAIL" && detail === null)
  )
    fail();
  return Object.freeze({
    projectionName: "customer_profile_v1",
    projectionVersion: 1,
    screenId,
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    permissions,
    rows,
    detail,
  });
}
export const unavailableCustomerProfileClient: CustomerProfileProjectionClient = {
  load: async () => {
    throw new CustomerProfileClientError("Unavailable");
  },
};
