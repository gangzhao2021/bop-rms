import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiClients, ApiClientState } from "./ApiClientPage.js";
import { parseApiClientAdminView } from "./api-client-page.js";
const id = (n: number) => `018f9997-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T12:00:00.000Z";
const item = () => ({
  clientReference: id(1),
  nameCode: "ORDER_EXPORTER",
  ownerReference: id(2),
  storeReference: null,
  environment: "Sandbox",
  status: "Active",
  scopeCodes: ["ORDERS.READ"],
  grantCodes: ["ORDER.EXPORT.READ"],
  aggregateVersion: 3,
  credentialVersion: 2,
  credentialAgeDays: 5,
  credentialExpiresAt: "2026-11-15T12:00:00.000Z",
  lastUsedAt: at,
  auditSummaryReference: id(3),
});
const view = () => ({
  screenId: "INT-API-CLIENT",
  queryName: "api_client_admin_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: at,
  freshness: "Fresh",
  completeness: "Complete",
  permissions: {
    mayRequest: true,
    maySubmitApproval: true,
    mayRotate: true,
    mayRevoke: true,
    mayViewAudit: true,
  },
  filters: { nameCode: null, status: null, scopeCode: null, environment: null, unusedOnly: false },
  clients: [item()],
});
describe("WP-2183 API Client screen", () => {
  it("renders safe credential metadata and authorized lifecycle actions", () => {
    const html = renderToStaticMarkup(<ApiClients view={parseApiClientAdminView(view())} />);
    for (const value of [
      "INT-API-CLIENT",
      "ORDER EXPORTER",
      "Start secure rotation",
      "Revoke API Client",
      "View audit",
    ])
      expect(html).toContain(value);
    expect(html).not.toMatch(/BEGIN PRIVATE|Bearer /u);
  });
  it("rejects unknown fields, duplicate rows, impossible credential shape and cardinality", () => {
    expect(() => parseApiClientAdminView({ ...view(), credentialValue: "forbidden" })).toThrow();
    const duplicate = view();
    duplicate.clients = [item(), item()];
    expect(() => parseApiClientAdminView(duplicate)).toThrow();
    const pending = view();
    pending.clients[0] = { ...item(), status: "Requested" };
    expect(() => parseApiClientAdminView(pending)).toThrow();
    const huge = view();
    huge.clients = Array.from({ length: 101 }, item);
    expect(() => parseApiClientAdminView(huge)).toThrow();
  });
  it("disables mutations for stale data and hides ungranted actions", () => {
    const stale = view();
    stale.freshness = "Stale";
    expect(renderToStaticMarkup(<ApiClients view={parseApiClientAdminView(stale)} />)).toContain(
      '<button disabled="">Start secure rotation</button>',
    );
    const denied = view();
    denied.permissions = {
      mayRequest: false,
      maySubmitApproval: false,
      mayRotate: false,
      mayRevoke: false,
      mayViewAudit: false,
    };
    expect(
      renderToStaticMarkup(<ApiClients view={parseApiClientAdminView(denied)} />),
    ).not.toContain("<button");
  });
  it("renders empty and all canonical failure states", () => {
    const empty = view();
    empty.clients = [];
    expect(renderToStaticMarkup(<ApiClients view={parseApiClientAdminView(empty)} />)).toContain(
      "No API Clients",
    );
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
      expect(renderToStaticMarkup(<ApiClientState state={state} />)).toContain('role="status"');
  });
});
