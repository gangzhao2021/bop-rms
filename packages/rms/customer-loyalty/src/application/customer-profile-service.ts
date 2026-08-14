import type {
  CustomerProfileCommand,
  CustomerProfileCommandRecord,
  CustomerProfileProjection,
  CustomerProfileQuery,
} from "../contracts/customer-profile.js";
import {
  addCustomerServiceNote,
  attachVerifiedContact,
  createCustomerProfile,
  CustomerProfileError,
  customerInstant,
  customerReference,
  linkCustomerUser,
  linkGuestTransaction,
  updateCustomerProfile,
  type CustomerProfile,
} from "../domain/customer-profile.js";
import type { CustomerProfilePorts } from "./ports/customer-profile-ports.js";
const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const exact = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
};
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : fail();
const token = (value: unknown) =>
  typeof value === "string" && value.trim() === value && /^[\p{L}\p{N} .'-]{1,80}$/u.test(value)
    ? value
    : fail();
const version = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail();
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
function parseCommand(value: unknown): CustomerProfileCommand {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "action",
    "payload",
  ]);
  if (
    raw.purpose !== "CustomerProfileManagement" ||
    raw.permission !== "customer.manage" ||
    ![
      "Create",
      "UpdateProfile",
      "AttachVerifiedContact",
      "LinkUser",
      "LinkGuestTransaction",
      "AddServiceNote",
    ].includes(raw.action as string)
  )
    return fail();
  const action = raw.action as CustomerProfileCommand["action"];
  const fields =
    action === "Create"
      ? [
          "customerReference",
          "displayName",
          "preferredLocale",
          "creationBasis",
          "creationEvidenceReference",
          "reasonCode",
        ]
      : action === "UpdateProfile"
        ? ["customerReference", "expectedVersion", "displayName", "preferredLocale", "reasonCode"]
        : action === "AttachVerifiedContact"
          ? [
              "customerReference",
              "expectedVersion",
              "contactReference",
              "contactType",
              "verificationReference",
              "reasonCode",
            ]
          : action === "LinkUser"
            ? [
                "customerReference",
                "expectedVersion",
                "userReference",
                "verificationReference",
                "reasonCode",
              ]
            : action === "LinkGuestTransaction"
              ? [
                  "customerReference",
                  "expectedVersion",
                  "linkReference",
                  "transactionType",
                  "transactionReference",
                  "guestIdentityReference",
                  "verificationReference",
                  "reasonCode",
                ]
              : [
                  "customerReference",
                  "expectedVersion",
                  "noteReference",
                  "categoryCode",
                  "note",
                  "reasonCode",
                ];
  const payload = Object.freeze(exact(raw.payload, fields));
  customerReference(payload.customerReference);
  code(payload.reasonCode);
  if (action !== "Create") version(payload.expectedVersion);
  return Object.freeze({
    tenantReference: customerReference(raw.tenantReference),
    brandReference: customerReference(raw.brandReference),
    actorReference: customerReference(raw.actorReference),
    purpose: "CustomerProfileManagement",
    permission: "customer.manage",
    operationReference: customerReference(raw.operationReference),
    occurredAt: customerInstant(raw.occurredAt),
    action,
    payload,
  });
}
function proof(value: unknown, command: CustomerProfileCommand, fields: readonly string[]) {
  const item = exact(value, fields);
  if (
    item.tenantReference !== command.tenantReference ||
    item.brandReference !== command.brandReference ||
    item.customerReference !== command.payload.customerReference ||
    item.verified !== true
  )
    return fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
  customerReference(item.evidenceReference);
  const verifiedAt = customerInstant(item.verifiedAt);
  if (verifiedAt > command.occurredAt) return fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
  return item;
}
export async function executeCustomerProfile(
  value: unknown,
  ports: CustomerProfilePorts,
): Promise<CustomerProfileCommandRecord> {
  const command = parseCommand(value),
    access = await ports.authorization.authorize(command);
  if (!access?.authorized || !access.mayManage) return fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command))),
    replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (
      !ports.references.equals(replay.intentHash, intentHash) ||
      replay.command.actorReference !== command.actorReference ||
      replay.command.tenantReference !== command.tenantReference ||
      replay.command.brandReference !== command.brandReference
    )
      return fail("CUSTOMER_PROFILE_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" });
  }
  const p = command.payload;
  let before: CustomerProfile | null = null,
    after: CustomerProfile;
  if (command.action === "Create") {
    const result = proof(await ports.creationBasis.validate(command), command, [
      "tenantReference",
      "brandReference",
      "customerReference",
      "basis",
      "evidenceReference",
      "verifiedAt",
      "verified",
    ]);
    if (
      result.basis !== p.creationBasis ||
      result.evidenceReference !== p.creationEvidenceReference
    )
      return fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
    after = createCustomerProfile({
      customerReference: p.customerReference,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      displayName: p.displayName,
      preferredLocale: p.preferredLocale,
      creationBasis: p.creationBasis as never,
      creationEvidenceReference: p.creationEvidenceReference,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      reasonCode: p.reasonCode,
    });
  } else {
    before = await ports.repository.load({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      customerReference: customerReference(p.customerReference),
    });
    if (
      !before ||
      before.tenantReference !== command.tenantReference ||
      before.brandReference !== command.brandReference
    )
      return fail();
    const common = {
      expectedVersion: version(p.expectedVersion),
      reasonCode: p.reasonCode,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    };
    if (command.action === "UpdateProfile")
      after = updateCustomerProfile(before, {
        ...common,
        displayName: p.displayName,
        preferredLocale: p.preferredLocale,
      });
    else if (command.action === "AttachVerifiedContact") {
      const result = proof(await ports.identity.validateVerifiedContact(command), command, [
        "tenantReference",
        "brandReference",
        "customerReference",
        "contactReference",
        "contactType",
        "evidenceReference",
        "verifiedAt",
        "verified",
      ]);
      if (
        result.contactReference !== p.contactReference ||
        result.contactType !== p.contactType ||
        result.evidenceReference !== p.verificationReference
      )
        return fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
      after = attachVerifiedContact(before, {
        ...common,
        contactReference: p.contactReference,
        contactType: p.contactType as never,
        verificationReference: p.verificationReference,
        verifiedAt: result.verifiedAt,
      });
    } else if (command.action === "LinkUser") {
      const result = proof(await ports.identity.validateVerifiedUser(command), command, [
        "tenantReference",
        "brandReference",
        "customerReference",
        "userReference",
        "evidenceReference",
        "verifiedAt",
        "verified",
      ]);
      if (
        result.userReference !== p.userReference ||
        result.evidenceReference !== p.verificationReference
      )
        return fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
      after = linkCustomerUser(before, {
        ...common,
        userReference: p.userReference,
        verificationReference: p.verificationReference,
      });
    } else if (command.action === "LinkGuestTransaction") {
      const result = proof(await ports.transactionSource.validateGuestLink(command), command, [
        "tenantReference",
        "brandReference",
        "customerReference",
        "transactionType",
        "transactionReference",
        "guestIdentityReference",
        "evidenceReference",
        "verifiedAt",
        "verified",
        "sourceFactsMutated",
      ]);
      if (
        result.transactionType !== p.transactionType ||
        result.transactionReference !== p.transactionReference ||
        result.guestIdentityReference !== p.guestIdentityReference ||
        result.evidenceReference !== p.verificationReference ||
        result.sourceFactsMutated !== false
      )
        return fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
      after = linkGuestTransaction(before, {
        ...common,
        linkReference: p.linkReference,
        transactionType: p.transactionType as never,
        transactionReference: p.transactionReference,
        guestIdentityReference: p.guestIdentityReference,
        verificationReference: p.verificationReference,
      });
    } else
      after = addCustomerServiceNote(before, {
        ...common,
        noteReference: p.noteReference,
        categoryCode: p.categoryCode,
        note: p.note,
      });
  }
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      profile: after,
      audit: await ports.audit.create({ command, before, after }),
      outcome: "Applied",
    }),
  );
}
export function parseCustomerProfileQuery(value: unknown): CustomerProfileQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "selectedCustomerReference",
    "approvedContactSearchReference",
    "nameToken",
    "relationshipStatus",
    "loyaltyProgramReference",
    "tierCode",
    "consentStatus",
    "lastInteractionFromUtc",
    "hasOpenCase",
    "cursor",
  ]);
  if (
    raw.purpose !== "CustomerProfileRead" ||
    raw.permission !== "customer.manage" ||
    !["All", "Active", "Restricted", "Closed"].includes(raw.relationshipStatus as string) ||
    !["All", "Granted", "Withdrawn", "Missing"].includes(raw.consentStatus as string) ||
    (raw.hasOpenCase !== null && typeof raw.hasOpenCase !== "boolean")
  )
    return fail();
  return Object.freeze({
    tenantReference: customerReference(raw.tenantReference),
    brandReference: customerReference(raw.brandReference),
    actorReference: customerReference(raw.actorReference),
    purpose: "CustomerProfileRead",
    permission: "customer.manage",
    selectedCustomerReference:
      raw.selectedCustomerReference === null
        ? null
        : customerReference(raw.selectedCustomerReference),
    approvedContactSearchReference:
      raw.approvedContactSearchReference === null
        ? null
        : customerReference(raw.approvedContactSearchReference),
    nameToken: raw.nameToken === null ? null : token(raw.nameToken),
    relationshipStatus: raw.relationshipStatus as CustomerProfileQuery["relationshipStatus"],
    loyaltyProgramReference:
      raw.loyaltyProgramReference === null ? null : customerReference(raw.loyaltyProgramReference),
    tierCode: raw.tierCode === null ? null : code(raw.tierCode),
    consentStatus: raw.consentStatus as CustomerProfileQuery["consentStatus"],
    lastInteractionFromUtc:
      raw.lastInteractionFromUtc === null ? null : customerInstant(raw.lastInteractionFromUtc),
    hasOpenCase: raw.hasOpenCase as boolean | null,
    cursor: raw.cursor === null ? null : token(raw.cursor),
  });
}
export async function queryCustomerProfiles(
  value: unknown,
  ports: CustomerProfilePorts,
): Promise<CustomerProfileProjection> {
  const query = parseCustomerProfileQuery(value),
    access = await ports.authorization.authorize(query);
  if (!access?.authorized) return fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const projection = await ports.projection.query(query);
  if (
    projection.projectionName !== "customer_profile_v1" ||
    projection.projectionVersion !== 1 ||
    projection.tenantReference !== query.tenantReference ||
    projection.brandReference !== query.brandReference ||
    (query.selectedCustomerReference !== null &&
      projection.detail?.customerReference !== query.selectedCustomerReference)
  )
    return fail();
  const permissions = Object.freeze({
    mayViewContacts: access.mayViewContacts === true,
    mayViewTransactions: access.mayViewTransactions === true,
    mayViewLoyalty: access.mayViewLoyalty === true,
    mayViewConsent: access.mayViewConsent === true,
    mayViewCommunications: access.mayViewCommunications === true,
    mayViewPrivacyCases: access.mayViewPrivacyCases === true,
    mayViewServiceNotes: access.mayViewServiceNotes === true,
    mayViewAudit: access.mayViewAudit === true,
    mayManage: access.mayManage === true,
  });
  const rows = Object.freeze(
    projection.rows.map((row) =>
      Object.freeze({
        ...row,
        maskedContact: permissions.mayViewContacts ? row.maskedContact : null,
        loyaltyStatus: permissions.mayViewLoyalty ? row.loyaltyStatus : null,
        tierCode: permissions.mayViewLoyalty ? row.tierCode : null,
        consentSummary: permissions.mayViewConsent ? row.consentSummary : null,
        openCase: permissions.mayViewPrivacyCases ? row.openCase : null,
      }),
    ),
  );
  const detail =
    projection.detail === null
      ? null
      : Object.freeze({
          ...projection.detail,
          verifiedContacts: permissions.mayViewContacts ? projection.detail.verifiedContacts : null,
          transactionReferences: permissions.mayViewTransactions
            ? projection.detail.transactionReferences
            : null,
          loyaltyAccounts: permissions.mayViewLoyalty ? projection.detail.loyaltyAccounts : null,
          consentSummary: permissions.mayViewConsent ? projection.detail.consentSummary : null,
          communicationCount: permissions.mayViewCommunications
            ? projection.detail.communicationCount
            : null,
          privacyCaseReferences: permissions.mayViewPrivacyCases
            ? projection.detail.privacyCaseReferences
            : null,
          serviceNotes: permissions.mayViewServiceNotes ? projection.detail.serviceNotes : null,
          auditReference: permissions.mayViewAudit ? projection.detail.auditReference : null,
        });
  return Object.freeze({ ...projection, permissions, rows, detail });
}
