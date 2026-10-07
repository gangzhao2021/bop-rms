import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createApp } from "./app.js";
import type { MerchantBffRouterOptions, MerchantBffService } from "./merchant-bff.js";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import { parseProductOptionBinding } from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  materializeOptionPriceVersion,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  optionPriceWireSnapshot,
  optionPriceWireState,
  parsePricingReference,
  parseCurrencyCode,
  parsePricingDigest,
  OptionPriceAuthoringError,
} from "@rms/pricing";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type {
  MerchantOptionPriceAuthoringResult,
  MerchantOptionPriceAuthoringQueryResult,
} from "./merchant-option-price-authoring-command.js";
import type {
  MerchantOptionPriceReviewResult,
  MerchantOptionPriceReviewCurrent,
} from "./merchant-option-price-review-command.js";

// Actual App middleware and BFF. Invocation/results are controlled public host
// seams; this suite does not certify native IAM, policy, approval or persistence.
const id = (n: number) => "01902421-7990-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64),
  scope = { brandReference: id(2), storeReference: id(3) },
  csrf = Buffer.alloc(32, 1).toString("base64url"),
  cookie = Buffer.alloc(32, 2).toString("base64url"),
  headers = {
    Host: "merchant.invalid",
    Origin: "https://merchant.invalid",
    "Sec-Fetch-Site": "same-origin",
    Cookie: "__Host-bop-merchant=" + cookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
    "X-BOP-Catalog-Scope": Buffer.from(JSON.stringify(scope)).toString("base64url"),
  };
const currency = createCurrencyMetadataSnapshot({
    currencyCode: parseCurrencyCode("CAD"),
    minorUnitExponent: 2,
    metadataVersion: 1,
    metadataVersionReference: parsePricingReference(id(8)),
    metadataDigest: parsePricingDigest(digest),
  }),
  command = parseOptionPriceAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(20),
    ruleReference: id(21),
    expectedAggregateVersion: null,
    bindingReference: id(22),
    optionReference: id(23),
    content: {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "125",
      includedQuantity: 1,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  }),
  version = materializeOptionPriceVersion({
    command,
    current: null,
    brandReference: id(2),
    versionReference: id(24),
    occurredAt: at,
    currencyMetadata: currency,
  }),
  state = parseOptionPriceAuthoringState({
    profile: "OptionPriceAuthoringStateV1",
    brandReference: id(2),
    ruleReference: id(21),
    bindingReference: id(22),
    optionReference: id(23),
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(4),
    updatedAt: at,
    draftAuthorActorReference: id(4),
    draft: optionPriceWireSnapshot(version),
    currentPublished: null,
    latestVersion: optionPriceWireSnapshot(version),
  }),
  anchor = { productReference: id(30), expectedProductAggregateVersion: 2 },
  currentAnchor = { ...anchor, bindingReference: id(22), optionReference: id(23) };
