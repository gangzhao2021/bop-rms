import { afterEach, expect, it, vi } from "vitest";
import { installInternalStaffLogin } from "./pilot-staff-login.mjs";
afterEach(() => vi.unstubAllEnvs());
const base = {
  headers: {
    host: "127.0.0.1:4443",
    origin: "https://127.0.0.1:4443",
    "sec-fetch-site": "same-origin",
  },
  query: {},
  body: { confirmation: "DEMO_STAFF_LOGIN", staffSelector: "author" },
};
function setup(single = false) {
  vi.stubEnv("NODE_ENV", "development");
  const routes = new Map(),
    staffChoices = vi.fn(async () =>
      single
        ? [{ selector: "staff", label: "DEMO staff staff" }]
        : [
            { selector: "author", label: "DEMO author <1>" },
            { selector: "reviewer", label: "DEMO reviewer" },
          ],
    ),
    issue = vi.fn(async () => ({ sessionCookie: "a".repeat(43), csrf: "b".repeat(43) })),
    merchant = { staffChoices, issue },
    app = {
      get: (path, handler) => routes.set(path, handler),
      post: (path, ...handlers) => routes.set(path, handlers.at(-1)),
    };
  installInternalStaffLogin(app, merchant);
  const res = {
    statusCode: 200,
    headers: {},
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(status) {
      this.statusCode = status;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    redirect(status, location) {
      this.statusCode = status;
      this.location = location;
      return this;
    },
  };
  return {
    routes,
    res,
    issue,
    staffChoices,
    merchant,
    get: (req = { ...base, body: undefined }) => routes.get("/internal-test/staff")(req, res),
    post: (req = base) => routes.get("/merchant/internal-test/login")(req, res),
  };
}
it("renders escaped aliases with native keyboard buttons and no identity/grant fields", async () => {
  const f = setup();
  await f.get();
  expect(f.res.statusCode).toBe(200);
  expect(f.res.body).toContain("DEMO author &lt;1&gt;");
  expect(f.res.body).toContain('name="staffSelector" value="reviewer"');
  expect(f.res.body).toContain('name="confirmation" value="DEMO_STAFF_LOGIN"');
  expect(f.res.body).not.toContain("actorReference");
  expect(f.res.body).not.toContain("catalog.product.approve");
  expect(f.res.headers["Cache-Control"]).toBe("no-store");
  expect(f.res.headers["Referrer-Policy"]).toBe("same-origin");
  expect(f.issue).not.toHaveBeenCalled();
});
it("explicitly selects one configured identity and preserves the secure session redirect", async () => {
  const f = setup();
  await f.post({ ...base, body: { ...base.body, staffSelector: "reviewer" } });
  expect(f.issue).toHaveBeenCalledExactlyOnceWith("reviewer");
  expect(f.res.statusCode).toBe(303);
  expect(f.res.location).toBe("/operations/orders");
  expect(f.res.headers["Set-Cookie"].endsWith("; Path=/; Secure; HttpOnly; SameSite=Strict")).toBe(
    true,
  );
  expect(f.res.headers["Cache-Control"]).toBe("no-store");
});
it("preserves the original single-identity POST without adding a multi-identity default", async () => {
  const single = setup(true);
  await single.post({ ...base, body: { confirmation: "DEMO_STAFF_LOGIN" } });
  expect(single.res.statusCode).toBe(303);
  expect(single.issue).toHaveBeenCalledExactlyOnceWith();
  const multiple = setup();
  await multiple.post({ ...base, body: { confirmation: "DEMO_STAFF_LOGIN" } });
  expect(multiple.res.statusCode).toBe(400);
  expect(multiple.issue).not.toHaveBeenCalled();
});
it.each([
  { headers: { ...base.headers, host: "other.invalid" } },
  { headers: { ...base.headers, origin: "https://other.invalid" } },
  { headers: { ...base.headers, "sec-fetch-site": "cross-site" } },
  { query: { next: "/catalog/products" } },
  { body: { confirmation: "wrong", staffSelector: "author" } },
  { body: { ...base.body, actorReference: "untrusted" } },
  { body: { ...base.body, permission: "catalog.product.approve" } },
  { body: { ...base.body, staffSelector: ["author", "reviewer"] } },
  { body: { ...base.body, staffSelector: "unknown" } },
  { body: { ...base.body, staffSelector: "<script>" } },
  { body: null },
])("rejects invalid transport/identity selection without issuing credentials", async (change) => {
  const f = setup();
  await f.post({ ...base, ...change });
  expect(f.res.statusCode).toBe(400);
  expect(f.res.body).toEqual({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
  expect(f.issue).not.toHaveBeenCalled();
  expect(f.res.headers["Set-Cookie"]).toBeUndefined();
});
it("rereads roster at POST and refuses an alias removed after rendering", async () => {
  const f = setup();
  await f.get();
  f.staffChoices.mockResolvedValue([{ selector: "reviewer", label: "DEMO reviewer" }]);
  await f.post();
  expect(f.staffChoices).toHaveBeenCalledTimes(2);
  expect(f.res.statusCode).toBe(400);
  expect(f.issue).not.toHaveBeenCalled();
});
it.each(["roster", "issue", "cookie"])(
  "bounds %s failure and never sets a success cookie",
  async (failure) => {
    const f = setup();
    if (failure === "roster")
      f.staffChoices.mockRejectedValue(new Error("private identity detail"));
    if (failure === "issue") f.issue.mockRejectedValue(new Error("private credential detail"));
    if (failure === "cookie") f.issue.mockResolvedValue({ sessionCookie: "invalid" });
    await f.post();
    expect(f.res.statusCode).toBe(503);
    expect(f.res.body).toEqual({ code: "INTERNAL_STAFF_LOGIN_UNAVAILABLE" });
    expect(f.res.headers["Set-Cookie"]).toBeUndefined();
  },
);
it("rejects a malformed or privileged roster projection without rendering it", async () => {
  const f = setup();
  f.staffChoices.mockResolvedValue([
    { selector: "author", label: "DEMO", actorReference: "private" },
  ]);
  await f.get();
  expect(f.res.statusCode).toBe(503);
  expect(f.res.body).toEqual({ code: "INTERNAL_STAFF_LOGIN_UNAVAILABLE" });
  expect(f.issue).not.toHaveBeenCalled();
});
it("captures the configured methods and refuses production installation", async () => {
  const f = setup();
  f.merchant.staffChoices = () => {
    throw Error("REPLACED_PORT");
  };
  f.merchant.issue = () => {
    throw Error("REPLACED_PORT");
  };
  await f.post();
  expect(f.issue).toHaveBeenCalledOnce();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => installInternalStaffLogin({}, f.merchant)).toThrow(/^INTERNAL_TEST_ONLY$/);
});
it("refuses malformed ports before installing routes", () => {
  vi.stubEnv("NODE_ENV", "development");
  const app = { get: vi.fn(), post: vi.fn() };
  for (const merchant of [
    null,
    {},
    { staffChoices: 1, issue: vi.fn() },
    { staffChoices: vi.fn(), issue: false },
  ]) {
    expect(() => installInternalStaffLogin(app, merchant)).toThrow(
      /^INTERNAL_STAFF_LOGIN_UNAVAILABLE$/,
    );
  }
  expect(app.get).not.toHaveBeenCalled();
  expect(app.post).not.toHaveBeenCalled();
});
