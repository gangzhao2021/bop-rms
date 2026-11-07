import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createCognitoPlatformSubjectStatus } from "../infrastructure/cognito-platform-subject-status.js";

const sdk = vi.hoisted(() => ({ send: vi.fn(), construct: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      constructor(options: unknown) {
        sdk.construct(options);
      }
      send = sdk.send;
    },
  };
});
const pool = "ca-central-1_Synthetic1",
  issuer = `https://cognito-idp.ca-central-1.amazonaws.com/${pool}`,
  subject = "opaque-local-subject",
  at = "2026-10-06T12:00:00.000Z";
const response = () => ({
  Enabled: true,
  UserStatus: "CONFIRMED",
  Username: "discard-provider-username",
  UserAttributes: [
    { Name: "sub", Value: subject },
    { Name: "email", Value: "discard@example.invalid" },
  ],
  PreferredMfaSetting: "SOFTWARE_TOKEN_MFA",
  UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
  $metadata: { requestId: "discard-request" },
});
function fixture(timeout = 4000) {
  let time = at;
  const options = { userPoolId: pool, clock: { now: () => time }, requestTimeoutMs: timeout },
    source = createCognitoPlatformSubjectStatus(options);
  return {
    options,
    source,
    read: () => source.readCurrentProviderSubject({ issuer, subject, observedAt: at }),
    time: (value: string) => {
      time = value;
    },
  };
}
beforeEach(() => {
  sdk.send.mockReset();
  sdk.construct.mockReset();
  sdk.send.mockResolvedValue(response());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("actual Cognito Platform subject status adapter", () => {
  it("accepts the AWS 55-character pool limit and rejects the next character", () => {
    const maxPool = `ca-central-1_${"A".repeat(42)}`;
    expect(maxPool).toHaveLength(55);
    expect(() =>
      createCognitoPlatformSubjectStatus({ userPoolId: maxPool, clock: { now: () => at } }),
    ).not.toThrow();
    expect(() =>
      createCognitoPlatformSubjectStatus({ userPoolId: `${maxPool}A`, clock: { now: () => at } }),
    ).toThrow("request denied");
    expect(sdk.construct).toHaveBeenCalledTimes(1);
  });
  it("uses the fixed Canadian SDK client and exact opaque subject while discarding PII and enrollment", async () => {
    const f = fixture(),
      result = await f.read();
    expect(sdk.construct).toHaveBeenCalledWith({
      region: "ca-central-1",
      endpoint: "https://cognito-idp.ca-central-1.amazonaws.com",
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 4000, requestTimeout: 4000 },
    });
    const command = sdk.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(AdminGetUserCommand);
    if (!(command instanceof AdminGetUserCommand)) throw new Error("expected real SDK command");
    expect(command.input).toEqual({ UserPoolId: pool, Username: subject });
    expect(result).toEqual({
      issuer,
      subject,
      status: "Enabled",
      observedAt: at,
      validUntil: "2026-10-06T12:00:05.000Z",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/email|username|MFA|discard|requestId/u);
    expect(Object.keys(f.source)).toEqual(["readCurrentProviderSubject"]);
  });
  it("returns only a positively confirmed disabled local account as Disabled", async () => {
    sdk.send.mockResolvedValue({ ...response(), Enabled: false });
    expect((await fixture().read()).status).toBe("Disabled");
  });
  it.each([
    { Enabled: undefined },
    { UserStatus: "EXTERNAL_PROVIDER" },
    { UserStatus: "UNCONFIRMED" },
    { UserAttributes: [] },
    { UserAttributes: [{ Name: "sub", Value: "foreign-subject" }] },
    {
      UserAttributes: [
        { Name: "sub", Value: subject },
        { Name: "sub", Value: subject },
      ],
    },
    {
      UserAttributes: [
        { Name: "sub", Value: subject },
        { Name: "identities", Value: "[]" },
      ],
    },
  ])("rejects unknown, foreign, duplicate or federated account facts %j", async (patch) => {
    sdk.send.mockResolvedValue({ ...response(), ...patch });
    await expect(fixture().read()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  });
  it("does not turn Provider errors or missing accounts into a Disabled authorization fact", async () => {
    sdk.send.mockRejectedValue(new Error("discard-provider-secret"));
    await expect(fixture().read()).rejects.toMatchObject({
      message: "request denied",
      code: "BROWSER_SESSION_DENIED",
    });
  });
  it("rejects foreign issuer, email aliases, unknown input fields and future observations before SDK send", async () => {
    const f = fixture();
    for (const input of [
      {
        issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Foreign",
        subject,
        observedAt: at,
      },
      { issuer, subject: "alias@example.invalid", observedAt: at },
      { issuer, subject, observedAt: "2026-10-06T12:00:00.001Z" },
      { issuer, subject, observedAt: at, passed: true },
    ])
      await expect(f.source.readCurrentProviderSubject(input)).rejects.toMatchObject({
        code: "BROWSER_SESSION_DENIED",
      });
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it("refuses response completion at the original five-second boundary and backwards time", async () => {
    for (const backwards of [false, true]) {
      const f = fixture();
      if (backwards) f.time("2026-10-06T12:00:00.500Z");
      sdk.send.mockImplementationOnce(async () => {
        f.time(backwards ? "2026-10-06T12:00:00.499Z" : "2026-10-06T12:00:05.000Z");
        return response();
      });
      await expect(f.read()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
    }
  });
  it("aborts a hanging SDK request at the finite deadline", async () => {
    vi.useFakeTimers();
    sdk.send.mockImplementation(() => new Promise(() => undefined));
    const f = fixture(100),
      pending = f.read(),
      rejection = expect(pending).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
    const signal = sdk.send.mock.calls[0]?.[1]?.abortSignal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not accept endpoint, credential, checker or pool overrides through production configuration", () => {
    for (const extra of ["endpoint", "credentials", "send", "passed"]) {
      const options = { userPoolId: pool, clock: { now: () => at } };
      Reflect.set(options, extra, "unsupported");
      expect(() => createCognitoPlatformSubjectStatus(options)).toThrow("request denied");
    }
    expect(() =>
      createCognitoPlatformSubjectStatus({
        userPoolId: "us-east-1_Foreign",
        clock: { now: () => at },
      }),
    ).toThrow("request denied");
    expect(() =>
      createCognitoPlatformSubjectStatus({
        userPoolId: pool,
        clock: { now: () => at },
        requestTimeoutMs: 0,
      }),
    ).toThrow("request denied");
    expect(sdk.construct).not.toHaveBeenCalled();
  });
  it("rejects clock port replacement rather than accepting a fresh synthetic status", async () => {
    const f = fixture();
    f.options.clock.now = () => at;
    await expect(f.read()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
    expect(sdk.send).not.toHaveBeenCalled();
  });
});
