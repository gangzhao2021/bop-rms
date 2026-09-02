import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingEntities, OperatingEntityState } from "./OperatingEntityPages.js";
import { parseOperatingEntityAdminView } from "./operating-entity-pages.js";
const id = (n: number) => `018f9e60-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T13:00:00.000Z";
const entity = () => ({
  operatingEntityReference: id(1),
  legalName: "Synthetic Ontario Incorporated",
  tradeName: "Synthetic Kitchen",
  jurisdictionCode: "CA-ON",
  lifecycle: "Active",
  aggregateVersion: 3,
  profileVersion: 2,
  brandCount: 1,
  storeCount: 1,
  effectiveFrom: at,
  effectiveUntil: null,
  registrationReference: id(2),
  taxRegistrationReference: id(3),
  registeredAddressReference: id(4),
  restrictedFieldsRevealed: true,
  approvalStatus: "Approved",
  authoritySummaries: [
    {
      roleCode: "Officer",
      titleCode: "PRESIDENT",
      status: "Active",
      effectiveFrom: at,
      effectiveUntil: null,
    },
  ],
  assignments: [
    {
      assignmentReference: id(5),
      brandReference: id(6),
      storeReference: id(7),
      businessFunction: "SalesReceiptIssuer",
      status: "Active",
      effectiveFrom: at,
      effectiveUntil: null,
    },
  ],
  evidenceReferences: [id(8)],
  auditSummaryReference: id(9),
});
const view = () => ({
  screenId: "ORG-ENTITY-DETAIL",
  queryName: "operating_entity_admin_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: at,
  freshness: "Fresh",
  completeness: "Complete",
  permissions: {
    mayCreate: true,
    mayEdit: true,
    maySubmit: true,
    mayApprove: true,
    mayActivate: true,
    maySuspend: true,
    mayManageAssignment: true,
    mayViewRestricted: true,
  },
  recentMfa: true,
  filters: { name: null, registrationExact: null, status: null, jurisdictionCode: null },
  entities: [entity()],
});
describe("WP-2190 Operating Entity screens", () => {
  it("renders controlled metadata, authority summaries and Business Functions", () => {
    const html = renderToStaticMarkup(
      <OperatingEntities view={parseOperatingEntityAdminView(view())} />,
    );
    for (const value of [
      "ORG-ENTITY-DETAIL",
      "Synthetic Ontario Incorporated",
      "Officer PRESIDENT",
      "Sales Receipt Issuer",
      "Suspend entity",
      "Manage Business Functions",
    ])
      expect(html).toContain(value);
    expect(html).not.toMatch(/Bearer |BEGIN PRIVATE KEY|account_number|tax_identifier/iu);
  });
  it("requires permission plus recent MFA for restricted references and exact search", () => {
    const noMfa = { ...view(), recentMfa: false };
    expect(() => parseOperatingEntityAdminView(noMfa)).toThrow();
    const hidden = {
      ...view(),
      permissions: { ...view().permissions, mayViewRestricted: false },
      filters: { ...view().filters, registrationExact: id(2) },
      entities: [
        {
          ...entity(),
          registrationReference: null,
          taxRegistrationReference: null,
          registeredAddressReference: null,
          restrictedFieldsRevealed: false,
        },
      ],
    };
    expect(() => parseOperatingEntityAdminView(hidden)).toThrow();
  });
  it("rejects unrestricted fields, duplicate assignments and detail cardinality", () => {
    expect(() => parseOperatingEntityAdminView({ ...view(), officerName: "forbidden" })).toThrow();
    const assignment = entity().assignments[0];
    if (!assignment) throw new Error("synthetic assignment missing");
    const duplicate = {
      ...view(),
      entities: [{ ...entity(), assignments: [assignment, assignment] }],
    };
    expect(() => parseOperatingEntityAdminView(duplicate)).toThrow();
    const empty = { ...view(), entities: [] };
    expect(() => parseOperatingEntityAdminView(empty)).toThrow();
  });
  it("disables mutations for stale data and hides ungranted actions", () => {
    const stale = { ...view(), freshness: "Stale" };
    expect(
      renderToStaticMarkup(<OperatingEntities view={parseOperatingEntityAdminView(stale)} />),
    ).toContain('<button disabled="">Suspend entity</button>');
    const denied = {
      ...view(),
      permissions: {
        mayCreate: false,
        mayEdit: false,
        maySubmit: false,
        mayApprove: false,
        mayActivate: false,
        maySuspend: false,
        mayManageAssignment: false,
        mayViewRestricted: false,
      },
      entities: [
        {
          ...entity(),
          registrationReference: null,
          taxRegistrationReference: null,
          registeredAddressReference: null,
          restrictedFieldsRevealed: false,
        },
      ],
    };
    expect(
      renderToStaticMarkup(<OperatingEntities view={parseOperatingEntityAdminView(denied)} />),
    ).not.toContain("<button");
  });
  it("renders list empty and all canonical states", () => {
    const empty = { ...view(), screenId: "ORG-ENTITY-LIST", entities: [] };
    expect(
      renderToStaticMarkup(<OperatingEntities view={parseOperatingEntityAdminView(empty)} />),
    ).toContain("No Operating Entities");
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<OperatingEntityState state={state} />)).toContain(
        'role="status"',
      );
  });
});
