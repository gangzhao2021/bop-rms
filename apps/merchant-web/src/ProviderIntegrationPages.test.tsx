import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderIntegrationState, ProviderIntegrations } from "./ProviderIntegrationPages.js";
import { parseProviderIntegrationView } from "./provider-integration-pages.js";
const id = (n: number) => `018f9996-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T10:00:00.000Z";
const integration = () => ({
  integrationReference: id(1),
  providerCode: "STRIPE_CANADA",
  adapterCode: "STRIPE_PAYMENT_V1",
  ownerModule: "@rms/payment",
  capabilityCodes: ["PAYMENT", "WEBHOOK"],
  environment: "Sandbox",
  storeReference: id(2),
  status: "Disabled",
  effectiveEnablement: "Blocked",
  aggregateVersion: 2,
  contractVersionCode: "PAYMENT_PROVIDER_V1",
  regionCode: "CA",
  lastSuccessAt: null,
  lastSafeErrorCode: "PROVIDER_UNAVAILABLE",
  credentialAgeDays: 31,
  credentialExpiryDisposition: "Current",
  webhookHealth: "Unknown",
  endpointHealth: "Unknown",
  rateLimitPerMinute: 100,
  quotaRemaining: null,
  retryCount: 2,
  deadLetterCount: 1,
  eligibleInboxReference: id(3),
  evidenceReferences: [id(4)],
  requiredEvidenceSatisfied: true,
  killSwitchState: "Open",
});
const view = () => ({
  screenId: "INT-PROVIDER-DETAIL",
  queryName: "provider_integration_admin_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: at,
  freshness: "Fresh",
  completeness: "Complete",
  permissions: {
    mayEnable: true,
    mayDisable: true,
    mayTestSandbox: true,
    mayRotateCredential: true,
    mayReplayInbox: true,
    mayOpenIncident: true,
  },
  filters: {
    providerCode: null,
    capabilityCode: null,
    status: null,
    environment: null,
    storeReference: null,
    degradedOnly: false,
  },
  integrations: [integration()],
});
const first = <T,>(items: readonly T[]) => {
  const item = items[0];
  if (item === undefined) throw new Error("synthetic Provider missing");
  return item;
};
describe("WP-2182 Provider integration screens", () => {
  it("renders safe metadata and owner-routed actions", () => {
    const html = renderToStaticMarkup(
      <ProviderIntegrations view={parseProviderIntegrationView(view())} />,
    );
    for (const value of [
      "INT-PROVIDER-DETAIL",
      "STRIPE CANADA",
      "Owner @rms/payment",
      "Test approved sandbox",
      "Start secret-manager rotation",
      "Replay eligible Inbox Event",
    ])
      expect(html).toContain(value);
    expect(html).not.toMatch(/Bearer |BEGIN PRIVATE|acct_|whsec_/u);
  });
  it("enforces detail cardinality and bounded unique rows", () => {
    const none = view();
    none.integrations = [];
    expect(() => parseProviderIntegrationView(none)).toThrow();
    const duplicate = view();
    duplicate.screenId = "INT-PROVIDER-LIST";
    duplicate.integrations = [integration(), integration()];
    expect(() => parseProviderIntegrationView(duplicate)).toThrow();
    const huge = view();
    huge.screenId = "INT-PROVIDER-LIST";
    huge.integrations = Array.from({ length: 101 }, integration);
    expect(() => parseProviderIntegrationView(huge)).toThrow();
  });
  it("rejects owner, Kill Switch and restricted shape contradictions", () => {
    const owner = view();
    owner.integrations[0] = { ...first(owner.integrations), ownerModule: "@bop/notification" };
    expect(() => parseProviderIntegrationView(owner)).toThrow();
    const kill = view();
    kill.integrations[0] = {
      ...first(kill.integrations),
      status: "KillSwitched",
      killSwitchState: "Open",
    };
    expect(() => parseProviderIntegrationView(kill)).toThrow();
    expect(() =>
      parseProviderIntegrationView({ ...view(), rawProviderPayload: "forbidden" }),
    ).toThrow();
  });
  it("disables owner actions for stale projections", () => {
    const stale = view();
    stale.freshness = "Stale";
    expect(
      renderToStaticMarkup(<ProviderIntegrations view={parseProviderIntegrationView(stale)} />),
    ).toContain('<button disabled="">Test approved sandbox</button>');
  });
  it("hides actions without permission", () => {
    const denied = view();
    denied.permissions = {
      mayEnable: false,
      mayDisable: false,
      mayTestSandbox: false,
      mayRotateCredential: false,
      mayReplayInbox: false,
      mayOpenIncident: false,
    };
    expect(
      renderToStaticMarkup(<ProviderIntegrations view={parseProviderIntegrationView(denied)} />),
    ).not.toContain("<button");
  });
  it("renders the list empty state", () => {
    const empty = view();
    empty.screenId = "INT-PROVIDER-LIST";
    empty.integrations = [];
    expect(
      renderToStaticMarkup(<ProviderIntegrations view={parseProviderIntegrationView(empty)} />),
    ).toContain("No Provider Integrations");
  });
  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "FeatureDisabled",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Offline",
    "Unavailable",
  ] as const)("renders %s", (state) =>
    expect(renderToStaticMarkup(<ProviderIntegrationState state={state} />)).toContain(
      'role="status"',
    ),
  );
});
