import { MerchantTaxConfigFeatureDisabled } from "./merchant-tax-config-capability.js";
import {
  parseTaxConfigClassificationChoices,
  parseTaxConfigAuthoringSimulation,
  parseMerchantTaxConfigMaterialComparisonCommand,
  parseTaxConfigMaterialComparison,
} from "./merchant-tax-config-workbench-values.js";
import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import {
  createAuthenticationSession,
  createIdentityActor,
  parseRawBrowserCredential,
} from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseTaxConfigAuthoringCommand,
  createTaxPublicationCandidate,
  createTaxConfigCandidateRecord,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  parseTaxConfigCandidateSummary,
  parseTaxConfigAuthoringState,
  taxConfigCandidateIntentDigest,
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialOperation,
  taxConfigMaterialContentDigest,
  taxConfigMaterialIntentDigest,
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  parseTaxConfigAuthoringOperation,
  taxConfigAuthoringIntentDigest,
  TaxConfigWorkflowError,
  createTaxConfigurationSnapshot,
  parsePricingDigest,
  parsePricingCode,
  parseCurrencyCode,
  parsePricingReference,
  parseTaxRate,
  simulateDraftTaxFixture,
} from "@rms/pricing";
import { createApp } from "./app.js";
import { parseMerchantWorkspaceSnapshot, type MerchantBffService } from "./merchant-bff.js";
import type { createMerchantTaxConfigAuthoring } from "./merchant-tax-config-authoring.js";
// Actual localhost HTTP and public contract parsers; controlled service outputs, not real IAM/persistence.
const id = (n: number) => "01902421-1510-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  }),
  cookie = Buffer.alloc(32, 2).toString("base64url"),
  csrf = parseRawBrowserCredential(Buffer.alloc(32, 1).toString("base64url")),
  headers = {
    Host: "merchant.invalid",
    Origin: "https://merchant.invalid",
    "Sec-Fetch-Site": "same-origin",
    Cookie: "__Host-bop-merchant=" + cookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
    "X-BOP-Store-Setup-Scope": Buffer.from(JSON.stringify(scope)).toString("base64url"),
  };
const command = () =>
  parseTaxConfigAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(7),
    configurationReference: null,
    expectedAggregateVersion: null,
    content: {
      stableCode: "TEST-TAX",
      effectivePeriod: {
        effectiveFrom: {
          instant: at,
          localDateTime: "2026-10-05T12:00:00.000",
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
        timeZone: "UTC",
      },
      rules: [],
    },
  });
