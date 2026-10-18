import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseSelectorHash } from "../contracts/browser-session.js";
import { createCognitoWorkforceInvitation } from "../infrastructure/cognito-workforce-invitation.js";

const sdk = vi.hoisted(() => ({ construct: vi.fn(), send: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>()),
  CognitoIdentityProviderClient: class {
    constructor(options: unknown) {
      sdk.construct(options);
    }
    send = sdk.send;
  },
}));
const actorReference = "01902421-1013-7000-8000-000000000001",
  username = `bop_${actorReference}`,
  subject = "opaque-provider-local-subject",
  creationIntentDigest = `sha256:${"a".repeat(64)}`,
  at = "2026-10-06T12:00:00.000Z",
  createdAt = "2026-10-06T12:00:00.001Z",
  later = "2026-10-06T12:00:00.002Z",
  configuration = {
    environment: "synthetic",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic1",
    clientId: "syntheticclient",
  },
  request = { actorReference, creationIntentDigest, corporateEmail: "Owner@Example.invalid" };
function user() {
  return {
    Username: username,
    Enabled: true,
    UserStatus: "FORCE_CHANGE_PASSWORD",
    UserCreateDate: new Date(createdAt),
    Attributes: [
      { Name: "sub", Value: subject },
      { Name: "email", Value: "owner@example.invalid" },
      { Name: "custom:bop_invitation_intent", Value: creationIntentDigest },
      { Name: "name", Value: "Discard PII" },
    ],
  };
}
function fixture(timeout = 4000) {
  let time = at;
  const options = {
    configuration: { ...configuration },
    clock: { now: () => time },
    hasher: {
      hash: (
        value: Parameters<
          Parameters<typeof createCognitoWorkforceInvitation>[0]["hasher"]["hash"]
        >[0],
      ) =>
        parseSelectorHash(
          createHmac("sha256", "synthetic-private-pepper").update(value).digest("hex"),
        ),
      equals: (
        left: Parameters<
          Parameters<typeof createCognitoWorkforceInvitation>[0]["hasher"]["equals"]
        >[0],
        right: Parameters<
          Parameters<typeof createCognitoWorkforceInvitation>[0]["hasher"]["equals"]
        >[1],
      ) => timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")),
    },
    requestTimeoutMs: timeout,
  };
  const source = createCognitoWorkforceInvitation(options);
  sdk.send.mockImplementation(async (command: unknown) => {
    time = later;
    if (command instanceof AdminCreateUserCommand)
      return { User: user(), $metadata: { requestId: "discard" } };
    const { Attributes, ...rest } = user();
    return { ...rest, UserAttributes: Attributes };
  });
  return {
    options,
    source,
    time: (value: string) => {
      time = value;
    },
    create: () => source.create(request),
  };
}
beforeEach(() => {
  sdk.send.mockReset();
  sdk.construct.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
async function original(f: ReturnType<typeof fixture>) {
  const created = await f.create();
  expect(created.status).toBe("Created");
  return {
    actorReference,
    creationIntentDigest,
    emailDigest: created.emailDigest,
    creationStartedAt: at,
    expectedSubject: subject,
    expectedCreatedAt: createdAt,
  };
}
it("prepares the same keyed email intent without contacting the Provider", async () => {
  const f = fixture();
  const digest = f.source.digestCorporateEmail(request.corporateEmail);
  expect(f.source.digestCorporateEmail("owner@example.invalid")).toBe(digest);
  expect(sdk.send).not.toHaveBeenCalled();
  expect((await f.create()).emailDigest).toBe(digest);
});

it("denies invalid email and captured hash/configuration drift before intent preparation", () => {
  const f = fixture();
  for (const value of [
    " owner@example.invalid",
    "not-an-email",
    null,
    { email: "owner@example.invalid" },
  ]) {
    expect(() => f.source.digestCorporateEmail(value)).toThrow("request denied");
  }
  const foreignHash = vi.fn(() => parseSelectorHash("f".repeat(64)));
  f.options.hasher.hash = foreignHash;
  expect(() => f.source.digestCorporateEmail(request.corporateEmail)).toThrow("request denied");
  expect(foreignHash).not.toHaveBeenCalled();
  const g = fixture();
  g.options.configuration.clientId = "otherclient";
  expect(() => g.source.digestCorporateEmail(request.corporateEmail)).toThrow("request denied");
  expect(sdk.send).not.toHaveBeenCalled();
});

it("uses the actual fixed Canadian SDK creation command without password, verified-email or client metadata", async () => {
  const f = fixture(),
    result = await f.create();
  expect(sdk.construct).toHaveBeenCalledWith({
    region: "ca-central-1",
    endpoint: "https://cognito-idp.ca-central-1.amazonaws.com",
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 4000, requestTimeout: 4000 },
  });
  const command = sdk.send.mock.calls[0]?.[0];
  if (!(command instanceof AdminCreateUserCommand))
    throw new Error("Expected actual create command");
  expect(command.input).toEqual({
    UserPoolId: "ca-central-1_Synthetic1",
    Username: username,
    DesiredDeliveryMediums: ["EMAIL"],
    ForceAliasCreation: false,
    UserAttributes: [
      { Name: "email", Value: "owner@example.invalid" },
      { Name: "custom:bop_invitation_intent", Value: creationIntentDigest },
    ],
  });
  expect(result).toMatchObject({
    status: "Created",
    dispatchAccepted: true,
    observedAt: at,
    validUntil: "2026-10-06T12:00:05.000Z",
    provider: { username, subject, createdAt, status: "FORCE_CHANGE_PASSWORD", enabled: true },
  });
  expect(result.emailDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.emailDigest).not.toBe(
    createHmac("sha256", "synthetic-private-pepper").update("owner@example.invalid").digest("hex"),
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.provider)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /example\.invalid|Discard|requestId|TemporaryPassword|delivered|Mfa/u,
  );
});
it("inspects an exact original Provider tuple without dispatching or inferring acceptance", async () => {
  const f = fixture(),
    expected = await original(f),
    result = await f.source.inspect(expected);
  const command = sdk.send.mock.calls[1]?.[0];
  if (!(command instanceof AdminGetUserCommand))
    throw new Error("Expected actual inspector command");
  expect(command.input).toEqual({ UserPoolId: "ca-central-1_Synthetic1", Username: username });
  expect(result.status).toBe("Found");
  expect(result.dispatchAccepted).toBeNull();
  expect(result.provider).toEqual({
    username,
    subject,
    createdAt,
    status: "FORCE_CHANGE_PASSWORD",
    enabled: true,
  });
  expect(
    sdk.send.mock.calls.filter(([command]) => command instanceof AdminCreateUserCommand),
  ).toHaveLength(1);
});
it("can observe an unknown original only from its immutable tag, email digest and original time floor", async () => {
  const f = fixture(),
    expected = await original(f);
  const result = await f.source.inspect({
    ...expected,
    expectedSubject: null,
    expectedCreatedAt: null,
  });
  expect(result.status).toBe("Found");
  expect(result.dispatchAccepted).toBeNull();
  expect(result.provider?.createdAt).toBe(createdAt);
});
it.each(["username", "subject", "date", "tag", "email", "federated", "before-original"])(
  "refuses %s mismatch without returning the other account or resending",
  async (kind) => {
    const f = fixture(),
      expected = await original(f),
      account = user();
    if (kind === "username") account.Username = "foreign-provider-username";
    if (kind === "subject") account.Attributes[0] = { Name: "sub", Value: "other-subject" };
    if (kind === "date") account.UserCreateDate = new Date(at);
    if (kind === "before-original") account.UserCreateDate = new Date("2026-10-06T11:59:59.999Z");
    if (kind === "tag")
      account.Attributes[2] = {
        Name: "custom:bop_invitation_intent",
        Value: `sha256:${"b".repeat(64)}`,
      };
    if (kind === "email") account.Attributes[1] = { Name: "email", Value: "other@example.invalid" };
    if (kind === "federated") account.Attributes.push({ Name: "identities", Value: "[]" });
    const { Attributes, ...rest } = account;
    sdk.send.mockResolvedValue({ ...rest, UserAttributes: Attributes });
    expect(await f.source.inspect(expected)).toMatchObject({
      status: "Mismatch",
      provider: null,
      dispatchAccepted: null,
    });
    expect(sdk.send).toHaveBeenCalledTimes(2);
  },
);
it("preserves observed disabled status as a Provider fact without any business grant", async () => {
  const f = fixture(),
    expected = await original(f),
    { Attributes, ...rest } = user();
  sdk.send.mockResolvedValue({
    ...rest,
    Enabled: false,
    UserStatus: "CONFIRMED",
    UserAttributes: Attributes,
  });
  expect(await f.source.inspect(expected)).toMatchObject({
    status: "Found",
    dispatchAccepted: null,
    provider: { enabled: false, status: "CONFIRMED" },
  });
});
it.each(["true", Promise.resolve(true)])(
  "refuses a nonboolean captured email comparison result",
  async (result) => {
    const f = fixture();
    Object.defineProperty(f.options.hasher, "equals", { value: () => result });
    const source = createCognitoWorkforceInvitation(f.options);
    const created = await source.create(request);
    expect(created).toMatchObject({ status: "Unknown", provider: null, dispatchAccepted: null });
    expect(
      await source.inspect({
        actorReference,
        creationIntentDigest,
        emailDigest: created.emailDigest,
        creationStartedAt: at,
        expectedSubject: null,
        expectedCreatedAt: null,
      }),
    ).toMatchObject({ status: "Unknown", provider: null });
  },
);
it("distinguishes actual NotFound from unknown transport failures and never automatically RESEND", async () => {
  const f = fixture(),
    expected = await original(f);
  sdk.send.mockRejectedValue(
    new UserNotFoundException({ message: "discard provider detail", $metadata: {} }),
  );
  expect(await f.source.inspect(expected)).toMatchObject({ status: "NotFound", provider: null });
  sdk.send.mockRejectedValue(new Error("discard private SDK error"));
  expect(await f.source.inspect(expected)).toMatchObject({ status: "Unknown", provider: null });
  expect(await f.create()).toMatchObject({
    status: "Unknown",
    dispatchAccepted: null,
    provider: null,
  });
  for (const [command] of sdk.send.mock.calls)
    if (command instanceof AdminCreateUserCommand)
      expect(command.input.MessageAction).toBeUndefined();
});
it("bounds a nonresponsive actual SDK transport and aborts without inventing delivery or a subject", async () => {
  vi.useFakeTimers();
  const f = fixture(40);
  sdk.send.mockImplementation(() => new Promise(() => undefined));
  const result = f.create();
  await vi.advanceTimersByTimeAsync(40);
  expect(await result).toMatchObject({ status: "Unknown", provider: null, dispatchAccepted: null });
  expect(sdk.send.mock.calls[0]?.[1].abortSignal.aborted).toBe(true);
});
it("refuses malformed closed inputs before outbound traffic", async () => {
  const f = fixture();
  for (const value of [
    { ...request, actorReference: "email@example.invalid" },
    { ...request, creationIntentDigest: "a".repeat(64) },
    { ...request, corporateEmail: " Owner@Example.invalid" },
    { ...request, ClientMetadata: {} },
  ])
    await expect(f.source.create(value)).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  expect(sdk.send).not.toHaveBeenCalled();
  const expected = await original(f);
  await expect(f.source.inspect({ ...expected, expectedCreatedAt: null })).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  await expect(f.source.inspect({ ...expected, extra: true })).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  expect(sdk.send).toHaveBeenCalledTimes(1);
});
it.each(["clock", "configuration", "hash", "equals"])(
  "poisons %s drift during a successful SDK response",
  async (kind) => {
    const f = fixture();
    sdk.send.mockImplementation(async () => {
      if (kind === "clock") f.options.clock.now = () => later;
      if (kind === "configuration") f.options.configuration.clientId = "otherclient";
      if (kind === "hash") f.options.hasher.hash = () => parseSelectorHash("b".repeat(64));
      if (kind === "equals") f.options.hasher.equals = () => true;
      return { User: user() };
    });
    await expect(f.create()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
    await expect(f.create()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
    expect(sdk.send).toHaveBeenCalledTimes(1);
  },
);
it("keeps the original finite window and returns Unknown for late or malformed account data", async () => {
  const f = fixture();
  sdk.send.mockImplementation(async () => {
    f.time("2026-10-06T12:00:05.000Z");
    return { User: user() };
  });
  expect(await f.create()).toMatchObject({
    status: "Unknown",
    provider: null,
    observedAt: at,
    validUntil: "2026-10-06T12:00:05.000Z",
  });
  f.time(at);
  sdk.send.mockResolvedValue({ User: { ...user(), UserCreateDate: new Date("invalid") } });
  expect(await f.create()).toMatchObject({ status: "Unknown", provider: null });
  sdk.send.mockResolvedValue({
    User: { ...user(), Attributes: [...user().Attributes, { Name: "sub", Value: subject }] },
  });
  expect(await f.create()).toMatchObject({ status: "Unknown", provider: null });
});
it("rejects unsupported region, open configuration and explicit credential/endpoint injection", () => {
  const f = fixture();
  for (const value of [
    {
      ...f.options,
      configuration: {
        ...configuration,
        issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Foreign",
      },
    },
    { ...f.options, configuration: { ...configuration, extra: true } },
    { ...f.options, endpoint: "https://untrusted.invalid" },
    { ...f.options, credentials: {} },
    { ...f.options, requestTimeoutMs: 5001 },
  ])
    expect(() => createCognitoWorkforceInvitation(value)).toThrow("request denied");
  expect(sdk.construct).toHaveBeenCalledTimes(1);
});
