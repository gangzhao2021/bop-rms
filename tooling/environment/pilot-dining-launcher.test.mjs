import { afterEach, expect, test, vi } from "vitest";
import { registerInternalDiningEntry } from "./pilot-dining-launcher.mjs";
afterEach(() => vi.unstubAllEnvs());
function setup(loadQr = vi.fn(async () => ({ token: () => "synthetic.qr.token" }))) {
  vi.stubEnv("NODE_ENV", "development");
  const routes = new Map();
  registerInternalDiningEntry(
    { get: (path, handler) => routes.set(path, handler) },
    {
      profile: { environment: "InternalTest" },
      tables: [{ selector: "table-2", label: "DEMO <2>", loadQr }],
    },
  );
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(v) {
      this.body = v;
      return this;
    },
    send(v) {
      this.body = v;
      return this;
    },
    type() {
      return this;
    },
    sendStatus(n) {
      this.statusCode = n;
      return this;
    },
  };
  return { routes, res, loadQr };
}
const request = {
  headers: { host: "127.0.0.1:4443", "sec-fetch-site": "same-origin" },
  query: { table: "table-2" },
};
test("launcher escapes labels, contains selectors only, exchange is no-store", async () => {
  const { routes, res, loadQr } = setup();
  routes.get("/internal-test/dining")({ ...request, query: {} }, res);
  expect(res.body).toContain("DEMO &lt;2&gt;");
  expect(res.body).toContain("/#internal-dining=table-2");
  expect(loadQr).not.toHaveBeenCalled();
  await routes.get("/bff/internal-test/dining-entry")(request, res);
  expect(res.headers["Cache-Control"]).toBe("no-store");
  expect(res.body).toEqual({ schemaVersion: 1, qrToken: "synthetic.qr.token" });
});
test.each([
  { headers: { ...request.headers, host: "example.invalid" } },
  { headers: { ...request.headers, "sec-fetch-site": "cross-site" } },
  { headers: { ...request.headers, origin: "https://example.invalid" } },
  { query: { table: ["table-2", "table-2"] } },
  { query: { table: "table-2", extra: "x" } },
  { query: { table: "unknown" } },
])("denied request never loads QR: %j", async (change) => {
  const { routes, res, loadQr } = setup();
  await routes.get("/bff/internal-test/dining-entry")({ ...request, ...change }, res);
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
  expect(loadQr).not.toHaveBeenCalled();
  expect(res.headers["Cache-Control"]).toBe("no-store");
});
test("loader errors are bounded and production registration denied", async () => {
  const { routes, res } = setup(async () => {
    throw new Error("private path");
  });
  await routes.get("/bff/internal-test/dining-entry")(request, res);
  expect(res.statusCode).toBe(503);
  expect(res.body).toEqual({ code: "INTERNAL_ENTRY_UNAVAILABLE" });
  vi.stubEnv("NODE_ENV", "production");
  expect(() =>
    registerInternalDiningEntry({}, { profile: { environment: "InternalTest" } }),
  ).toThrow("INTERNAL_TEST_ONLY");
});
