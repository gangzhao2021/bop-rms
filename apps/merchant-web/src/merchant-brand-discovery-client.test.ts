import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMerchantBrandDiscoveryClient,
  parseMerchantBrandDiscoveryPage,
  parseMerchantBrandDiscoverySession,
  parseMerchantBrandDiscoverySelection,
  parseMerchantBrandInvitationStart,
} from "./merchant-brand-discovery-client.js";
const id = (n: number) => `018f9e90-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  now = Date.parse(at),
  session = {
    authenticated: true as const,
    csrf: "c".repeat(43),
    recentMfaRequired: false,
    actorReference: id(1),
    selectedBrandReference: null,
  };
const item = {
  brandReference: id(2),
  code: "BRAND-ONE",
  displayName: "Synthetic Brand",
  lifecycle: "Draft",
  defaultLocale: "en-CA",
  version: 1,
};
const page = () => ({
  profile: "MerchantBrandDiscoveryV1",
  actorReference: id(1),
  afterBrandReference: null,
  items: [item],
  hasMore: false,
  nextAfterBrandReference: null,
  observedAt: at,
  validUntil: "2026-10-06T12:00:05.000Z",
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
describe("Brand discovery closed wire and ordinary transport", () => {
  it("accepts real four lifecycle summaries without inventing configuration metadata", () => {
    for (const lifecycle of ["Draft", "Active", "Suspended", "Archived"]) {
      const result = parseMerchantBrandDiscoveryPage(
        { ...page(), items: [{ ...item, lifecycle }] },
        session,
        null,
        now,
      );
      expect(result.items[0]?.lifecycle).toBe(lifecycle);
      expect(Object.isFrozen(result.items)).toBe(true);
    }
    expect(() =>
      parseMerchantBrandDiscoveryPage(
        { ...page(), items: [{ ...item, supportedLocales: ["en-CA"] }] },
        session,
        null,
        now,
      ),
    ).toThrow();
  });
  it("keeps scanned cursor distinct from visible rows including an empty continuing page", () => {
    expect(
      parseMerchantBrandDiscoveryPage(
        { ...page(), items: [], hasMore: true, nextAfterBrandReference: id(3) },
        session,
        null,
        now,
      ).hasMore,
    ).toBe(true);
    expect(() =>
      parseMerchantBrandDiscoveryPage(
        {
          ...page(),
          afterBrandReference: id(3),
          items: [],
          hasMore: true,
          nextAfterBrandReference: id(3),
        },
        session,
        id(3),
        now,
      ),
    ).toThrow();
  });
  it("rejects expired, future, extended, mismatched Actor, cursor and sparse packets", () => {
    for (const value of [
      { ...page(), validUntil: at },
      { ...page(), validUntil: "2026-10-06T12:00:05.001Z" },
      { ...page(), actorReference: id(9) },
      { ...page(), afterBrandReference: id(8) },
      { ...page(), items: new Array(1) },
    ])
      expect(() => parseMerchantBrandDiscoveryPage(value, session, null, now)).toThrow();
    expect(() => parseMerchantBrandDiscoveryPage(page(), session, null, now + 5000)).toThrow();
    expect(() => parseMerchantBrandDiscoveryPage(page(), session, null, now - 1)).toThrow();
  });
  it("refuses session accessors and selection URLs outside the exact observed choice", () => {
    expect(() => parseMerchantBrandDiscoverySession({ ...session, extra: true })).toThrow();
    const accessed = { ...session };
    Object.defineProperty(accessed, "csrf", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => parseMerchantBrandDiscoverySession(accessed)).toThrow();
    expect(() =>
      parseMerchantBrandDiscoverySelection(
        { actorReference: id(1), brandReference: id(2), href: "https://foreign.test/" },
        session,
        id(2),
      ),
    ).toThrow();
    expect(
      parseMerchantBrandDiscoverySelection(
        { actorReference: id(1), brandReference: id(2), href: `/app/organization/brands/${id(2)}` },
        session,
        id(2),
      ).brandReference,
    ).toBe(id(2));
  });
  it("sends no Actor or permission, correct CSRF and immutable expected selection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page()));
      const client = createMerchantBrandDiscoveryClient(fetcher);
      await client.list(session, null);
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "X-BOP-CSRF": session.csrf },
        body: '{"afterBrandReference":null}',
      });
      fetcher.mockResolvedValue(
        response({
          actorReference: id(1),
          brandReference: id(2),
          href: `/app/organization/brands/${id(2)}`,
        }),
      );
      await client.select(session, id(2));
      expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
        JSON.stringify({ brandReference: id(2), expectedSelectedBrandReference: null }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("lost choice is unknown; conflict, access denial and unavailable remain distinct", async () => {
    for (const [status, code] of [
      [403, "AccessRequired"],
      [409, "SelectionConflict"],
      [503, "Unavailable"],
    ] as const) {
      const client = createMerchantBrandDiscoveryClient(
        vi.fn<typeof fetch>().mockResolvedValue(response({}, status)),
      );
      await expect(client.select(session, id(2))).rejects.toMatchObject({ code });
    }
    const client = createMerchantBrandDiscoveryClient(
      vi.fn<typeof fetch>().mockRejectedValue(new Error("controlled network")),
    );
    await expect(client.select(session, id(2))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it("late response cannot survive invalidation or caller abort", async () => {
    let release: (r: Response) => void = () => undefined;
    const client = createMerchantBrandDiscoveryClient(
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    const pending = client.bootstrap();
    client.invalidate();
    release(response(session));
    await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
    const c = new AbortController();
    c.abort();
    await expect(client.bootstrap({ signal: c.signal })).rejects.toMatchObject({
      code: "ScopeChanged",
    });
  });
  it("a malformed successful choice reply stays unknown and never supplies a foreign href", async () => {
    const client = createMerchantBrandDiscoveryClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        response({
          actorReference: id(9),
          brandReference: id(2),
          href: `/app/organization/brands/${id(2)}`,
        }),
      ),
    );
    await expect(client.select(session, id(2))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it("requires no-store bounded JSON and fresh MFA before list or choice", async () => {
    const client = createMerchantBrandDiscoveryClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(session), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(client.bootstrap()).rejects.toMatchObject({ code: "Unavailable" });
    await expect(
      client.select({ ...session, recentMfaRequired: true }, id(2)),
    ).rejects.toMatchObject({ code: "AccessRequired" });
  });
});

const invitationOrigin = "https://merchant.invalid",
  invitationPath = "/merchant/organization/brands/invitation",
  invitationSecret = "e".repeat(43);
function invitationAuthorization() {
  const url = new URL("https://controlled.auth.ca-central-1.amazoncognito.com/oauth2/authorize");
  const values = {
    client_id: "controlledclient",
    redirect_uri: invitationOrigin + "/merchant/organization/brands/callback",
    response_type: "code",
    scope: "openid",
    state: "s".repeat(43),
    nonce: "n".repeat(43),
    code_challenge: "k".repeat(43),
    code_challenge_method: "S256",
    identity_provider: "COGNITO",
    prompt: "login",
    max_age: "0",
    acr_values: "urn:cognito:loa:4",
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url;
}
function invitationResponse(
  body: unknown = { authorizationUrl: invitationAuthorization().href },
  status = 200,
) {
  return Object.defineProperty(response(body, status), "url", {
    value: invitationOrigin + invitationPath,
  });
}

describe("anonymous Brand invitation acceptance transport", () => {
  beforeEach(() => vi.stubGlobal("location", { origin: invitationOrigin }));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts only the transient secret to the fixed same-origin endpoint and accepts the actual server-approved protocol", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(invitationResponse()),
      client = createMerchantBrandDiscoveryClient(fetcher),
      result = await client.startInvitation({ secret: invitationSecret });
    expect(result).toEqual({ authorizationUrl: invitationAuthorization().href });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(invitationPath);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ secret: invitationSecret }),
    });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("X-BOP-CSRF")).toBe(false);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(invitationSecret);
    expect(result.authorizationUrl).not.toContain(invitationSecret);
  });

  it("rejects malformed or additional secret inputs without making a request", async () => {
    const fetcher = vi.fn<typeof fetch>(),
      client = createMerchantBrandDiscoveryClient(fetcher);
    for (const value of [
      { secret: "" },
      { secret: "https://other.invalid/" },
      { secret: "a".repeat(42) },
      { secret: invitationSecret, actorReference: id(1) },
    ]) {
      await expect(client.startInvitation(value)).rejects.toMatchObject({ code: "Invalid" });
    }
    const getter = vi.fn(() => invitationSecret),
      value = Object.defineProperty({}, "secret", { enumerable: true, get: getter });
    await expect(client.startInvitation(value as { secret: string })).rejects.toMatchObject({
      code: "Invalid",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["redirect_uri", "https://other.invalid/merchant/organization/brands/callback"],
    ["redirect_uri", invitationOrigin + "/other"],
    ["response_type", "token"],
    ["scope", "openid email"],
    ["code_challenge_method", "plain"],
    ["identity_provider", "Other"],
    ["prompt", "none"],
    ["max_age", "1"],
    ["acr_values", "urn:cognito:loa:2"],
    ["client_id", "bad-client"],
    ["state", "short"],
    ["nonce", "short"],
    ["code_challenge", "short"],
    ["secret", invitationSecret],
  ])("refuses changed or additional authorization parameter %s", (key, value) => {
    const url = invitationAuthorization();
    url.searchParams.set(key, value);
    expect(() =>
      parseMerchantBrandInvitationStart({ authorizationUrl: url.href }, invitationOrigin),
    ).toThrow();
  });

  it("requires exact closed reply, endpoint, canonical HTTPS and unique protocol parameters", () => {
    const original = invitationAuthorization(),
      duplicate = new URL(original);
    duplicate.searchParams.append("state", "s".repeat(43));
    for (const value of [
      { authorizationUrl: original.href, extra: true },
      { authorizationUrl: duplicate.href },
      { authorizationUrl: original.href.replace("https:", "http:") },
      { authorizationUrl: original.href.replace("https://", "https://user@") },
      { authorizationUrl: original.href + "#fragment" },
      { authorizationUrl: original.href.replace("/oauth2/authorize", "/logout") },
      { authorizationUrl: "//controlled.invalid/oauth2/authorize" },
      { authorizationUrl: original.href + "%0a" },
    ])
      expect(() => parseMerchantBrandInvitationStart(value, invitationOrigin)).toThrow();
  });

  it("does not treat a foreign or redirected API response as trusted Provider configuration", async () => {
    for (const alteration of [
      { url: "https://foreign.invalid" + invitationPath },
      { url: invitationOrigin + "/another-api" },
      { redirected: true },
      { type: "opaqueredirect" },
    ]) {
      const result = response({ authorizationUrl: invitationAuthorization().href });
      Object.defineProperties(
        result,
        Object.fromEntries(
          Object.entries({ url: invitationOrigin + invitationPath, ...alteration }).map(
            ([key, value]) => [key, { value }],
          ),
        ),
      );
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result);
      await expect(
        createMerchantBrandDiscoveryClient(fetcher).startInvitation({ secret: invitationSecret }),
      ).rejects.toMatchObject({ code: "OutcomeUnknown" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed successful results as unknown, without automatic retries", async () => {
    for (const result of [
      invitationResponse({ authorizationUrl: "https://foreign.invalid/phishing" }),
      invitationResponse({
        authorizationUrl: invitationAuthorization().href,
        secret: invitationSecret,
      }),
      Object.defineProperty(
        new Response("not-json", {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
        "url",
        { value: invitationOrigin + invitationPath },
      ),
      Object.defineProperty(
        new Response(JSON.stringify({ authorizationUrl: invitationAuthorization().href }), {
          headers: { "content-type": "application/json" },
        }),
        "url",
        { value: invitationOrigin + invitationPath },
      ),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result);
      await expect(
        createMerchantBrandDiscoveryClient(fetcher).startInvitation({ secret: invitationSecret }),
      ).rejects.toMatchObject({ code: "OutcomeUnknown" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("distinguishes explicit denial and unavailable from network uncertainty and never retries any automatically", async () => {
    for (const [status, code] of [
      [400, "Invalid"],
      [403, "AccessRequired"],
      [503, "Unavailable"],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(invitationResponse({}, status));
      await expect(
        createMerchantBrandDiscoveryClient(fetcher).startInvitation({ secret: invitationSecret }),
      ).rejects.toMatchObject({ code });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("controlled network"));
    await expect(
      createMerchantBrandDiscoveryClient(fetcher).startInvitation({ secret: invitationSecret }),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("discards late invitation replies on caller cancellation, entry invalidation and origin change", async () => {
    for (const mode of ["abort", "invalidate", "origin"] as const) {
      vi.stubGlobal("location", { origin: invitationOrigin });
      let release: (r: Response) => void = () => undefined;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ),
        client = createMerchantBrandDiscoveryClient(fetcher),
        c = new AbortController(),
        pending = client.startInvitation({ secret: invitationSecret }, { signal: c.signal });
      if (mode === "abort") c.abort();
      if (mode === "invalidate") client.invalidate();
      if (mode === "origin") vi.stubGlobal("location", { origin: "https://changed.invalid" });
      release(invitationResponse());
      await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds an uncertain invitation request and cancels its transport without replay", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined)),
      client = createMerchantBrandDiscoveryClient(fetcher),
      pending = client.startInvitation({ secret: invitationSecret });
    const rejected = expect(pending).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
