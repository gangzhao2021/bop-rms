import { describe, expect, it, vi } from "vitest";
import {
  createCustomerProfile,
  customerReference,
  executeCustomerProfile,
  linkGuestTransaction,
  queryCustomerProfiles,
  type CustomerProfileCommand,
  type CustomerProfilePorts,
} from "../index.js";
const id = (n: number) =>
  customerReference(`018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (h: number) => `2026-08-14T${String(h).padStart(2, "0")}:00:00.000Z` as never;
const profile = () =>
  createCustomerProfile({
    customerReference: id(5),
    tenantReference: id(1),
    brandReference: id(2),
    displayName: "Synthetic Customer",
    preferredLocale: "en-CA",
    creationBasis: "ExplicitRetentionConsent",
    creationEvidenceReference: id(6),
    actorReference: id(4),
    occurredAt: at(8),
    reasonCode: "EXPLICIT_REQUEST",
  });
const command = (action: CustomerProfileCommand["action"]): CustomerProfileCommand => ({
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(4),
  purpose: "CustomerProfileManagement",
  permission: "customer.manage",
  operationReference: id(20),
  occurredAt: at(10),
  action,
  payload:
    action === "Create"
      ? {
          customerReference: id(5),
          displayName: "Synthetic Customer",
          preferredLocale: "en-CA",
          creationBasis: "ExplicitRetentionConsent",
          creationEvidenceReference: id(6),
          reasonCode: "EXPLICIT_REQUEST",
        }
      : action === "AttachVerifiedContact"
        ? {
            customerReference: id(5),
            expectedVersion: 1,
            contactReference: id(7),
            contactType: "Email",
            verificationReference: id(8),
            reasonCode: "VERIFIED_CONTACT",
          }
        : action === "LinkGuestTransaction"
          ? {
              customerReference: id(5),
              expectedVersion: 1,
              linkReference: id(9),
              transactionType: "Order",
              transactionReference: id(10),
              guestIdentityReference: id(11),
              verificationReference: id(12),
              reasonCode: "VERIFIED_CLAIM",
            }
          : {
              customerReference: id(5),
              expectedVersion: 1,
              displayName: "Updated Customer",
              preferredLocale: "fr-CA",
              reasonCode: "CUSTOMER_REQUEST",
            },
});
function ports(): CustomerProfilePorts {
  const evidence = (input: CustomerProfileCommand) => ({
    tenantReference: id(1),
    brandReference: id(2),
    customerReference: id(5),
    evidenceReference: input.action === "Create" ? id(6) : id(8),
    verifiedAt: at(9),
    verified: true,
  });
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayManage: true,
        mayViewContacts: false,
        mayViewTransactions: false,
        mayViewLoyalty: false,
        mayViewConsent: false,
        mayViewCommunications: false,
        mayViewPrivacyCases: false,
        mayViewServiceNotes: false,
        mayViewAudit: false,
      })),
    },
    projection: {
      query: vi.fn(async (query) => ({
        projectionName: "customer_profile_v1" as const,
        projectionVersion: 1 as const,
        tenantReference: id(1),
        brandReference: id(2),
        asOfUtc: at(11),
        freshness: "Current" as const,
        partial: false,
        nextCursor: null,
        permissions: {
          mayViewContacts: true,
          mayViewTransactions: true,
          mayViewLoyalty: true,
          mayViewConsent: true,
          mayViewCommunications: true,
          mayViewPrivacyCases: true,
          mayViewServiceNotes: true,
          mayViewAudit: true,
          mayManage: true,
        },
        rows: [
          {
            customerReference: id(5),
            displayName: "Synthetic Customer",
            maskedContact: "s***@example.invalid",
            relationshipStatus: "Active" as const,
            loyaltyStatus: "Active",
            tierCode: "GOLD",
            lastInteractionAt: at(10),
            consentSummary: "Granted",
            openCase: true,
          },
        ],
        detail:
          query.selectedCustomerReference === null
            ? null
            : {
                customerReference: id(5),
                aggregateVersion: 1,
                displayName: "Synthetic Customer",
                preferredLocale: "en-CA",
                relationshipStatus: "Active" as const,
                creationBasis: "ExplicitRetentionConsent" as const,
                userLinked: false,
                verifiedContacts: [
                  {
                    contactReference: id(7),
                    contactType: "Email" as const,
                    maskedValue: "s***@example.invalid",
                    verifiedAt: at(9),
                  },
                ],
                transactionReferences: [
                  {
                    transactionType: "Order" as const,
                    transactionReference: id(10),
                    linkedAt: at(10),
                  },
                ],
                loyaltyAccounts: [id(30)],
                consentSummary: "Granted",
                communicationCount: 2,
                privacyCaseReferences: [id(31)],
                serviceNotes: [
                  {
                    noteReference: id(32),
                    categoryCode: "SERVICE",
                    note: "Synthetic note",
                    occurredAt: at(9),
                  },
                ],
                auditReference: id(33),
              },
      })),
    },
    creationBasis: {
      validate: vi.fn(async (input) => ({
        ...evidence(input),
        basis: "ExplicitRetentionConsent",
      })),
    },
    identity: {
      validateVerifiedContact: vi.fn(async (input) => ({
        ...evidence(input),
        contactReference: id(7),
        contactType: "Email",
      })),
      validateVerifiedUser: vi.fn(async (input) => ({ ...evidence(input), userReference: id(15) })),
    },
    transactionSource: {
      validateGuestLink: vi.fn(async () => ({
        tenantReference: id(1),
        brandReference: id(2),
        customerReference: id(5),
        transactionType: "Order",
        transactionReference: id(10),
        guestIdentityReference: id(11),
        evidenceReference: id(12),
        verifiedAt: at(9),
        verified: true,
        sourceFactsMutated: false,
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => profile()),
      commit: vi.fn(async (record) => record),
    },
    audit: {
      create: vi.fn(async () => ({
        auditId: id(40),
        brandId: id(2),
        actor: { type: "User" as const, reference: id(4) },
        actionCode: "CUSTOMER_PROFILE",
        targetType: "CustomerProfile",
        targetId: id(5),
        reasonCode: "CUSTOMER_REQUEST",
        correlationId: id(20),
        occurredAt: at(10),
        sourceChannel: "MerchantWeb",
        dataClassification: "Restricted" as const,
        retentionPolicyCode: "CUSTOMER",
        retentionPolicyVersion: 1,
      })),
    },
    references: {
      generate: vi.fn(() => id(50)),
      hashIntent: vi.fn(() => `sha256:${"7".repeat(64)}`),
      equals: vi.fn((a, b) => a === b),
    },
  };
}
describe("Customer Profile", () => {
  it("requires an explicit verified creation basis", async () => {
    const adapter = ports();
    const result = await executeCustomerProfile(command("Create"), adapter);
    expect(result.profile).toMatchObject({
      creationBasis: "ExplicitRetentionConsent",
      userReference: null,
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.creationBasis.validate as never,
    );
  });
  it("stores only an Identity-owned verified Contact Reference", async () => {
    const adapter = ports();
    const result = await executeCustomerProfile(command("AttachVerifiedContact"), adapter);
    expect(result.profile.verifiedContacts[0]).toMatchObject({
      contactReference: id(7),
      contactType: "Email",
    });
    expect(JSON.stringify(result.profile)).not.toContain("@example");
  });
  it("links a Guest transaction without rewriting its source facts", async () => {
    const adapter = ports();
    const result = await executeCustomerProfile(command("LinkGuestTransaction"), adapter);
    expect(result.profile.guestTransactionLinks[0]).toMatchObject({
      transactionReference: id(10),
      guestIdentityReference: id(11),
    });
    expect(adapter.transactionSource.validateGuestLink).toHaveBeenCalledOnce();
  });
  it("rejects direct duplicate Guest association", () => {
    const once = linkGuestTransaction(profile(), {
      expectedVersion: 1,
      linkReference: id(9),
      transactionType: "Order",
      transactionReference: id(10),
      guestIdentityReference: id(11),
      verificationReference: id(12),
      reasonCode: "VERIFIED_CLAIM",
      actorReference: id(4),
      occurredAt: at(10),
    });
    expect(() =>
      linkGuestTransaction(once, {
        expectedVersion: 2,
        linkReference: id(13),
        transactionType: "Order",
        transactionReference: id(10),
        guestIdentityReference: id(11),
        verificationReference: id(12),
        reasonCode: "VERIFIED_CLAIM",
        actorReference: id(4),
        occurredAt: at(11),
      }),
    ).toThrowError(expect.objectContaining({ code: "CUSTOMER_PROFILE_STATE_CONFLICT" }));
  });
  it("authorizes reads and independently trims every sensitive family", async () => {
    const adapter = ports();
    const result = await queryCustomerProfiles(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        purpose: "CustomerProfileRead",
        permission: "customer.manage",
        selectedCustomerReference: id(5),
        approvedContactSearchReference: null,
        nameToken: null,
        relationshipStatus: "All",
        loyaltyProgramReference: null,
        tierCode: null,
        consentStatus: "All",
        lastInteractionFromUtc: null,
        hasOpenCase: null,
        cursor: null,
      },
      adapter,
    );
    expect(result.rows[0]).toMatchObject({
      maskedContact: null,
      loyaltyStatus: null,
      consentSummary: null,
      openCase: null,
    });
    expect(result.detail).toMatchObject({
      verifiedContacts: null,
      transactionReferences: null,
      serviceNotes: null,
      auditReference: null,
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });
});
