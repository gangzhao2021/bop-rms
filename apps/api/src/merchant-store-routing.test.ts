import type { Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createMerchantStoreRouting } from "./merchant-store-routing.js";

const store = (n: number) => "018f4f8a-9c2d-7a11-8d01-00000000000" + String(n);
const router = (name: string): RequestHandler & { readonly label: string } =>
  Object.assign(
    ((_request: Request, response: Response) => {
      response.json({ served: name });
    }) as RequestHandler,
    { label: name },
  );
function call(handler: RequestHandler, cookie?: string, url = "/session") {
  const sent: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 200,
    body: undefined,
    headers: {},
  };
  const response = {
    setHeader: (key: string, value: string) => {
      sent.headers[key] = value;
    },
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
  } as unknown as Response;
  const request = {
    url,
    rawHeaders: cookie === undefined ? [] : ["Cookie", "__Host-bop-merchant=" + cookie],
  } as unknown as Request;
  return new Promise<typeof sent>((done) => {
    const original = response.json.bind(response);
    (response as { json: (body: unknown) => Response }).json = (body: unknown) => {
      const result = original(body);
      done(sent);
      return result;
    };
    void handler(request, response, () => done(sent));
  });
}

describe("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: staff requests go to their Session's Store", () => {
  it("a single-Store installation is its own routes, reading nothing extra", async () => {
    const resolve = vi.fn();
    const only = router("one");
    const handler = createMerchantStoreRouting({
      primaryStoreReference: store(1),
      routers: new Map([[store(1), only]]),
      resolve,
    });
    expect(handler).toBe(only);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("routes by the Store the server bound to the Session; signed out goes to the first Store", async () => {
    const bound = new Map([
      ["first-session", store(1)],
      ["second-session", store(2)],
      ["elsewhere", store(3)],
    ]);
    const handler = createMerchantStoreRouting({
      primaryStoreReference: store(1),
      routers: new Map([
        [store(1), router("first")],
        [store(2), router("second")],
      ]),
      resolve: async (cookie) => (typeof cookie === "string" ? (bound.get(cookie) ?? null) : null),
    });
    expect((await call(handler, "second-session")).body).toEqual({ served: "second" });
    expect((await call(handler, "first-session")).body).toEqual({ served: "first" });
    expect((await call(handler)).body).toEqual({ served: "first" });
    expect((await call(handler, "not-a-session")).body).toEqual({ served: "first" });
    // A Store this installation does not serve: refused, no data.
    expect(await call(handler, "elsewhere")).toMatchObject({
      status: 403,
      body: { code: "MERCHANT_STORE_NOT_SERVED" },
      headers: { "Cache-Control": "no-store" },
    });
  });
  it("answers unavailable, without data, when the Session's Store can't be read", async () => {
    const onUnexpected = vi.fn();
    const handler = createMerchantStoreRouting({
      primaryStoreReference: store(1),
      routers: new Map([
        [store(1), router("first")],
        [store(2), router("second")],
      ]),
      resolve: async () => {
        throw new Error("database down");
      },
      onUnexpected,
    });
    expect(await call(handler, "any")).toMatchObject({
      status: 503,
      body: { code: "MERCHANT_STORE_UNAVAILABLE" },
    });
    expect(onUnexpected).toHaveBeenCalledOnce();
  });
  it("refuses a routing table without its first Store", () => {
    expect(() =>
      createMerchantStoreRouting({
        primaryStoreReference: store(1),
        routers: new Map([[store(2), router("second")]]),
        resolve: async () => null,
      }),
    ).toThrow("MERCHANT_STORE_ROUTING_INVALID");
  });
  it("segment 7: another Store's summary goes to that Store's routes, which authorize there", async () => {
    const second = "018f4f8a-9c2d-7a11-8d01-000000000002";
    const handler = createMerchantStoreRouting({
      primaryStoreReference: store(1),
      routers: new Map([
        [store(1), router("first")],
        [second, router("second")],
      ]),
      resolve: async () => store(1),
    });
    expect((await call(handler, "s", "/reports/stores/" + second + "/tonight")).body).toEqual({
      served: "second",
    });
    expect(
      await call(handler, "s", "/reports/stores/018f4f8a-9c2d-7a11-8d01-000000000009/tonight"),
    ).toMatchObject({ status: 403, body: { code: "MERCHANT_STORE_NOT_SERVED" } });
  });
});