const receipt: MerchantOptionPriceAuthoringResult = {
  profile: "MerchantOptionPriceAuthoringResultV1",
  action: command.action,
  operationReference: id(20),
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  outcome: "Committed",
  state: optionPriceWireState(state),
  occurredAt: at,
  observedAt: at,
  validUntil: until,
};
const current: MerchantOptionPriceAuthoringQueryResult = {
  profile: "MerchantOptionPriceAuthoringQueryV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  observedAt: at,
  validUntil: until,
  states: [optionPriceWireState(state)],
  context: {
    profile: "MerchantOptionPriceContextV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    productReference: id(30),
    productAggregateVersion: 2,
    productVersionReference: id(31),
    productSnapshotDigest: digest,
    binding: parseProductOptionBinding({
      bindingReference: id(22),
      optionSetReference: id(32),
      optionSetVersionReference: id(33),
      purpose: "EXTRAS",
      sortOrder: 0,
      enabledOptionReferences: [id(23)],
      defaultSelections: [],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    }),
    versionResolution: "CurrentPublished",
    optionReference: id(23),
    optionSetReference: id(32),
    optionSetVersionReference: id(33),
    optionSourceDigest: digest,
    optionSourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic" },
    choices: [
      {
        optionReference: id(23),
        stableCode: "CHOICE",
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic" },
      },
    ],
    skus: [],
    currencyMetadata: currency,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    observedAt: at,
    validUntil: until,
  },
};
const session = createAuthenticationSession({
  sessionReference: id(5),
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
async function serve(
  port?: MerchantBffRouterOptions["optionPriceAuthoring"],
  review?: MerchantBffRouterOptions["optionPriceReview"],
) {
  const unused = async (): Promise<never> => {
      throw new Error("Unconfigured unrelated service");
    },
    service: MerchantBffService = {
      start: unused,
      callback: unused,
      bootstrap: unused,
      authorize: vi.fn(async () => session),
      logout: unused,
      switchStore: unused,
    },
    app = createApp({
      merchantBff: {
        service,
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(port ? { optionPriceAuthoring: port } : {}),
        ...(review ? { optionPriceReview: review } : {}),
      },
    }),
    server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener unavailable");
  return "http://127.0.0.1:" + address.port;
}
async function send(
  root: string,
  mode: string,
  body: unknown,
  customHeaders: Readonly<Record<string, string | string[]>> = headers,
  text?: string,
) {
  return new Promise<{ status: number; headers: Headers; body: unknown; raw: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        new URL("/merchant/pricing/option-prices/" + mode, root),
        { method: "POST", headers: customHeaders },
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
      outgoing.end(text ?? JSON.stringify(body));
    },
  );
}
const priceScope = {
  profile: "MerchantOptionPriceScopeV1" as const,
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  observedAt: at,
  validUntil: until,
};
function endpoints() {
  return {
    scope: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceAuthoring"]>["scope"]>(
      async () => priceScope,
    ),
    execute: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceAuthoring"]>["execute"]>(
      async () => receipt,
    ),
    resolve: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceAuthoring"]>["resolve"]>(
      async () => receipt,
    ),
    query: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceAuthoring"]>["query"]>(
      async () => current,
    ),
  };
}
it.each(["current", "command", "resolve"] as const)(
  "serves actual ordinary %s envelope and declared scoped response",
  async (mode) => {
    const port = endpoints(),
      root = await serve(port),
      body =
        mode === "current"
          ? { context: currentAnchor }
          : mode === "command"
            ? { command, context: anchor }
            : { command },
      result = await send(root, mode, body);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.body).toEqual(mode === "current" ? current : receipt);
    const input = { sessionCookie: cookie, csrf, expectedScope: scope };
    if (mode === "current")
      expect(port.query).toHaveBeenCalledExactlyOnceWith({ ...input, context: currentAnchor });
    else if (mode === "command")
      expect(port.execute).toHaveBeenCalledExactlyOnceWith({ ...input, command, context: anchor });
    else expect(port.resolve).toHaveBeenCalledExactlyOnceWith({ ...input, command });
  },
);
it("keeps immutable committed and true abandoned Resolve responses without a Product anchor", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect((await send(root, "resolve", { command })).body).toEqual(receipt);
  port.resolve.mockResolvedValueOnce({ ...receipt, outcome: "Abandoned", state: null });
  expect(await send(root, "resolve", { command })).toMatchObject({
    status: 200,
    body: { outcome: "Abandoned", state: null },
  });
  expect(port.query).not.toHaveBeenCalled();
  expect(port.execute).not.toHaveBeenCalled();
});
it.each(["current", "command", "resolve"])(
  "returns unavailable for unconfigured %s",
  async (mode) => {
    const root = await serve();
    expect(await send(root, mode, {})).toMatchObject({
      status: 503,
      body: { error: "option_price_unavailable" },
    });
  },
);
it.each([
  ["OPTION_PRICE_INPUT_INVALID", 400, "option_price_invalid"],
  ["OPTION_PRICE_PERMISSION_DENIED", 403, "request_denied"],
  ["OPTION_PRICE_VERSION_CONFLICT", 409, "option_price_conflict"],
  ["OPTION_PRICE_IDEMPOTENCY_CONFLICT", 409, "option_price_conflict"],
  ["OPTION_PRICE_LIFECYCLE_CONFLICT", 409, "option_price_conflict"],
  ["OPTION_PRICE_APPROVAL_REQUIRED", 409, "option_price_conflict"],
  ["OPTION_PRICE_CONFLICT", 409, "option_price_conflict"],
  ["OPTION_PRICE_DEPENDENCY_UNAVAILABLE", 503, "option_price_unavailable"],
] as const)("maps canonical %s to bounded HTTP", async (code, status, error) => {
  const port = endpoints();
  port.execute.mockRejectedValueOnce(new OptionPriceAuthoringError(code));
  const root = await serve(port),
    result = await send(root, "command", { command, context: anchor });
  expect(result).toMatchObject({ status, body: { error } });
  expect(result.headers.get("cache-control")).toBe("no-store");
});
it.each([
  new MerchantProductWriteFeatureDisabled(),
  new Error("private source body or credential"),
  Object.assign(new OptionPriceAuthoringError("OPTION_PRICE_DEPENDENCY_UNAVAILABLE"), {
    code: "UNKNOWN_SOURCE_CODE",
  }),
])("bounds Feature/unknown errors without confirming retry", async (error) => {
  const port = endpoints();
  port.execute.mockRejectedValueOnce(error);
  const root = await serve(port),
    reply = await send(root, "command", { command, context: anchor });
  expect(reply.status).toBe(error instanceof MerchantProductWriteFeatureDisabled ? 409 : 503);
  expect(reply.body).toEqual({
    error:
      error instanceof MerchantProductWriteFeatureDisabled
        ? "option_price_feature_disabled"
        : "option_price_unavailable",
  });
  expect(reply.raw).not.toContain("private");
});
it.each(["origin", "host", "csrf", "cookie", "scope", "duplicateScope", "query"])(
  "rejects %s before the owning invocation",
  async (reason) => {
    const port = endpoints(),
      root = await serve(port),
      altered: Record<string, string | string[]> = { ...headers };
    if (reason === "origin") altered.Origin = "https://foreign.invalid";
    if (reason === "host") altered.Host = "foreign.invalid";
    if (reason === "csrf") altered["X-BOP-CSRF"] = "invalid";
    if (reason === "cookie") delete altered.Cookie;
    if (reason === "scope") altered["X-BOP-Catalog-Scope"] = "invalid";
    if (reason === "duplicateScope")
      altered["X-BOP-Catalog-Scope"] = [
        headers["X-BOP-Catalog-Scope"],
        headers["X-BOP-Catalog-Scope"],
      ];
    const reply = await send(
      root,
      reason === "query" ? "command?unexpected=1" : "command",
      { command, context: anchor },
      altered,
    );
    expect(reply).toMatchObject({ status: 403, body: { error: "request_denied" } });
    expect(port.execute).not.toHaveBeenCalled();
  },
);
it.each([
  ["command", { command, context: anchor, actorReference: id(99) }],
  ["command", { command: { ...command, action: "Approve" }, context: anchor }],
  ["resolve", { command, context: anchor }],
  ["current", { context: { ...currentAnchor, optionReference: null } }],
  ["current", { context: { ...currentAnchor, policyReference: id(99) } }],
] as const)(
  "rejects nonclosed %s input without authorizing caller evidence",
  async (mode, body) => {
    const port = endpoints(),
      root = await serve(port);
    expect(await send(root, mode, body)).toMatchObject({
      status: 400,
      body: { error: "option_price_invalid" },
    });
    expect(port.execute).not.toHaveBeenCalled();
    expect(port.resolve).not.toHaveBeenCalled();
    expect(port.query).not.toHaveBeenCalled();
  },
);
it("enforces actual app eight KiB JSON and malformed request bounds", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect(await send(root, "command", {}, headers, '{"broken"')).toMatchObject({
    status: 400,
    body: { error: "option_price_invalid" },
  });
  expect(
    await send(root, "command", { command, context: anchor, padding: "x".repeat(9000) }),
  ).toMatchObject({ status: 413, body: { error: "option_price_invalid" } });
  expect(port.execute).not.toHaveBeenCalled();
});
it("refuses mismatched declared current/receipt scopes without echoing a source", async () => {
  const port = endpoints(),
    root = await serve(port);
  port.query.mockResolvedValueOnce({ ...current, storeReference: id(99) });
  expect(await send(root, "current", { context: currentAnchor })).toMatchObject({
    status: 503,
    body: { error: "option_price_unavailable" },
  });
  port.execute.mockResolvedValueOnce({ ...receipt, operationReference: id(99) });
  expect(await send(root, "command", { command, context: anchor })).toMatchObject({
    status: 503,
    body: { error: "option_price_unavailable" },
  });
});
it("preserves actual SKU labels whose Product locale differs from the Option locale", async () => {
  const port = endpoints(),
    root = await serve(port);
  port.query.mockResolvedValueOnce({
    ...current,
    context: {
      ...current.context,
      skus: [
        {
          skuReference: id(40),
          skuCode: "BASE",
          lifecycle: "Suspended",
          localizedNames: { "fr-CA": "Exemple" },
        },
      ],
    },
  });
  expect(await send(root, "current", { context: currentAnchor })).toMatchObject({
    status: 200,
    body: { context: { skus: [{ localizedNames: { "fr-CA": "Exemple" } }] } },
  });
});