const resolveCommand = () => ({
  action: "CreateDraft",
  operationReference: id(7),
  configurationReference: null,
  expectedAggregateVersion: null,
  intentDigest: taxConfigAuthoringIntentDigest(scope, command()),
});
const workspace = parseTaxConfigAuthoringCurrent({
  profile: "TaxConfigAuthoringCurrentV1",
  ...scope,
  configurationReference: null,
  state: null,
  observedAt: at,
  validUntil: until,
  referenceEligibility: "NotEvaluated",
});
function receipt(abandoned = false) {
  const c = command();
  const base = {
    configurationReference: scope.tenantReference,
    versionReference: scope.actorReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    stableCode: c.content.stableCode,
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft" as const,
    jurisdictionCode: parsePricingCode("CA-ON"),
    currencyMetadata: {
      currencyCode: parseCurrencyCode("CAD"),
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: scope.tenantReference,
      metadataDigest: parsePricingDigest("sha256:" + "a".repeat(64)),
    },
    effectivePeriod: c.content.effectivePeriod,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: [],
    createdAt: at,
  };
  const snapshot = createTaxConfigurationSnapshot({
    ...base,
    snapshotDigest: parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(base))),
  });
  return parseTaxConfigAuthoringOperation({
    profile: "TaxConfigAuthoringOperationV1",
    ...scope,
    ...resolveCommand(),
    command: abandoned ? null : c,
    serviceIntentDigest: abandoned ? null : "sha256:" + "b".repeat(64),
    outcome: abandoned ? "Abandoned" : "Committed",
    snapshot: abandoned ? null : snapshot,
    auditReference: id(15),
    eventReference: abandoned ? null : id(16),
    occurredAt: at,
  });
}
const session = createAuthenticationSession({
  sessionReference: id(10),
  actor: createIdentityActor({
    actorType: "User",
    actorReference: id(4),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  }),
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt: at,
  createdAt: at,
  lastSeenAt: at,
  idleExpiresAt: "2026-10-05T12:30:00.000Z",
  absoluteExpiresAt: "2026-10-06T00:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
type Port = ReturnType<typeof createMerchantTaxConfigAuthoring>;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
function classifications() {
  return parseTaxConfigClassificationChoices({
    profile: "TaxConfigClassificationChoicesV1",
    ...scope,
    registryReference: id(30),
    versionReference: id(31),
    registryVersion: 1,
    snapshotDigest: "sha256:" + "c".repeat(64),
    defaultLocale: "en-CA",
    choices: [
      {
        classificationReference: id(8),
        code: "SYNTHETIC",
        localizedNames: { "en-CA": "Controlled classification" },
        lifecycle: "Active",
      },
    ],
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated",
  });
}
function simulationFixture() {
  return {
    profile: "TaxDraftFixtureV1",
    fixtureReference: id(40),
    kind: "Basket",
    evaluatedAt: at,
    lines: [
      {
        lineReference: id(41),
        calculationReferences: [id(42)],
        labelCode: "SYNTHETIC",
        taxClassificationReference: id(8),
        orderType: "Pickup",
        chargeType: "Sellable",
        amountMinor: "1000",
      },
    ],
  };
}
function simulated() {
  const original = receipt().snapshot;
  if (!original) throw new Error("Controlled Draft missing");
  const rules: typeof original.rules = [
    {
      ruleReference: parsePricingReference(id(43)),
      taxClassificationReference: parsePricingReference(id(8)),
      orderType: "Pickup",
      chargeType: "Sellable",
      taxComponentCode: parsePricingCode("SYNTHETIC"),
      treatment: "Taxable",
      rate: parseTaxRate("0.13"),
      priceInclusion: "Exclusive",
      roundingMode: "HalfUp",
      calculationOrder: 1,
      compoundOnPriorTax: false,
      exceptionEvidenceReference: null,
      receiptPresentationCode: parsePricingCode("SYNTHETIC"),
    },
  ];
  const body = {
    ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== "snapshotDigest")),
    rules,
  };
  const snapshot = createTaxConfigurationSnapshot({
    ...original,
    rules,
    snapshotDigest: parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(body))),
  });
  return parseTaxConfigAuthoringSimulation({
    profile: "TaxConfigAuthoringSimulationV1",
    ...scope,
    configurationReference: snapshot.configurationReference,
    versionReference: snapshot.versionReference,
    snapshotDigest: snapshot.snapshotDigest,
    simulation: simulateDraftTaxFixture(snapshot, simulationFixture()),
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  });
}
const simulationCommand = () => {
  const result = simulated();
  return {
    configurationReference: result.configurationReference,
    expectedVersionReference: result.versionReference,
    expectedSnapshotDigest: result.snapshotDigest,
    fixture: simulationFixture(),
  };
};
function endpoints() {
  return {
    candidateCurrent: vi.fn<Port["candidateCurrent"]>(async () => candidateCurrent()),
    candidateRoster: vi.fn<Port["candidateRoster"]>(async () => candidateRoster()),
    candidatePrepare: vi.fn<Port["candidatePrepare"]>(async () => candidateReceipt()),
    candidateResolve: vi.fn<Port["candidateResolve"]>(async () => candidateReceipt(true)),
    classifications: vi.fn<Port["classifications"]>(async () => classifications()),
    simulate: vi.fn<Port["simulate"]>(async () => simulated()),
    taxRegistrant: vi.fn<Port["taxRegistrant"]>(async () => null),
    materialCompare: vi.fn<Port["materialCompare"]>(async () => materialComparison()),
    materialCurrent: vi.fn<Port["materialCurrent"]>(async () => materialCurrent()),
    materialVersion: vi.fn<Port["materialVersion"]>(async () => materialCurrent()),
    materialRoster: vi.fn<Port["materialRoster"]>(async () =>
      parseTaxConfigMaterialRoster({
        profile: "TaxConfigMaterialRosterV1",
        ...scope,
        materialKind: "RegistrationApplicability",
        afterMaterial: null,
        entries: [],
        nextAfterMaterial: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      }),
    ),
    materialExecute: vi.fn<Port["materialExecute"]>(async () => materialReceipt()),
    materialResolve: vi.fn<Port["materialResolve"]>(async () => materialReceipt(true)),
    current: vi.fn<Port["current"]>(async () => workspace),
    roster: vi.fn<Port["roster"]>(async () =>
      parseTaxConfigAuthoringRoster({
        profile: "TaxConfigAuthoringRosterV1",
        ...scope,
        afterConfiguration: null,
        entries: [],
        nextAfterConfiguration: null,
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      }),
    ),
    execute: vi.fn<Port["execute"]>(async () => receipt()),
    resolve: vi.fn<Port["resolve"]>(async () => receipt(true)),
  };
}
async function serve(port?: Port) {
  const unused = async (): Promise<never> => {
    throw new Error("Unconfigured unrelated transport service");
  };
  const service: MerchantBffService = {
    start: unused,
    callback: unused,
    bootstrap: vi.fn(async () => ({
      session,
      csrf,
      workspace: {
        screenId: "HOME-OVERVIEW",
        selectedScope: {
          storeReference: scope.storeReference,
          storeLabel: "Synthetic Store",
          brandLabel: "Synthetic Brand",
        },
        authorizedStores: [
          {
            storeReference: scope.storeReference,
            storeLabel: "Synthetic Store",
            brandLabel: "Synthetic Brand",
          },
        ],
        businessDate: "2026-10-05",
        storeStatus: "Unavailable",
        freshness: "Stale",
        dashboardAvailability: "UnavailableUntilWP1905",
        navigation: [
          {
            screenId: "TAX-CONFIG",
            label: "Configured Tax",
            href: "/app/commerce/tax",
            permission: "pricing.tax-config.manage",
          },
        ],
      },
    })),
    authorize: vi.fn(async () => session),
    logout: unused,
    switchStore: unused,
  };
  const app = createApp({
      merchantBff: {
        service,
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(port ? { taxConfigAuthoring: port } : {}),
      },
    }),
    server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test listener unavailable");
  return "http://127.0.0.1:" + address.port;
}
async function send(
  root: string,
  {
    method = "POST",
    route = "commands",
    query = "",
    body = command(),
    customHeaders = headers,
    text,
  }: {
    method?: "GET" | "POST";
    route?:
      | "session"
      | "commands"
      | "resolve-original"
      | "current"
      | "roster"
      | "scope"
      | "classifications"
      | "simulate"
      | "tax-registrant"
      | "materials/compare"
      | "materials/current"
      | "materials/version"
      | "materials/roster"
      | "materials/commands"
      | "materials/resolve-original"
      | "candidates/current"
      | "candidates/roster"
      | "candidates/commands"
      | "candidates/resolve-original";
    query?: string;
    body?: unknown;
    customHeaders?: Readonly<Record<string, string | string[]>>;
    text?: string;
  } = {},
) {
  return new Promise<{ status: number; headers: Headers; body: unknown; raw: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        new URL(
          (route === "session" ? "/merchant/session" : "/merchant/tax-config/authoring/" + route) +
            query,
          root,
        ),
        { method, headers: customHeaders },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.once("error", reject);
          incoming.once("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8"),
              replyHeaders = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
              const name = incoming.rawHeaders[i],
                value = incoming.rawHeaders[i + 1];
              if (name !== undefined && value !== undefined) replyHeaders.append(name, value);
            }
            resolve({
              status: incoming.statusCode ?? 0,
              headers: replyHeaders,
              body: JSON.parse(raw),
              raw,
            });
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(method === "GET" ? undefined : (text ?? JSON.stringify(body)));
    },
  );
}
it.each(["current", "roster"] as const)("reads actual scoped %s", async (route) => {
  const port = endpoints();
  const result = await send(await serve(port), {
    method: "GET",
    route,
    query: "?storeReference=" + id(3),
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(port[route]).toHaveBeenCalledOnce();
});
it.each(["commands", "resolve-original"] as const)(
  "passes exact %s tuple to actual service port",
  async (route) => {
    const port = endpoints();
    const result = await send(await serve(port), {
      route,
      body: route === "commands" ? command() : resolveCommand(),
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(receipt(route !== "commands"));
    expect(route === "commands" ? port.execute : port.resolve).toHaveBeenCalledExactlyOnceWith({
      sessionCookie: cookie,
      csrf,
      expectedScope: scope,
      command: route === "commands" ? command() : resolveCommand(),
    });
  },
);
it.each([
  "TAX_CONFIG_PERMISSION_DENIED",
  "TAX_CONFIG_VERSION_CONFLICT",
  "TAX_CONFIG_IDEMPOTENCY_CONFLICT",
  "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
] as const)("bounds actual %s without body disclosure", async (code) => {
  const port = endpoints();
  port.execute.mockRejectedValue(new TaxConfigWorkflowError(code));
  const reply = await send(await serve(port));
  expect(reply.status).toBe(
    code.includes("PERMISSION") ? 403 : code.includes("CONFLICT") ? 409 : 503,
  );
  expect(reply.raw).not.toContain(id(7));
});
it("rejects malformed, authority-bearing and oversized command bodies", async () => {
  const port = endpoints(),
    root = await serve(port);
  for (const body of [
    { ...command(), currencyMetadata: {} },
    { ...command(), actorReference: id(9) },
    { ...command(), expectedAggregateVersion: 1 },
  ])
    expect((await send(root, { body })).status).toBe(400);
  expect((await send(root, { text: "{broken" })).status).toBe(400);
  expect((await send(root, { text: JSON.stringify({ padding: "a".repeat(100000) }) })).status).toBe(
    413,
  );
  expect(port.execute).not.toHaveBeenCalled();
});
it("rejects foreign origin, missing CSRF, duplicate scope and query mutation", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect(
    (await send(root, { customHeaders: { ...headers, Origin: "https://other.invalid" } })).status,
  ).toBe(403);
  const withoutCsrf = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== "X-BOP-CSRF"),
  );
  expect((await send(root, { customHeaders: withoutCsrf })).status).toBe(403);
  expect(
    (
      await send(root, {
        customHeaders: {
          ...headers,
          "X-BOP-Store-Setup-Scope": [
            headers["X-BOP-Store-Setup-Scope"],
            headers["X-BOP-Store-Setup-Scope"],
          ],
        },
      })
    ).status,
  ).toBe(403);
  expect((await send(root, { query: "?extra=1" })).status).toBe(403);
  expect(port.execute).not.toHaveBeenCalled();
});
it("rejects read scope mismatch and duplicate/unknown query fields", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect(
    (await send(root, { method: "GET", route: "current", query: "?storeReference=" + id(19) }))
      .status,
  ).toBe(403);
  expect(
    (
      await send(root, {
        method: "GET",
        route: "current",
        query: "?storeReference=" + id(3) + "&extra=1",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send(root, {
        method: "GET",
        route: "current",
        query: "?storeReference=" + id(3) + "&storeReference=" + id(3),
      })
    ).status,
  ).toBe(403);
  expect(port.current).not.toHaveBeenCalled();
});
it("unconfigured service and malformed returned output remain bounded unavailable", async () => {
  expect((await send(await serve())).status).toBe(503);
  const port = endpoints();
  port.execute.mockResolvedValue({ secret: "must-not-leak" } as never);
  const reply = await send(await serve(port));
  expect(reply.status).toBe(503);
  expect(reply.raw).not.toContain("must-not-leak");
});
it("does not accept another original receipt from a service", async () => {
  const port = endpoints();
  port.resolve.mockResolvedValue({ ...receipt(true), operationReference: scope.tenantReference });
  expect(
    (await send(await serve(port), { route: "resolve-original", body: resolveCommand() })).status,
  ).toBe(503);
});

it("bootstraps actual Tax scope from selected Store without invented Tenant or Actor", async () => {
  const port = endpoints(),
    customHeaders = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== "X-BOP-Store-Setup-Scope"),
    );
  const reply = await send(await serve(port), {
    method: "GET",
    route: "scope",
    query: "?storeReference=" + id(3),
    customHeaders,
  });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(workspace);
  expect(port.current).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
    configurationReference: null,
  });
  expect(
    (
      await send(await serve(port), {
        method: "GET",
        route: "scope",
        query: "?storeReference=" + id(3),
      })
    ).status,
  ).toBe(403);
});
it("returns actual bounded registry choices without tax approval claims", async () => {
  const port = endpoints();
  const reply = await send(await serve(port), {
    method: "GET",
    route: "classifications",
    query: "?storeReference=" + id(3),
  });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(classifications());
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(port.classifications).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedScope: scope,
    expectedStoreReference: id(3),
  });
});
it("simulates exact saved Draft pins without issuing a write", async () => {
  const port = endpoints(),
    body = simulationCommand();
  const reply = await send(await serve(port), { route: "simulate", body });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(simulated());
  expect(port.simulate).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    expectedScope: scope,
    command: body,
  });
  expect(port.execute).not.toHaveBeenCalled();
});
it("refuses a simulation packet from another saved version or fixture", async () => {
  const port = endpoints();
  port.simulate.mockResolvedValue({ ...simulated(), versionReference: scope.storeReference });
  const reply = await send(await serve(port), { route: "simulate", body: simulationCommand() });
  expect(reply.status).toBe(503);
});
it("refuses authority injection and missing CSRF on mechanical simulation", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect(
    (
      await send(root, {
        route: "simulate",
        body: { ...simulationCommand(), professionalEvidence: { result: "Pass" } },
      })
    ).status,
  ).toBe(400);
  const customHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== "X-BOP-CSRF"),
  );
  expect(
    (await send(root, { route: "simulate", body: simulationCommand(), customHeaders })).status,
  ).toBe(403);
  expect(port.simulate).not.toHaveBeenCalled();
});
it("preserves actual Disabled capability distinctly from an unavailable definition", async () => {
  const port = endpoints();
  port.current.mockRejectedValue(new MerchantTaxConfigFeatureDisabled());
  const customHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== "X-BOP-Store-Setup-Scope"),
  );
  const reply = await send(await serve(port), {
    method: "GET",
    route: "scope",
    query: "?storeReference=" + id(3),
    customHeaders,
  });
  expect(reply.status).toBe(503);
  expect(reply.body).toEqual({ error: "tax_config_authoring_feature_disabled" });
});

