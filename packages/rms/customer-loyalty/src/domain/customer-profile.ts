export type CustomerReference = string & { readonly __customerReference: unique symbol };
export type CustomerInstant = string & { readonly __customerInstant: unique symbol };
export type CustomerRelationshipStatus = "Active" | "Restricted" | "Closed";
export type CustomerCreationBasis =
  "Registration" | "Login" | "LoyaltyEnrollment" | "ExplicitRetentionConsent" | "StaffBusinessNeed";
export interface VerifiedContactLink {
  readonly contactReference: CustomerReference;
  readonly contactType: "Email" | "Phone";
  readonly verificationReference: CustomerReference;
  readonly verifiedAt: CustomerInstant;
  readonly attachedAt: CustomerInstant;
}
export interface GuestTransactionLink {
  readonly linkReference: CustomerReference;
  readonly transactionType: "Order" | "Reservation";
  readonly transactionReference: CustomerReference;
  readonly guestIdentityReference: CustomerReference;
  readonly verificationReference: CustomerReference;
  readonly linkedBy: CustomerReference;
  readonly linkedAt: CustomerInstant;
}
export interface CustomerServiceNote {
  readonly noteReference: CustomerReference;
  readonly categoryCode: string;
  readonly note: string;
  readonly actorReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
}
export interface CustomerDecision {
  readonly action:
    | "Created"
    | "ProfileUpdated"
    | "ContactAttached"
    | "UserLinked"
    | "GuestTransactionLinked"
    | "ServiceNoteAdded"
    | "StatusChanged";
  readonly reasonCode: string;
  readonly evidenceReference: CustomerReference | null;
  readonly actorReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
}
export interface CustomerProfile {
  readonly customerReference: CustomerReference;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly userReference: CustomerReference | null;
  readonly displayName: string;
  readonly preferredLocale: string | null;
  readonly relationshipStatus: CustomerRelationshipStatus;
  readonly creationBasis: CustomerCreationBasis;
  readonly creationEvidenceReference: CustomerReference;
  readonly verifiedContacts: readonly VerifiedContactLink[];
  readonly guestTransactionLinks: readonly GuestTransactionLink[];
  readonly serviceNotes: readonly CustomerServiceNote[];
  readonly decisions: readonly CustomerDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: CustomerInstant;
  readonly updatedAt: CustomerInstant;
}
export type CustomerProfileErrorCode =
  | "CUSTOMER_PROFILE_INVALID"
  | "CUSTOMER_PROFILE_STATE_CONFLICT"
  | "CUSTOMER_PROFILE_IDEMPOTENCY_CONFLICT"
  | "CUSTOMER_PROFILE_PERMISSION_DENIED"
  | "CUSTOMER_PROFILE_PROOF_REQUIRED";
