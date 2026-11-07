import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantBrandWorkspaceClient,
  parseMerchantBrandWorkspace,
  parseMerchantBrandBootstrap,
  parseMerchantBrandSessionUrl,
} from "./merchant-brand-workspace.js";
const id = (n: number) => `018f7f9a-ad3e-7a11-8d01-${String(n).padStart(12, "0")}`;
const brand = id(1),
  actor = id(2),
  csrf = "c".repeat(43);
const workspace = () => ({
  profile: "BrandAdministrationWorkspaceV1",
  selectedScope: { tenantReference: brand, brandReference: brand, actorReference: actor },
  brand: { brandReference: brand, label: "Synthetic Brand", lifecycle: "Active", version: 7 },
  navigation: [
    {
      screenId: "ORG-BRAND-DETAIL",
      label: "Brand",
      href: `/app/organization/brands/${brand}`,
      permission: "organization.manage",
    },
  ],
});
const packet = () => ({
  authenticated: true,
  csrf,
  recentMfaRequired: false,
  workspace: workspace(),
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
afterEach(() => vi.useRealTimers());
describe("noStore Brand workspace", () => {
  it("retains the actual Brand version and Actor without requiring or accepting a Store", () => {
    const parsed = parseMerchantBrandWorkspace(workspace(), brand);
    expect(parsed.brand.version).toBe(7);
    expect(parsed.selectedScope).toEqual(workspace().selectedScope);
    expect(Object.isFrozen(parsed.selectedScope)).toBe(true);
    expect(() =>
      parseMerchantBrandWorkspace(
        { ...workspace(), selectedScope: { ...workspace().selectedScope, storeReference: id(3) } },
        brand,
      ),
    ).toThrow();
    expect(() => parseMerchantBrandWorkspace(workspace(), id(3))).toThrow(
      expect.objectContaining({ code: "ScopeChanged" }),
    );
    expect(() =>
      parseMerchantBrandWorkspace(
        { ...workspace(), selectedScope: { ...workspace().selectedScope, tenantReference: id(3) } },
        brand,
      ),
    ).toThrow();
  });
  it("rejects altered navigation, lifecycle, labels, scope and version without invoking getters", () => {
    for (const value of [
      { ...workspace(), brand: { ...workspace().brand, lifecycle: "Unknown" } },
      { ...workspace(), brand: { ...workspace().brand, version: "7" } },
      { ...workspace(), brand: { ...workspace().brand, version: 0 } },
      { ...workspace(), brand: { ...workspace().brand, label: "secret\nvalue" } },
      {
        ...workspace(),
        navigation: [{ ...workspace().navigation[0], permission: "merchant.access" }],
      },
      {
        ...workspace(),
        navigation: [{ ...workspace().navigation[0], href: "https://external.invalid" }],
      },
      { ...workspace(), navigation: [...workspace().navigation, ...workspace().navigation] },
    ])
      expect(() => parseMerchantBrandWorkspace(value, brand)).toThrow();
    const read = vi.fn(() => workspace().selectedScope),
      value = workspace();
    Object.defineProperty(value, "selectedScope", { enumerable: true, get: read });
    expect(() => parseMerchantBrandWorkspace(value, brand)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("uses only the fixed noStore endpoint and credentialed same-origin nonredirecting transport", async () => {
    const request = vi.fn<typeof fetch>(async () => response(packet()));
    const current = await createMerchantBrandWorkspaceClient(request).bootstrap(brand);
    if (current.recentMfaRequired) throw Error("unexpected controlled MFA expiry");
    expect(current.workspace.brand.version).toBe(7);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/merchant/organization/brands/session",
      expect.objectContaining({
        method: "GET",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    );
    expect(request.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(JSON.stringify(request.mock.calls)).not.toContain(actor);
  });
  it("keeps unavailable dependencies distinct from required access", async () => {
    for (const status of [401, 403, 404, 503]) {
      const client = createMerchantBrandWorkspaceClient(vi.fn(async () => response({}, status)));
      await expect(client.bootstrap(brand)).rejects.toMatchObject({
        code: status === 401 || status === 403 ? "AccessRequired" : "Unavailable",
      });
    }
  });
  it("rotation starts a genuine redirect challenge without bootstrapping or renewing locally", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      response({
        status: "step_up_required",
        authorizationUrl: "https://identity.invalid/authorize?state=controlled",
      }),
    );
    expect(await createMerchantBrandWorkspaceClient(request).rotate({ csrf })).toEqual({
      status: "step_up_required",
      authorizationUrl: "https://identity.invalid/authorize?state=controlled",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      "/merchant/organization/brands/session/rotate",
      expect.objectContaining({
        body: "{}",
        headers: expect.objectContaining({ "X-BOP-CSRF": csrf }),
      }),
    ]);
  });
  it("retains truthful logout uncertainty and retries with only original CSRF, without a bootstrap", async () => {
    const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({ status: "logout_unknown" }))
        .mockResolvedValueOnce(
          response({
            status: "browser_logout_required",
            logoutUrl: "https://identity.invalid/logout",
          }),
        ),
      client = createMerchantBrandWorkspaceClient(request);
    expect(await client.logout({ csrf })).toEqual({ status: "logout_unknown" });
    expect(await client.logout({ csrf })).toEqual({
      status: "browser_logout_required",
      logoutUrl: "https://identity.invalid/logout",
    });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/merchant/organization/brands/session/logout",
      "/merchant/organization/brands/session/logout",
    ]);
    await expect(
      createMerchantBrandWorkspaceClient(
        vi.fn(async () => {
          throw Error("hidden network detail");
        }),
      ).logout({ csrf }),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await expect(
      createMerchantBrandWorkspaceClient(vi.fn(async () => response({ loggedOut: true }))).logout({
        csrf,
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
  });
  it("accepts only the exact MFA-expired bootstrap with no business workspace", () => {
    expect(
      parseMerchantBrandBootstrap(
        { authenticated: true, csrf, recentMfaRequired: true, workspace: null },
        brand,
      ),
    ).toEqual({ csrf, recentMfaRequired: true, workspace: null });
    for (const value of [
      { ...packet(), recentMfaRequired: true },
      { ...packet(), recentMfaRequired: false, workspace: null },
      { authenticated: true, csrf, workspace: workspace() },
    ])
      expect(() => parseMerchantBrandBootstrap(value, brand)).toThrow();
  });
  it.each([
    "http://identity.invalid/",
    "https://user:secret@identity.invalid/",
    "https://identity.invalid/#fragment",
    "https://identity.invalid/\n",
    "https://identity.invalid/?value=%0a",
    "javascript:alert(1)",
  ])("rejects unsafe session redirect %s", (url) => {
    expect(() => parseMerchantBrandSessionUrl(url)).toThrow();
  });
  it("discards old in-flight bootstrap responses after invalidation", async () => {
    let finish!: (value: Response) => void;
    const request = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = createMerchantBrandWorkspaceClient(request),
      pending = client.bootstrap(brand);
    const assertion = expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
    client.invalidate();
    finish(response(packet()));
    await assertion;
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("bounds body reads and refuses an already-aborted caller before any network request", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream(), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const client = createMerchantBrandWorkspaceClient(request),
      pending = client.bootstrap(brand);
    const assertion = expect(pending).rejects.toMatchObject({ code: "Unavailable" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    const controller = new AbortController();
    controller.abort();
    request.mockClear();
    await expect(client.bootstrap(brand, { signal: controller.signal })).rejects.toMatchObject({
      code: "ScopeChanged",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects cacheable, non-JSON and oversized bodies before accepting a workspace", async () => {
    for (const item of [
      new Response(JSON.stringify(packet()), {
        headers: { "content-type": "application/json", "cache-control": "public" },
      }),
      new Response(JSON.stringify(packet()), {
        headers: { "content-type": "application/json-foreign", "cache-control": "no-store" },
      }),
      new Response(" ".repeat(32769) + JSON.stringify(packet()), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    ])
      await expect(
        createMerchantBrandWorkspaceClient(vi.fn(async () => item)).bootstrap(brand),
      ).rejects.toMatchObject({ code: "Unavailable" });
  });
  it("checks invalidation after the final body read and before exposing the parsed result", async () => {
    const payload = response(packet());
    if (!payload.body) throw new Error("synthetic body missing");
    const reader = payload.body.getReader(),
      release = reader.releaseLock.bind(reader);
    const client = createMerchantBrandWorkspaceClient(vi.fn(async () => payload));
    Object.defineProperty(payload.body, "getReader", { value: () => reader });
    vi.spyOn(reader, "releaseLock").mockImplementation(() => {
      release();
      void Promise.resolve().then(() => Promise.resolve().then(() => client.invalidate()));
    });
    await expect(client.bootstrap(brand)).rejects.toMatchObject({ code: "ScopeChanged" });
  });
});

it.each(["Draft", "Active", "Suspended", "Archived"])(
  "preserves administrative %s lifecycle without treating it as an operational grant",
  (lifecycle) => {
    const value = workspace();
    value.brand.lifecycle = lifecycle;
    const parsed = parseMerchantBrandWorkspace(value, brand);
    expect(parsed.brand.lifecycle).toBe(lifecycle);
    expect(parsed.navigation).toEqual(value.navigation);
    expect(parsed.selectedScope).toEqual(value.selectedScope);
  },
);