it("shows Tax navigation only after actual current admission and removes refused configured entries", async () => {
  const port = endpoints(),
    base = await serve(port);
  const sessionRequest = (root: string) =>
    send(root, {
      method: "GET",
      route: "session",
      customHeaders: { ...headers, Cookie: "__Host-bop-merchant=controlled-session" },
    });
  const navigation = (body: unknown) => {
    if (!body || typeof body !== "object") throw Error("Expected bootstrap");
    return parseMerchantWorkspaceSnapshot(Reflect.get(body, "workspace")).navigation;
  };
  const enabled = await sessionRequest(base);
  expect(enabled.status).toBe(200);
  expect(navigation(enabled.body)).toEqual([
    {
      screenId: "TAX-CONFIG",
      label: "Tax",
      href: "/app/commerce/tax",
      permission: "pricing.tax-config.manage",
    },
  ]);
  expect(port.current).toHaveBeenCalledWith({
    sessionCookie: "controlled-session",
    expectedStoreReference: scope.storeReference,
    configurationReference: null,
  });
  for (const error of [
    new MerchantTaxConfigFeatureDisabled(),
    new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED"),
  ]) {
    vi.mocked(port.current).mockRejectedValueOnce(error);
    const denied = await sessionRequest(base);
    expect(denied.status).toBe(200);
    expect(navigation(denied.body)).toEqual([]);
  }
  expect(navigation((await sessionRequest(await serve())).body)).toEqual([]);
});