const reviewCommand = {
  action: "SubmitReview",
  operationReference: id(90),
  ruleReference: id(21),
  draftVersionReference: id(91),
  draftSnapshotDigest: digest,
  expectedAggregateVersion: 1,
  validationValidUntil: "2026-10-06T12:00:00.000Z",
  approvalValidUntil: null,
  expectedLifecycle: null,
};
const reviewReceipt: MerchantOptionPriceReviewResult = {
  profile: "MerchantOptionPriceReviewResultV1",
  action: "SubmitReview",
  operationReference: id(90),
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  outcome: "Committed",
  occurredAt: at,
  observedAt: at,
  validUntil: until,
};
const reviewCurrent: MerchantOptionPriceReviewCurrent = {
  profile: "MerchantOptionPriceReviewCurrentV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  ruleReference: id(21),
  aggregateVersion: 1,
  draftVersionReference: id(91),
  draftSnapshotDigest: digest,
  draftAuthorActorReference: id(4),
  policy: {
    familyReference: id(94),
    policyReference: id(95),
    policyVersion: 1,
    approvalPolicy: "Required",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    currentPublicationReference: id(96),
  },
  review: {
    outcome: "Recorded",
    lifecycle: {
      lifecycleReference: id(92),
      version: 2,
      state: "InReview",
      latestMutationOperationReference: id(93),
    },
    validationValidUntil: "2026-10-05T11:30:00.000Z",
    approvalValidUntil: null,
    submittedActorReference: id(4),
    approvedActorReference: null,
    sourceAuthority: "RecordedHistory",
    qualification: "NotEvaluated",
  },
  observedAt: at,
  validUntil: until,
};
function reviewEndpoints() {
  return {
    query: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceReview"]>["query"]>(
      async () => reviewCurrent,
    ),
    execute: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceReview"]>["execute"]>(
      async () => reviewReceipt,
    ),
    resolve: vi.fn<NonNullable<MerchantBffRouterOptions["optionPriceReview"]>["resolve"]>(
      async () => reviewReceipt,
    ),
  };
}
it.each(["command", "resolve"] as const)(
  "connects ordinary review %s with exact original bytes",
  async (mode) => {
    const port = reviewEndpoints(),
      root = await serve(undefined, port),
      body =
        mode === "command"
          ? { command: reviewCommand, context: currentAnchor }
          : { command: reviewCommand };
    const response = await send(root, "review/" + mode, body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toEqual(reviewReceipt);
    const expected = { sessionCookie: cookie, csrf, expectedScope: scope, command: reviewCommand };
    if (mode === "command")
      expect(port.execute).toHaveBeenCalledExactlyOnceWith({ ...expected, context: currentAnchor });
    else expect(port.resolve).toHaveBeenCalledExactlyOnceWith(expected);
  },
);
it("returns actual abandoned review original without current context", async () => {
  const port = reviewEndpoints();
  port.resolve.mockResolvedValueOnce({ ...reviewReceipt, outcome: "Abandoned" });
  expect(
    await send(await serve(undefined, port), "review/resolve", { command: reviewCommand }),
  ).toMatchObject({ status: 200, body: { outcome: "Abandoned" } });
});
it("accepts independent Approve original and lifecycle tuple", async () => {
  const port = reviewEndpoints(),
    approved = {
      ...reviewCommand,
      action: "Approve",
      approvalValidUntil: reviewCommand.validationValidUntil,
      expectedLifecycle: {
        lifecycleReference: id(92),
        version: 2,
        state: "InReview",
        latestMutationOperationReference: id(93),
      },
    };
  port.execute.mockResolvedValueOnce({ ...reviewReceipt, action: "Approve" });
  expect(
    (
      await send(await serve(undefined, port), "review/command", {
        command: approved,
        context: currentAnchor,
      })
    ).status,
  ).toBe(200);
  expect(port.execute.mock.calls[0]?.[0].command).toEqual(approved);
});
it.each(["command", "resolve"])("fails closed for unconfigured review %s", async (mode) => {
  expect(
    (
      await send(
        await serve(),
        "review/" + mode,
        mode === "command"
          ? { command: reviewCommand, context: currentAnchor }
          : { command: reviewCommand },
      )
    ).status,
  ).toBe(503);
});
it.each([
  { command: { ...reviewCommand, actorReference: id(4) }, context: currentAnchor },
  { command: { ...reviewCommand, validationEvidence: {} }, context: currentAnchor },
  { command: { ...reviewCommand, expectedAggregateVersion: "1" }, context: currentAnchor },
  { command: { ...reviewCommand, action: "Approve" }, context: currentAnchor },
  { command: reviewCommand, context: { ...currentAnchor, optionReference: null } },
  { command: reviewCommand, context: { ...currentAnchor, tenantReference: id(1) } },
])("refuses untrusted review source or authority fields before invocation", async (body) => {
  const port = reviewEndpoints();
  expect((await send(await serve(undefined, port), "review/command", body)).status).toBe(400);
  expect(port.execute).not.toHaveBeenCalled();
});
it("refuses review Resolve qualification context and oversized command", async () => {
  const port = reviewEndpoints(),
    root = await serve(undefined, port);
  expect(
    (await send(root, "review/resolve", { command: reviewCommand, context: currentAnchor })).status,
  ).toBe(400);
  expect(
    (
      await send(
        root,
        "review/command",
        {},
        headers,
        JSON.stringify({
          command: reviewCommand,
          context: currentAnchor,
          padding: "x".repeat(8200),
        }),
      )
    ).status,
  ).toBe(413);
  expect(port.resolve).not.toHaveBeenCalled();
  expect(port.execute).not.toHaveBeenCalled();
});
it.each(["origin", "duplicateScope", "csrf"])(
  "holds review transport security for %s",
  async (reason) => {
    const port = reviewEndpoints(),
      altered: Record<string, string | string[]> = { ...headers };
    if (reason === "origin") altered.Origin = "https://foreign.invalid";
    if (reason === "duplicateScope")
      altered["X-BOP-Catalog-Scope"] = [
        headers["X-BOP-Catalog-Scope"],
        headers["X-BOP-Catalog-Scope"],
      ];
    if (reason === "csrf") altered["X-BOP-CSRF"] = "invalid";
    expect(
      (
        await send(
          await serve(undefined, port),
          "review/command",
          { command: reviewCommand, context: currentAnchor },
          altered,
        )
      ).status,
    ).toBe(403);
    expect(port.execute).not.toHaveBeenCalled();
  },
);
it.each([
  { ...reviewReceipt, operationReference: id(95) },
  { ...reviewReceipt, brandReference: id(95) },
  { ...reviewReceipt, validUntil: at },
  { ...reviewReceipt, approvalEvidence: {} },
])("bounds invalid review owner responses as unavailable", async (result) => {
  const port = reviewEndpoints();
  port.execute.mockResolvedValueOnce(result);
  expect(
    await send(await serve(undefined, port), "review/command", {
      command: reviewCommand,
      context: currentAnchor,
    }),
  ).toMatchObject({ status: 503, body: { error: "option_price_unavailable" } });
});
it.each([
  new OptionPriceAuthoringError("OPTION_PRICE_APPROVAL_REQUIRED"),
  new OptionPriceAuthoringError("OPTION_PRICE_PERMISSION_DENIED"),
  new Error("private policy evidence"),
])("bounds review errors without leaking authority", async (error) => {
  const port = reviewEndpoints();
  port.execute.mockRejectedValueOnce(error);
  const response = await send(await serve(undefined, port), "review/command", {
    command: reviewCommand,
    context: currentAnchor,
  });
  expect(response.status).toBe(
    error instanceof OptionPriceAuthoringError
      ? error.code === "OPTION_PRICE_PERMISSION_DENIED"
        ? 403
        : 409
      : 503,
  );
  expect(response.raw).not.toContain("private");
});
it("connects ordinary current review with the actual typed query and preserves original historical expiry", async () => {
  const port = reviewEndpoints(),
    root = await serve(undefined, port),
    result = await send(root, "review/current", { ruleReference: id(21), context: currentAnchor });
  expect(result).toMatchObject({ status: 200, body: reviewCurrent });
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(port.query).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    expectedScope: scope,
    ruleReference: id(21),
    context: currentAnchor,
  });
  expect(port.execute).not.toHaveBeenCalled();
  expect(port.resolve).not.toHaveBeenCalled();
});
it("exposes genuine NotRequired policy with actual absence without synthesizing approval", async () => {
  const port = reviewEndpoints();
  port.query.mockResolvedValueOnce({
    ...reviewCurrent,
    policy: { ...reviewCurrent.policy, approvalPolicy: "NotRequired" },
    review: { outcome: "Absent" },
  });
  expect(
    await send(await serve(undefined, port), "review/current", {
      ruleReference: id(21),
      context: currentAnchor,
    }),
  ).toMatchObject({
    status: 200,
    body: { policy: { approvalPolicy: "NotRequired" }, review: { outcome: "Absent" } },
  });
});
it.each(["Draft", "InReview", "Approved", "Published", "Archived", "Superseded"] as const)(
  "preserves actual recorded %s and different original Actors",
  async (state) => {
    const port = reviewEndpoints();
    if (reviewCurrent.review.outcome !== "Recorded") throw Error("recorded fixture required");
    const review = {
      ...reviewCurrent.review,
      lifecycle: { ...reviewCurrent.review.lifecycle, state },
      submittedActorReference: id(97),
      approvedActorReference: state === "Approved" ? id(98) : null,
      approvalValidUntil: state === "Approved" ? "2026-10-05T11:20:00.000Z" : null,
    };
    port.query.mockResolvedValueOnce({
      ...reviewCurrent,
      draftAuthorActorReference: id(99),
      review,
    });
    const result = await send(await serve(undefined, port), "review/current", {
      ruleReference: id(21),
      context: currentAnchor,
    });
    expect(result).toMatchObject({
      status: 200,
      body: { draftAuthorActorReference: id(99), review },
    });
  },
);
it("unconfigured ordinary current review fails unavailable without accepting synthetic query authority", async () => {
  expect(
    await send(await serve(), "review/current", { ruleReference: id(21), context: currentAnchor }),
  ).toMatchObject({ status: 503, body: { error: "option_price_unavailable" } });
});
it.each([
  { ruleReference: id(21), context: currentAnchor, policyReference: id(95) },
  { ruleReference: id(21), context: { ...currentAnchor, actorReference: id(4) } },
  { ruleReference: id(21), context: { ...currentAnchor, optionReference: null } },
  { ruleReference: id(21), context: { ...currentAnchor, bindingReference: null } },
  { ruleReference: id(21), context: { ...currentAnchor, expectedProductAggregateVersion: 0 } },
  { ruleReference: "foreign", context: currentAnchor },
])(
  "rejects malformed or authority-bearing current review request without calling source",
  async (body) => {
    const port = reviewEndpoints();
    expect((await send(await serve(undefined, port), "review/current", body)).status).toBe(400);
    expect(port.query).not.toHaveBeenCalled();
  },
);
it.each(["origin", "duplicateScope", "csrf", "query"] as const)(
  "holds real current review transport security for %s",
  async (reason) => {
    const port = reviewEndpoints(),
      altered: Record<string, string | string[]> = { ...headers };
    if (reason === "origin") altered.Origin = "https://foreign.invalid";
    if (reason === "duplicateScope")
      altered["X-BOP-Catalog-Scope"] = [
        headers["X-BOP-Catalog-Scope"],
        headers["X-BOP-Catalog-Scope"],
      ];
    if (reason === "csrf") altered["X-BOP-CSRF"] = "bad";
    expect(
      (
        await send(
          await serve(undefined, port),
          reason === "query" ? "review/current?extra=1" : "review/current",
          { ruleReference: id(21), context: currentAnchor },
          altered,
        )
      ).status,
    ).toBe(403);
    expect(port.query).not.toHaveBeenCalled();
  },
);
it("current review has the registered 8KiB control limit", async () => {
  const port = reviewEndpoints();
  expect(
    (
      await send(
        await serve(undefined, port),
        "review/current",
        {},
        headers,
        JSON.stringify({
          ruleReference: id(21),
          context: currentAnchor,
          padding: "x".repeat(8200),
        }),
      )
    ).status,
  ).toBe(413);
  expect(port.query).not.toHaveBeenCalled();
});
it.each([
  { ...reviewCurrent, ruleReference: id(99) },
  { ...reviewCurrent, brandReference: id(99) },
  { ...reviewCurrent, aggregateVersion: 0 },
  { ...reviewCurrent, draftSnapshotDigest: "invalid" },
  { ...reviewCurrent, draftAuthorActorReference: "invalid" },
  { ...reviewCurrent, policy: { ...reviewCurrent.policy, approvalPolicy: "Allow" } },
  { ...reviewCurrent, policy: { ...reviewCurrent.policy, policyVersion: 0 } },
  { ...reviewCurrent, policy: { ...reviewCurrent.policy, currentPublicationReference: "invalid" } },
  {
    ...reviewCurrent,
    policy: { ...reviewCurrent.policy, effectiveUntil: reviewCurrent.policy.effectiveFrom },
  },
  { ...reviewCurrent, review: { outcome: "Absent", approvalValidUntil: until } },
  { ...reviewCurrent, review: { ...reviewCurrent.review, qualification: "Pass" } },
  { ...reviewCurrent, review: { ...reviewCurrent.review, sourceAuthority: "Static" } },
  { ...reviewCurrent, review: { ...reviewCurrent.review, approvalValidUntil: until } },
  {
    ...reviewCurrent,
    review: {
      outcome: "Recorded",
      lifecycle: {
        lifecycleReference: id(92),
        version: 2,
        state: "Released",
        latestMutationOperationReference: id(93),
      },
      validationValidUntil: null,
      approvalValidUntil: null,
      submittedActorReference: null,
      approvedActorReference: null,
      sourceAuthority: "RecordedHistory",
      qualification: "NotEvaluated",
    },
  },
  { ...reviewCurrent, validUntil: at },
  { ...reviewCurrent, validUntil: "2026-10-05T12:00:06.000Z" },
  { ...reviewCurrent, auditBody: "private" },
])("bounds malformed current review source without manufacturing Empty or Pass", async (result) => {
  // Controlled malformed owner-port output exercises the BFF boundary, not source qualification.
  const port = reviewEndpoints();
  port.query.mockImplementationOnce(async () => {
    return result as MerchantOptionPriceReviewCurrent;
  });
  const reply = await send(await serve(undefined, port), "review/current", {
    ruleReference: id(21),
    context: currentAnchor,
  });
  expect(reply).toMatchObject({ status: 503, body: { error: "option_price_unavailable" } });
  expect(reply.raw).not.toContain("private");
});
it.each([
  ["OPTION_PRICE_INPUT_INVALID", 400, "option_price_invalid"],
  ["OPTION_PRICE_PERMISSION_DENIED", 403, "request_denied"],
  ["OPTION_PRICE_VERSION_CONFLICT", 409, "option_price_conflict"],
  ["OPTION_PRICE_DEPENDENCY_UNAVAILABLE", 503, "option_price_unavailable"],
] as const)("current review maps actual %s to finite HTTP", async (code, status, error) => {
  const port = reviewEndpoints();
  port.query.mockRejectedValueOnce(new OptionPriceAuthoringError(code));
  expect(
    await send(await serve(undefined, port), "review/current", {
      ruleReference: id(21),
      context: currentAnchor,
    }),
  ).toMatchObject({ status, body: { error } });
});
it.each([
  new MerchantProductWriteFeatureDisabled(),
  new Error("private source error"),
  Object.assign(new OptionPriceAuthoringError("OPTION_PRICE_DEPENDENCY_UNAVAILABLE"), {
    code: "UNKNOWN_SOURCE_CODE",
  }),
])("current review bounds Feature or unknown source errors", async (error) => {
  const port = reviewEndpoints();
  port.query.mockRejectedValueOnce(error);
  const reply = await send(await serve(undefined, port), "review/current", {
    ruleReference: id(21),
    context: currentAnchor,
  });
  expect(reply.status).toBe(error instanceof MerchantProductWriteFeatureDisabled ? 409 : 503);
  expect(reply.raw).not.toContain("private");
});
it("reads ordinary Pricing scope with exact empty body and current authenticated handler only", async () => {
  const port = endpoints(),
    result = await send(await serve(port), "scope", {});
  expect(result).toMatchObject({ status: 200, body: priceScope });
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(port.scope).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    expectedScope: scope,
  });
  expect(port.query).not.toHaveBeenCalled();
  expect(port.execute).not.toHaveBeenCalled();
  expect(port.resolve).not.toHaveBeenCalled();
});
it.each([{ context: currentAnchor }, { actorReference: id(4) }, { ruleReference: id(21) }])(
  "scope rejects qualification or caller identity data",
  async (body) => {
    const port = endpoints();
    expect((await send(await serve(port), "scope", body)).status).toBe(400);
    expect(port.scope).not.toHaveBeenCalled();
  },
);
it.each(["origin", "csrf", "query", "duplicateScope"] as const)(
  "scope retains actual transport protection for %s",
  async (reason) => {
    const port = endpoints(),
      altered: Record<string, string | string[]> = { ...headers };
    if (reason === "origin") altered.Origin = "https://foreign.invalid";
    if (reason === "csrf") altered["X-BOP-CSRF"] = "bad";
    if (reason === "duplicateScope")
      altered["X-BOP-Catalog-Scope"] = [
        headers["X-BOP-Catalog-Scope"],
        headers["X-BOP-Catalog-Scope"],
      ];
    expect(
      (await send(await serve(port), reason === "query" ? "scope?x=1" : "scope", {}, altered))
        .status,
    ).toBe(403);
    expect(port.scope).not.toHaveBeenCalled();
  },
);
it("scope remains configured-only and has the small registered JSON budget", async () => {
  expect((await send(await serve(), "scope", {})).status).toBe(503);
  const port = endpoints();
  expect(
    (
      await send(
        await serve(port),
        "scope",
        {},
        headers,
        JSON.stringify({ padding: "x".repeat(8200) }),
      )
    ).status,
  ).toBe(413);
  expect(port.scope).not.toHaveBeenCalled();
});
it.each([
  { ...priceScope, brandReference: id(99) },
  { ...priceScope, actorReference: "bad" },
  { ...priceScope, validUntil: at },
  { ...priceScope, validUntil: "2026-10-05T12:00:06.000Z" },
  { ...priceScope, context: currentAnchor },
])("scope bounds malformed source tuples without leaking content", async (value) => {
  const port = endpoints();
  port.scope.mockResolvedValueOnce(value);
  expect(await send(await serve(port), "scope", {})).toMatchObject({
    status: 503,
    body: { error: "option_price_unavailable" },
  });
});
it.each([
  ["OPTION_PRICE_PERMISSION_DENIED", 403],
  ["OPTION_PRICE_DEPENDENCY_UNAVAILABLE", 503],
] as const)("scope preserves finite actual %s", async (code, status) => {
  const port = endpoints();
  port.scope.mockRejectedValueOnce(new OptionPriceAuthoringError(code));
  expect((await send(await serve(port), "scope", {})).status).toBe(status);
});