export class CustomerProfileError extends Error {
  constructor(readonly code: CustomerProfileErrorCode) {
    super("Customer Profile operation unavailable");
    this.name = "CustomerProfileError";
  }
}
const fail = (code: CustomerProfileErrorCode = "CUSTOMER_PROFILE_INVALID"): never => {
  throw new CustomerProfileError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u;
const noteSafe = /^[^\p{Cc}\p{Cf}<>{}$]{1,500}$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const customerReference = (value: unknown): CustomerReference =>
  typeof value === "string" && uuid.test(value) ? (value as CustomerReference) : fail();
export const customerInstant = (value: unknown): CustomerInstant =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? (value as CustomerInstant)
    : fail();
const code = (value: unknown) =>
  typeof value === "string" && codePattern.test(value) ? value : fail();
const text = (value: unknown, note = false) =>
  typeof value === "string" && value.trim() === value && (note ? noteSafe : safe).test(value)
    ? value
    : fail();
const expected = (profile: CustomerProfile, version: number) => {
  if (profile.aggregateVersion !== version) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
};
const decision = (
  action: CustomerDecision["action"],
  reasonCode: unknown,
  evidenceReference: unknown,
  actorReference: unknown,
  occurredAt: unknown,
): CustomerDecision =>
  Object.freeze({
    action,
    reasonCode: code(reasonCode),
    evidenceReference: evidenceReference === null ? null : customerReference(evidenceReference),
    actorReference: customerReference(actorReference),
    occurredAt: customerInstant(occurredAt),
  });
export function createCustomerProfile(input: {
  customerReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  displayName: unknown;
  preferredLocale: unknown;
  creationBasis: CustomerCreationBasis;
  creationEvidenceReference: unknown;
  actorReference: unknown;
  occurredAt: unknown;
  reasonCode: unknown;
}): CustomerProfile {
  if (
    ![
      "Registration",
      "Login",
      "LoyaltyEnrollment",
      "ExplicitRetentionConsent",
      "StaffBusinessNeed",
    ].includes(input.creationBasis)
  )
    fail();
  const occurredAt = customerInstant(input.occurredAt),
    evidence = customerReference(input.creationEvidenceReference);
  return Object.freeze({
    customerReference: customerReference(input.customerReference),
    tenantReference: customerReference(input.tenantReference),
    brandReference: customerReference(input.brandReference),
    userReference: null,
    displayName: text(input.displayName),
    preferredLocale: input.preferredLocale === null ? null : text(input.preferredLocale),
    relationshipStatus: "Active",
    creationBasis: input.creationBasis,
    creationEvidenceReference: evidence,
    verifiedContacts: Object.freeze([]),
    guestTransactionLinks: Object.freeze([]),
    serviceNotes: Object.freeze([]),
    decisions: Object.freeze([
      decision("Created", input.reasonCode, evidence, input.actorReference, occurredAt),
    ]),
    aggregateVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}
const evolve = (
  profile: CustomerProfile,
  patch: Partial<CustomerProfile>,
  entry: CustomerDecision,
): CustomerProfile =>
  Object.freeze({
    ...profile,
    ...patch,
    decisions: Object.freeze([...profile.decisions, entry]),
    aggregateVersion: profile.aggregateVersion + 1,
    updatedAt: entry.occurredAt,
  });
export function updateCustomerProfile(
  profile: CustomerProfile,
  input: {
    expectedVersion: number;
    displayName: unknown;
    preferredLocale: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): CustomerProfile {
  expected(profile, input.expectedVersion);
  return evolve(
    profile,
    {
      displayName: text(input.displayName),
      preferredLocale: input.preferredLocale === null ? null : text(input.preferredLocale),
    },
    decision("ProfileUpdated", input.reasonCode, null, input.actorReference, input.occurredAt),
  );
}
export function attachVerifiedContact(
  profile: CustomerProfile,
  input: {
    expectedVersion: number;
    contactReference: unknown;
    contactType: "Email" | "Phone";
    verificationReference: unknown;
    verifiedAt: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): CustomerProfile {
  expected(profile, input.expectedVersion);
  const contactReference = customerReference(input.contactReference);
  if (
    !["Email", "Phone"].includes(input.contactType) ||
    profile.verifiedContacts.some((item) => item.contactReference === contactReference)
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const occurredAt = customerInstant(input.occurredAt),
    verifiedAt = customerInstant(input.verifiedAt);
  if (verifiedAt > occurredAt) fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
  const contact = Object.freeze({
    contactReference,
    contactType: input.contactType,
    verificationReference: customerReference(input.verificationReference),
    verifiedAt,
    attachedAt: occurredAt,
  });
  return evolve(
    profile,
    { verifiedContacts: Object.freeze([...profile.verifiedContacts, contact]) },
    decision(
      "ContactAttached",
      input.reasonCode,
      contact.verificationReference,
      input.actorReference,
      occurredAt,
    ),
  );
}
export function linkCustomerUser(
  profile: CustomerProfile,
  input: {
    expectedVersion: number;
    userReference: unknown;
    verificationReference: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): CustomerProfile {
  expected(profile, input.expectedVersion);
  if (profile.userReference !== null) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const evidence = customerReference(input.verificationReference);
  return evolve(
    profile,
    { userReference: customerReference(input.userReference) },
    decision("UserLinked", input.reasonCode, evidence, input.actorReference, input.occurredAt),
  );
}
export function linkGuestTransaction(
  profile: CustomerProfile,
  input: {
    expectedVersion: number;
    linkReference: unknown;
    transactionType: "Order" | "Reservation";
    transactionReference: unknown;
    guestIdentityReference: unknown;
    verificationReference: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): CustomerProfile {
  expected(profile, input.expectedVersion);
  const transactionReference = customerReference(input.transactionReference);
  if (
    !["Order", "Reservation"].includes(input.transactionType) ||
    profile.guestTransactionLinks.some((item) => item.transactionReference === transactionReference)
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const linkedAt = customerInstant(input.occurredAt),
    verificationReference = customerReference(input.verificationReference);
  const link = Object.freeze({
    linkReference: customerReference(input.linkReference),
    transactionType: input.transactionType,
    transactionReference,
    guestIdentityReference: customerReference(input.guestIdentityReference),
    verificationReference,
    linkedBy: customerReference(input.actorReference),
    linkedAt,
  });
  return evolve(
    profile,
    { guestTransactionLinks: Object.freeze([...profile.guestTransactionLinks, link]) },
    decision(
      "GuestTransactionLinked",
      input.reasonCode,
      verificationReference,
      input.actorReference,
      linkedAt,
    ),
  );
}
export function addCustomerServiceNote(
  profile: CustomerProfile,
  input: {
    expectedVersion: number;
    noteReference: unknown;
    categoryCode: unknown;
    note: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): CustomerProfile {
  expected(profile, input.expectedVersion);
  const occurredAt = customerInstant(input.occurredAt);
  const note = Object.freeze({
    noteReference: customerReference(input.noteReference),
    categoryCode: code(input.categoryCode),
    note: text(input.note, true),
    actorReference: customerReference(input.actorReference),
    occurredAt,
  });
  return evolve(
    profile,
    { serviceNotes: Object.freeze([...profile.serviceNotes, note]) },
    decision("ServiceNoteAdded", input.reasonCode, null, input.actorReference, occurredAt),
  );
}