function materialCommand() {
  return parseTaxConfigMaterialCommand({
    action: "CreateMaterial",
    operationReference: id(60),
    materialReference: null,
    expectedRevision: null,
    materialKind: "RegistrationApplicability",
    content: {
      operatingEntityProfileVersionReference: id(61),
      operatingEntityTaxReference: null,
      jurisdictionCode: "CA-ON",
      applicability: "NotApplicable",
      sourceIssuedAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
      declaredSourceDigest: null,
    },
  });
}
function materialVersion() {
  const c = materialCommand();
  return parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    materialReference: id(62),
    versionReference: id(63),
    revision: 1,
    previousVersionReference: null,
    materialKind: c.materialKind,
    content: c.content,
    contentDigest: taxConfigMaterialContentDigest(c.content, c.materialKind),
    recordedByActorReference: scope.actorReference,
    createdAt: at,
    recordedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
}
function materialCurrent() {
  return parseTaxConfigMaterialCurrent({
    profile: "TaxConfigMaterialCurrentV1",
    ...scope,
    materialReference: id(62),
    materialKind: "RegistrationApplicability",
    version: materialVersion(),
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  });
}
function materialResolveCommand() {
  const c = materialCommand();
  return {
    action: c.action,
    operationReference: c.operationReference,
    materialReference: c.materialReference,
    expectedRevision: c.expectedRevision,
    materialKind: c.materialKind,
    intentDigest: taxConfigMaterialIntentDigest(scope, c),
  };
}
function materialReceipt(abandoned = false) {
  return parseTaxConfigMaterialOperation({
    profile: "TaxConfigMaterialOperationV1",
    ...scope,
    ...materialResolveCommand(),
    command: abandoned ? null : materialCommand(),
    outcome: abandoned ? "Abandoned" : "Committed",
    version: abandoned ? null : materialVersion(),
    auditReference: id(64),
    eventReference: abandoned ? null : id(65),
    occurredAt: at,
  });
}
it.each(["commands", "resolve-original"] as const)(
  "material %s preserves original exact intent and nullable source",
  async (kind) => {
    const port = endpoints(),
      r = await send(await serve(port), {
        route: kind === "commands" ? "materials/commands" : "materials/resolve-original",
        body: kind === "commands" ? materialCommand() : materialResolveCommand(),
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(materialReceipt(kind === "resolve-original"));
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(
      kind === "commands" ? port.materialExecute : port.materialResolve,
    ).toHaveBeenCalledOnce();
  },
);
it.each(["current", "version", "roster"] as const)("reads exact material %s pins", async (mode) => {
  const port = endpoints();
  const selection =
    mode === "current"
      ? "&materialReference=" + id(62)
      : mode === "version"
        ? "&versionReference=" + id(63)
        : "";
  const r = await send(await serve(port), {
    method: "GET",
    route:
      mode === "current"
        ? "materials/current"
        : mode === "version"
          ? "materials/version"
          : "materials/roster",
    query: "?storeReference=" + id(3) + "&materialKind=RegistrationApplicability" + selection,
  });
  expect(r.status).toBe(200);
  expect(
    mode === "current"
      ? port.materialCurrent
      : mode === "version"
        ? port.materialVersion
        : port.materialRoster,
  ).toHaveBeenCalledOnce();
});
it("refuses foreign output pins instead of returning another material", async () => {
  const port = endpoints();
  const r = await send(await serve(port), {
    method: "GET",
    route: "materials/current",
    query:
      "?storeReference=" +
      id(3) +
      "&materialKind=RegistrationApplicability&materialReference=" +
      id(66),
  });
  expect(r.status).toBe(503);
  expect(r.raw).not.toContain(id(62));
});
it("refuses incomplete or actor-injected material body before source access", async () => {
  const port = endpoints(),
    root = await serve(port);
  for (const body of [
    { ...materialCommand(), actorReference: id(4) },
    {
      ...materialCommand(),
      content: { ...materialCommand().content, jurisdictionProfileReference: id(70) },
    },
  ]) {
    const r = await send(root, { route: "materials/commands", body });
    expect(r.status).toBe(400);
  }
  expect(port.materialExecute).not.toHaveBeenCalled();
});
it("refuses wrong store, unknown selector and missing history pin", async () => {
  const port = endpoints(),
    root = await serve(port);
  for (const query of [
    "?storeReference=" + id(90) + "&materialKind=RegistrationApplicability",
    "?storeReference=" + id(3) + "&materialKind=RegistrationApplicability&actorReference=" + id(4),
    "?storeReference=" + id(3) + "&materialKind=RegistrationApplicability",
  ]) {
    const r = await send(root, { method: "GET", route: "materials/version", query });
    expect([400, 403]).toContain(r.status);
  }
  expect(port.materialVersion).not.toHaveBeenCalled();
});
it("keeps material CSRF and origin barriers", async () => {
  const port = endpoints(),
    root = await serve(port);
  for (const customHeaders of [
    { ...headers, "X-BOP-CSRF": "bad" },
    { ...headers, Origin: "https://foreign.invalid" },
  ]) {
    const r = await send(root, {
      route: "materials/commands",
      body: materialCommand(),
      customHeaders,
    });
    expect(r.status).toBe(403);
  }
  expect(port.materialExecute).not.toHaveBeenCalled();
});
it("refuses oversized material before provider access", async () => {
  const port = endpoints();
  const r = await send(await serve(port), {
    route: "materials/commands",
    text: JSON.stringify({ content: "x".repeat(1_060_000) }),
  });
  expect(r.status).toBe(413);
  expect(port.materialExecute).not.toHaveBeenCalled();
});
it("tax registrant absence does not invent a registration", async () => {
  const port = endpoints();
  const r = await send(await serve(port), {
    method: "GET",
    route: "tax-registrant",
    query: "?storeReference=" + id(3),
  });
  expect(r.status).toBe(200);
  expect(r.body).toBeNull();
  expect(port.taxRegistrant).toHaveBeenCalledOnce();
});
it("rejects forged registrant qualification and secret fields", async () => {
  const port = endpoints();
  port.taxRegistrant.mockResolvedValue({
    profile: "TaxRegistrantCurrentSourceV1",
    ...scope,
    qualification: "Verified",
    secret: "unsafe",
  } as never);
  const r = await send(await serve(port), {
    method: "GET",
    route: "tax-registrant",
    query: "?storeReference=" + id(3),
  });
  expect(r.status).toBe(503);
  expect(r.raw).not.toContain("unsafe");
});
it("returns the genuine bounded registrant packet with missing tax reference", async () => {
  const port = endpoints();
  const source = {
    profile: "TaxRegistrantCurrentSourceV1" as const,
    ...scope,
    businessFunction: "TaxRegistrant" as const,
    effectiveAt: at,
    assignmentReference: id(80),
    assignmentVersion: 1,
    effectiveFrom: at,
    effectiveUntil: null,
    operatingEntityReference: id(81),
    entityVersion: 1,
    operatingEntityProfileVersionReference: id(82),
    profileVersion: 7,
    legalName: "Controlled Entity",
    jurisdictionCode: "CA-ON" as const,
    registrationReference: null,
    taxRegistrationReference: null,
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated" as const,
  };
  port.taxRegistrant.mockResolvedValue(source);
  const result = await send(await serve(port), {
    method: "GET",
    route: "tax-registrant",
    query: "?storeReference=" + id(3),
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual(source);
  port.taxRegistrant.mockResolvedValue({ ...source, actorReference: id(99) });
  const foreign = await send(await serve(port), {
    method: "GET",
    route: "tax-registrant",
    query: "?storeReference=" + id(3),
  });
  expect(foreign.status).toBe(503);
  expect(foreign.raw).not.toContain(id(99));
});

function candidateFixture(operationReference = id(81)) {
  const snapshot = receipt().snapshot;
  if (!snapshot) throw Error("Controlled Draft missing");
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: scope.actorReference,
    snapshot,
  });
  const material = materialVersion(),
    registrationMaterial = {
      materialReference: material.materialReference,
      versionReference: material.versionReference,
      contentDigest: material.contentDigest,
    };
  const candidate = createTaxPublicationCandidate({
    draft,
    targetVersionReference: id(80),
    sourceRuleBindings: [],
    registrationMaterial,
  });
  const command = parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference,
    configurationReference: snapshot.configurationReference,
    expectedDraft: candidate.content.baseDraft,
    registrationMaterial,
  });
  const record = createTaxConfigCandidateRecord({
    scope,
    command,
    candidate,
    draft,
    registrationMaterial: material,
    preparedAt: at,
    auditReference: id(82),
    eventReference: id(83),
  });
  return { command, record };
}
function candidateReceipt(abandoned = false, operationReference = id(81)) {
  const { command, record } = candidateFixture(operationReference);
  return parseTaxConfigCandidateOperation({
    profile: "TaxConfigCandidateOperationV1",
    ...scope,
    ...command,
    command: abandoned ? null : command,
    intentDigest: taxConfigCandidateIntentDigest(scope, command),
    outcome: abandoned ? "Abandoned" : "Committed",
    result: abandoned ? null : record,
    auditReference: record.auditReference,
    eventReference: abandoned ? null : record.eventReference,
    occurredAt: at,
  });
}
function candidateResolveCommand() {
  const c = candidateFixture().command;
  return { ...c, intentDigest: taxConfigCandidateIntentDigest(scope, c) };
}
function candidateCurrent() {
  const { command, record } = candidateFixture();
  return parseTaxConfigCandidateCurrent({
    profile: "TaxConfigCandidateCurrentV1",
    ...scope,
    configurationReference: command.configurationReference,
    targetVersionReference: record.candidate.content.targetVersionReference,
    record,
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  });
}
function candidateRoster() {
  const { record } = candidateFixture(),
    c = record.candidate.content;
  return parseTaxConfigCandidateRoster({
    profile: "TaxConfigCandidateRosterV1",
    ...scope,
    configurationReference: c.configurationReference,
    afterCandidate: null,
    entries: [
      parseTaxConfigCandidateSummary({
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        configurationReference: c.configurationReference,
        targetVersionReference: c.targetVersionReference,
        targetAggregateVersion: c.targetAggregateVersion,
        targetVersionNumber: c.targetVersionNumber,
        contentDigest: record.candidate.contentDigest,
        baseDraft: c.baseDraft,
        registrationMaterial: c.registrationMaterial,
        preparedByActorReference: record.preparedByActorReference,
        operationReference: record.operationReference,
        preparedAt: record.preparedAt,
        status: "Recorded",
        qualification: "NotEvaluated",
      }),
    ],
    nextAfterCandidate: null,
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  });
}
it.each(["current", "roster"] as const)(
  "reads actual candidate %s and its latest saved pins over HTTP",
  async (mode) => {
    const port = endpoints();
    const reply = await send(await serve(port), {
      method: "GET",
      route: mode === "current" ? "candidates/current" : "candidates/roster",
      query:
        "?storeReference=" +
        scope.storeReference +
        "&configurationReference=" +
        candidateFixture().command.configurationReference,
    });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.body).toEqual(mode === "current" ? candidateCurrent() : candidateRoster());
    expect(mode === "current" ? port.candidateCurrent : port.candidateRoster).toHaveBeenCalledWith({
      sessionCookie: cookie,
      expectedScope: scope,
      expectedStoreReference: scope.storeReference,
      configurationReference: candidateFixture().command.configurationReference,
      ...(mode === "current" ? { targetVersionReference: null } : { afterCandidate: null }),
    });
  },
);
it.each([false, true])(
  "prepares or resolves exact candidate original (Resolve=%s), without qualified claims",
  async (resolving) => {
    const port = endpoints();
    const c = resolving ? candidateResolveCommand() : candidateFixture().command;
    const reply = await send(await serve(port), {
      route: resolving ? "candidates/resolve-original" : "candidates/commands",
      body: c,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(candidateReceipt(resolving));
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(resolving ? port.candidateResolve : port.candidatePrepare).toHaveBeenCalledWith({
      sessionCookie: cookie,
      csrf,
      expectedScope: scope,
      command: c,
    });
  },
);
it("refuses mismatched candidate original nonce and source pins from an otherwise parsed output", async () => {
  const port = endpoints(),
    root = await serve(port);
  port.candidatePrepare.mockResolvedValue(candidateReceipt(false, id(99)));
  expect(
    (await send(root, { route: "candidates/commands", body: candidateFixture().command })).status,
  ).toBe(503);
  port.candidatePrepare.mockResolvedValue(candidateReceipt());
  const c = candidateFixture().command;
  expect(
    (
      await send(root, {
        route: "candidates/commands",
        body: {
          ...c,
          expectedDraft: {
            ...c.expectedDraft,
            snapshotDigest: parsePricingDigest("sha256:" + "f".repeat(64)),
          },
        },
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await send(root, {
        route: "candidates/commands",
        body: {
          ...c,
          registrationMaterial: {
            ...c.registrationMaterial,
            contentDigest: parsePricingDigest("sha256:" + "e".repeat(64)),
          },
        },
      })
    ).status,
  ).toBe(503);
});
it("requires explicit historical target and candidate page outputs to match requested pins and scope", async () => {
  const port = endpoints(),
    root = await serve(port),
    q =
      "?storeReference=" +
      scope.storeReference +
      "&configurationReference=" +
      candidateFixture().command.configurationReference;
  expect(
    (
      await send(root, {
        method: "GET",
        route: "candidates/current",
        query: q + "&targetVersionReference=" + id(99),
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await send(root, {
        method: "GET",
        route: "candidates/roster",
        query: q + "&afterCandidate=" + id(99),
      })
    ).status,
  ).toBe(503);
  port.candidateCurrent.mockResolvedValue({
    ...candidateCurrent(),
    actorReference: parsePricingReference(id(99)),
  });
  expect((await send(root, { method: "GET", route: "candidates/current", query: q })).status).toBe(
    503,
  );
});
it("rejects unknown candidate query fields, scope mismatch, missing configuration and repeated selectors before providers", async () => {
  const port = endpoints(),
    root = await serve(port),
    config = candidateFixture().command.configurationReference;
  for (const query of [
    "?storeReference=" + scope.storeReference,
    "?storeReference=" + id(99) + "&configurationReference=" + config,
    "?storeReference=" +
      scope.storeReference +
      "&configurationReference=" +
      config +
      "&qualified=true",
    "?storeReference=" +
      scope.storeReference +
      "&configurationReference=" +
      config +
      "&targetVersionReference=" +
      id(80) +
      "&targetVersionReference=" +
      id(81),
  ])
    expect(
      (await send(root, { method: "GET", route: "candidates/current", query })).status,
    ).toBeGreaterThanOrEqual(400);
  expect(port.candidateCurrent).not.toHaveBeenCalled();
});
it("refuses candidate body authority/content injection and malformed Resolve hash before owner calls", async () => {
  const port = endpoints(),
    root = await serve(port),
    c = candidateFixture().command;
  for (const body of [
    { ...c, actorReference: id(99) },
    { ...c, content: { rate: "0.13" } },
    { ...c, expectedDraft: { ...c.expectedDraft, aggregateVersion: 0 } },
  ])
    expect((await send(root, { route: "candidates/commands", body })).status).toBe(400);
  expect(
    (
      await send(root, {
        route: "candidates/resolve-original",
        body: { ...candidateResolveCommand(), intentDigest: "invalid" },
      })
    ).status,
  ).toBe(400);
  expect(port.candidatePrepare).not.toHaveBeenCalled();
  expect(port.candidateResolve).not.toHaveBeenCalled();
});
it("preserves candidate CSRF/origin/scope-header barriers and eight-KiB control transport budget", async () => {
  const port = endpoints(),
    root = await serve(port),
    c = candidateFixture().command;
  for (const customHeaders of [
    Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "X-BOP-CSRF")),
    { ...headers, Origin: "https://foreign.invalid" },
    Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "X-BOP-Store-Setup-Scope")),
  ])
    expect(
      (await send(root, { route: "candidates/commands", body: c, customHeaders })).status,
    ).toBe(403);
  expect(
    (
      await send(root, {
        route: "candidates/commands",
        text: JSON.stringify({ ...c, padding: "x".repeat(9000) }),
      })
    ).status,
  ).toBe(413);
  expect(port.candidatePrepare).not.toHaveBeenCalled();
});

// Controlled read result: this tests the HTTP boundary, not calculation or source qualification.
function materialComparisonCommand() {
  const { command, record } = candidateFixture();
  return parseMerchantTaxConfigMaterialComparisonCommand({
    configurationReference: command.configurationReference,
    targetPublicationCandidate: {
      versionReference: record.candidate.content.targetVersionReference,
      contentDigest: record.candidate.contentDigest,
    },
    fixtureSuiteMaterial: {
      materialReference: id(90),
      versionReference: id(91),
      contentDigest: "sha256:" + "d".repeat(64),
    },
  });
}
function materialComparison(matches = true) {
  const c = materialComparisonCommand(),
    actualDigest = "sha256:" + "e".repeat(64);
  return parseTaxConfigMaterialComparison({
    profile: "TaxConfigMaterialComparisonV1",
    ...scope,
    comparison: {
      profile: "TaxConfigCandidateFixtureComparisonV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      candidate: c.targetPublicationCandidate,
      suite: c.fixtureSuiteMaterial,
      cases: [
        {
          fixtureReference: id(92),
          matches,
          actualDigest,
          expectedDigest: matches ? actualDigest : "sha256:" + "f".repeat(64),
          mismatchedFields: matches ? [] : ["taxAmountMinor", "grossAmountMinor"],
        },
      ],
      allCasesMatched: matches,
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    },
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  });
}
it.each([true, false])(
  "compares stored material with exact pins and returns mechanical match=%s without qualification",
  async (matches) => {
    const port = endpoints(),
      command = materialComparisonCommand();
    port.materialCompare.mockResolvedValue(materialComparison(matches));
    const reply = await send(await serve(port), { route: "materials/compare", body: command });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.body).toEqual(materialComparison(matches));
    expect(port.materialCompare).toHaveBeenCalledWith({
      sessionCookie: cookie,
      csrf,
      expectedScope: scope,
      command,
    });
    expect(reply.raw).not.toContain('"fixture":');
    expect(reply.raw).not.toContain('"declaredIssuer":');
  },
);
it("refuses open comparison bodies and unsafe authority headers before invoking the read port", async () => {
  const port = endpoints(),
    root = await serve(port),
    command = materialComparisonCommand();
  for (const body of [
    { ...command, approved: true },
    {
      ...command,
      fixtureSuiteMaterial: { ...command.fixtureSuiteMaterial, materialKind: "FixtureSuite" },
    },
    { ...command, configurationReference: "arbitrary" },
  ])
    expect((await send(root, { route: "materials/compare", body })).status).toBe(400);
  expect(
    (
      await send(root, {
        route: "materials/compare",
        body: command,
        customHeaders: { ...headers, "x-bop-csrf": "wrong" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await send(root, { route: "materials/compare", body: command, query: "?leak=1" })).status,
  ).toBe(403);
  expect(port.materialCompare).not.toHaveBeenCalled();
});
it.each(["scope", "candidate", "suite", "shape"] as const)(
  "rejects foreign or malformed comparison output %s without disclosing it",
  async (drift) => {
    const port = endpoints(),
      root = await serve(port),
      valid = materialComparison();
    const wrong =
      drift === "scope"
        ? { ...valid, actorReference: id(99) }
        : drift === "candidate"
          ? {
              ...valid,
              comparison: {
                ...valid.comparison,
                candidate: { ...valid.comparison.candidate, versionReference: id(99) },
              },
            }
          : drift === "suite"
            ? {
                ...valid,
                comparison: {
                  ...valid.comparison,
                  suite: { ...valid.comparison.suite, materialReference: id(99) },
                },
              }
            : {
                ...valid,
                comparison: { ...valid.comparison, professionalReviewStatus: "Approved" },
              };
    port.materialCompare.mockResolvedValue(wrong as typeof valid);
    const reply = await send(root, {
      route: "materials/compare",
      body: materialComparisonCommand(),
    });
    expect(reply.status).toBe(503);
    expect(reply.raw).not.toContain(id(99));
    expect(reply.raw).not.toContain("Approved");
  },
);
it("uses finite comparison unavailable errors and a small request budget", async () => {
  const port = endpoints(),
    root = await serve(port);
  port.materialCompare.mockRejectedValue(new Error("restricted material source " + id(99)));
  const failed = await send(root, {
    route: "materials/compare",
    body: materialComparisonCommand(),
  });
  expect(failed.status).toBe(503);
  expect(failed.raw).not.toContain(id(99));
  port.materialCompare.mockClear();
  const oversized = await send(root, {
    route: "materials/compare",
    text: " ".repeat(9000) + JSON.stringify(materialComparisonCommand()),
  });
  expect(oversized.status).toBe(413);
  expect(port.materialCompare).not.toHaveBeenCalled();
});
