import { createGuestBindingCredentialProvider } from "@bop/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, id, now } from "../test-support/customer-entry-composition-fixture.js";
import {
  createLocalCustomerRuntime,
  type LocalCustomerRuntimeOptions,
} from "./local-customer-runtime.js";
import { createApiRuntimeLogger, type ApiServerRuntime } from "./server.js";

const runtimes: ApiServerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown("SIGTERM")));
  vi.unstubAllEnvs();
});

function setup() {
  const f = fixture();
  const run = vi.fn(async (): Promise<never> => {
    throw new Error("synthetic database unavailable");
  });
  const options: LocalCustomerRuntimeOptions = {
    scope: { brandReference: id(1), storeReference: id(2) },
    entry: f.options,
    menuStores: { resolvePublic: vi.fn(async () => null) },
    sessionTransactions: { run },
    menuTransactions: { run },
    allowedOrigin: "https://customer.invalid",
    now: () => now,
    uuidV7Factory: (() => {
      let sequence = 600;
      return () => id(++sequence);
    })(),
    runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
  };
  return { f, run, options };
}

async function start(options: LocalCustomerRuntimeOptions) {
  const runtime = createLocalCustomerRuntime(options);
  runtimes.push(runtime);
  expect(runtime.server.listening).toBe(false);
  await runtime.listen();
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  expect(address.address).toBe("127.0.0.1");
  return { runtime, root: `http://127.0.0.1:${address.port}` };
}

describe("scoped local Customer runtime", () => {
  function diningCartOptions() {
    const write = vi.fn(async (): Promise<never> => {
      throw new Error("synthetic selection writer must not run");
    });
    const configuration: NonNullable<LocalCustomerRuntimeOptions["diningCart"]> = {
      participation: { resolve: vi.fn(async () => null) },
      selectionTransactions: { run: write },
      selection: {
        sourceChannel: "Qr",
        policy: {
          policyVersionReference: id(750),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 7200,
          validFrom: now,
          validUntil: new Date(Date.parse(now) + 86400000).toISOString(),
        },
        generateReference: () => id(751),
        audit: () => {
          throw new Error("no selection audit");
        },
      },
    };
    return { configuration, write };
  }
  it("requires separate configured Dining Cart reads before runtime creation", () => {
    const f = setup(),
      dining = diningCartOptions();
    expect(() =>
      createLocalCustomerRuntime({ ...f.options, diningCart: dining.configuration }),
    ).toThrow("LOCAL_DINING_CART_READS_REQUIRED");
    expect(dining.write).not.toHaveBeenCalled();
  });
  it("rejects missing customer authority before the opt-in Dining selection writer", async () => {
    const f = setup(),
      dining = diningCartOptions();
    const { root } = await start({
      ...f.options,
      cartTransactions: { run: f.run },
      diningCart: dining.configuration,
    });
    const response = await fetch(`${root}/api/v1/carts`, {
      method: "POST",
      headers: {
        origin: "https://customer.invalid",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        "x-csrf-token": "c".repeat(43),
        "idempotency-key": id(752),
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(dining.write).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps the outer scope, Identity store and clock despite extra Dining configuration fields", async () => {
    const f = setup(),
      dining = diningCartOptions();
    const forbidden = vi.fn((): never => {
      throw new Error("nested runtime authority must not run");
    });
    const nested = {
      ...dining.configuration,
      scope: { brandReference: id(999), storeReference: id(998) },
      sessions: { resolve: forbidden, authorize: forbidden },
      now: forbidden,
      cartTransactions: { run: forbidden },
      catalog: { describeMany: forbidden },
      stores: { getPublicStore: forbidden },
    };
    const { root } = await start({
      ...f.options,
      cartTransactions: { run: f.run },
      diningCart: nested,
    });
    const response = await fetch(`${root}/api/v1/carts`, {
      method: "POST",
      headers: {
        cookie: `__Host-bop-guest=${"g".repeat(43)}`,
        origin: "https://customer.invalid",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        "x-csrf-token": "c".repeat(43),
        "idempotency-key": id(753),
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(f.run).toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    expect(dining.write).not.toHaveBeenCalled();
  });

  function diningOptions() {
    const owner = vi.fn(async (): Promise<never> => {
      throw new Error("synthetic Dining unavailable");
    });
    const credential = vi.fn((): never => {
      throw new Error("synthetic credential unavailable");
    });
    const configuration: NonNullable<LocalCustomerRuntimeOptions["diningAdmission"]> = {
      join: {
        dining: {
          store: { resolveJoinState: owner, resolveJoinOperation: owner, join: owner },
          credentials: {
            generateReference: credential,
            hashJoinCredential: credential,
            hashOperationIntent: credential,
            equals: credential,
          },
          pepperVersion: 1,
        },
        contexts: { resolve: owner },
      },
      binding: {
        bindings: { prepare: owner, acknowledge: owner, activate: owner, complete: owner },
        dining: {
          store: { readCurrent: owner, resolveOperation: owner, consume: owner },
          credentials: { hashOperationIntent: credential, equals: credential },
          binding: { readCurrent: owner },
        },
        contexts: { resolve: owner },
        recovery: { generate: credential, hash: credential },
        preparationLifetimeSeconds: 300,
      },
      resolveRequestContext: vi.fn(async () => ({ abuse: { admit: owner } })),
    };
    return { configuration, owner, credential };
  }
  async function diningPost(root: string, route: string, body: object) {
    return fetch(root + route, {
      method: "POST",
      headers: {
        origin: "https://customer.invalid",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        "idempotency-key": id(900),
        "x-csrf-token": "B".repeat(43),
        cookie: `__Host-bop-guest=${"A".repeat(43)}`,
      },
      body: JSON.stringify(body),
    });
  }
  it.each([
    "/bff/customer/dining/join",
    "/bff/customer/dining-binding/prepare",
    "/bff/customer/dining-binding/activate",
    "/bff/customer/dining-binding/complete",
  ])("keeps unconfigured Dining route %s unavailable without database reads", async (route) => {
    const { options, run } = setup();
    const { root } = await start(options);
    expect((await diningPost(root, route, {})).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["join", "prepare"])(
    "uses actual Session lookup before configured Dining %s providers",
    async (action) => {
      const { options, run } = setup(),
        dining = diningOptions();
      const override = vi.fn(async () => {
        throw new Error("must not use sub-configuration authority");
      });
      const join = {
        ...dining.configuration.join,
        scope: { brandReference: id(998), storeReference: id(999) },
        session: { store: { resolve: override } },
        now: override,
      };
      const binding = {
        ...dining.configuration.binding,
        scope: { brandReference: id(998), storeReference: id(999) },
        session: { store: { resolve: override } },
        now: override,
      };
      const { root } = await start({
        ...options,
        diningAdmission: { ...dining.configuration, join, binding },
      });
      const response = await diningPost(
        root,
        action === "join" ? "/bff/customer/dining/join" : "/bff/customer/dining-binding/prepare",
        action === "join" ? { joinCredential: "123456" } : { admissionReference: id(901) },
      );
      expect(response.status).toBe(503);
      expect(run).toHaveBeenCalledOnce();
      expect(override).not.toHaveBeenCalled();
      expect(dining.owner).not.toHaveBeenCalled();
      expect(dining.credential).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
  it("requires this request's server context before any Session lookup", async () => {
    const { options, run } = setup(),
      dining = diningOptions();
    const resolve = vi.fn(async () => null);
    const { root } = await start({
      ...options,
      diningAdmission: { ...dining.configuration, resolveRequestContext: resolve },
    });
    const response = await diningPost(root, "/bff/customer/dining/join", {
      joinCredential: "123456",
    });
    expect(response.status).toBe(503);
    expect(resolve).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(dining.owner).not.toHaveBeenCalled();
  });
  it("denies malformed configured transport before request context resolution", async () => {
    const { options, run } = setup(),
      dining = diningOptions();
    const { root } = await start({ ...options, diningAdmission: dining.configuration });
    expect(
      (
        await diningPost(root, "/bff/customer/dining/join", {
          joinCredential: "123456",
          abuse: "Admitted",
        })
      ).status,
    ).toBe(400);
    expect(dining.configuration.resolveRequestContext).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps an unconfigured Quote endpoint unavailable without database access", async () => {
    const { options, run } = setup();
    const { root } = await start(options);
    const response = await fetch(`${root}/api/v1/carts/${id(901)}/quote`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "quote_service_unavailable" } });
    expect(run).not.toHaveBeenCalled();
  });
  it("requires Cart reads before enabling local Quote composition", () => {
    const { options, run } = setup();
    expect(() => createLocalCustomerRuntime({ ...options, cartQuote: {} as never })).toThrow(
      "LOCAL_CART_QUOTE_READS_REQUIRED",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("enables Quote only with explicit providers and denies unavailable Session before Pricing", async () => {
    const { options, run } = setup();
    const candidate = vi.fn(async (): Promise<never> => {
      throw new Error("synthetic candidate unavailable");
    });
    const { root } = await start({
      ...options,
      cartTransactions: { run },
      cartQuote: {
        attachmentTransactions: { run },
        pricingTransactions: { run },
        references: { hashIntent: () => `sha256:${"a".repeat(64)}`, equals: (a, b) => a === b },
        pricingReferences: {
          generateReference: () => id(900),
          hashIntent: () => `sha256:${"a".repeat(64)}`,
          equals: (a, b) => a === b,
        },
        audit: () => ({}) as never,
        expiryAudit: () => ({}) as never,
        candidate,
      },
    });
    expect(run).not.toHaveBeenCalled();
    const response = await fetch(`${root}/api/v1/carts/${id(901)}/quote`, {
      method: "POST",
      headers: {
        origin: options.allowedOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: `__Host-bop-guest=${"g".repeat(43)}`,
        "x-csrf-token": "c".repeat(43),
        "idempotency-key": id(902),
      },
      body: JSON.stringify({ cartVersion: 1 }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "quote_not_found" } });
    expect(run).toHaveBeenCalled();
    expect(candidate).not.toHaveBeenCalled();
  });
  it.each(["production", "staging", "unknown", ""])(
    "rejects environment %s before construction",
    (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      expect(() => createLocalCustomerRuntime({} as never)).toThrow(
        "LOCAL_CUSTOMER_RUNTIME_UNAVAILABLE",
      );
    },
  );

  it("does not acquire database resources at construction or claim database readiness", async () => {
    const { options, run } = setup();
    const { root } = await start(options);
    expect(run).not.toHaveBeenCalled();
    const response = await fetch(`${root}/ready`);
    expect(response.status).toBe(503);
    await response.text();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["brandReference", "storeReference"] as const)(
    "rejects foreign QR %s before profile, admission or persistence",
    async (field) => {
      const { f, options, run } = setup();
      const { root } = await start({ ...options, scope: { ...options.scope, [field]: id(99) } });
      const response = await fetch(`${root}/bff/customer/entry`, {
        method: "POST",
        headers: {
          origin: options.allowedOrigin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
        },
        body: JSON.stringify({ qrToken: f.token() }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "entry_unavailable" });
      expect(f.options.profile.resolution.resolve).not.toHaveBeenCalled();
      expect(f.options.admission.consume).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(["brandReference", "storeReference", "status", "missing"])(
    "denies menu resolution with %s drift before database access",
    async (field) => {
      const { options, run } = setup();
      const resolvePublic = vi.fn(async () =>
        field === "missing"
          ? null
          : ({
              ...options.scope,
              status: "Active",
              [field]: field === "status" ? "Inactive" : id(99),
            } as never),
      );
      const { root } = await start({ ...options, menuStores: { resolvePublic } });
      const response = await fetch(
        `${root}/api/v1/public/stores/${id(4)}/menu?channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "menu_not_found" } });
      expect(resolvePublic).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("captures scope, bounds dependency failures and preserves independent runtime shutdown", async () => {
    const { options, run } = setup();
    const scope = { ...options.scope };
    const { root, runtime } = await start({
      ...options,
      scope,
      menuStores: {
        resolvePublic: async () => ({ ...options.scope, status: "Active" }) as never,
      },
    });
    scope.storeReference = id(99);
    const other = await start(setup().options);
    const response = await fetch(
      `${root}/api/v1/public/stores/${id(4)}/menu?channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA`,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      error: { code: "menu_service_unavailable", messageKey: "customer.menu.service_unavailable" },
    });
    expect(run).toHaveBeenCalledOnce();
    await runtime.shutdown("SIGTERM");
    expect(runtime.server.listening).toBe(false);
    expect(other.runtime.server.listening).toBe(true);
  });
});

describe("optional local Cart runtime", () => {
  it("retains unavailable default without acquiring resources", async () => {
    const { options, run } = setup();
    const { root } = await start(options);
    const response = await fetch(root + "/bff/customer/cart");
    expect(response.status).toBe(503);
    await response.text();
    expect(run).not.toHaveBeenCalled();
  });
  it("configures authentication without invoking admission, Cart or menu on denied reads", async () => {
    const { options, run, f } = setup();
    const cartRun = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected Cart lookup");
    });
    const { root } = await start({ ...options, cartTransactions: { run: cartRun } });
    expect(run).not.toHaveBeenCalled();
    expect(cartRun).not.toHaveBeenCalled();
    const missing = await fetch(root + "/bff/customer/cart", {
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    });
    expect(missing.status).toBe(401);
    await missing.text();
    expect(run).not.toHaveBeenCalled();
    const denied = await fetch(root + "/bff/customer/cart", {
      headers: {
        cookie: "__Host-bop-guest=" + "a".repeat(43),
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toContain("no-store");
    expect(await denied.text()).not.toContain("synthetic database unavailable");
    expect(run).toHaveBeenCalledOnce();
    expect(cartRun).not.toHaveBeenCalled();
    expect(f.options.admission.consume).not.toHaveBeenCalled();
    expect(f.options.profile.resolution.resolve).not.toHaveBeenCalled();
    expect(f.options.session.credentials.generateCredential).not.toHaveBeenCalled();
  });
});

describe("optional local Cart binding runtime", () => {
  function bindingOptions(): NonNullable<LocalCustomerRuntimeOptions["cartBinding"]> {
    return {
      orderingTransactions: {
        run: vi.fn(async (): Promise<never> => {
          throw new Error("unexpected Ordering write");
        }),
      },
      identityAudit: {
        append: vi.fn(async () => {
          throw new Error("unexpected Identity audit");
        }),
      },
      ordering: {
        policy: {
          policyVersionReference: id(901),
          policyDigest: "sha256:" + "a".repeat(64),
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86400,
          validFrom: now,
          validUntil: "2026-01-16T12:00:00.000Z",
        },
        sourceChannel: "Qr",
        generateReference: vi.fn(() => id(900)),
        audit: vi.fn(() => {
          throw new Error("unexpected Ordering audit");
        }),
      },
      recovery: createGuestBindingCredentialProvider(new Uint8Array(32).fill(7)),
      preparationLifetimeSeconds: 300,
    };
  }
  it("requires Cart reads before enabling binding", () => {
    const { options, run } = setup();
    expect(() => createLocalCustomerRuntime({ ...options, cartBinding: bindingOptions() })).toThrow(
      "LOCAL_CART_BINDING_READS_REQUIRED",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps binding unavailable in the default runtime", async () => {
    const { options, run } = setup();
    const { root } = await start(options);
    const response = await fetch(root + "/bff/customer/cart-binding/prepare", { method: "POST" });
    expect(response.status).toBe(503);
    await response.text();
    expect(run).not.toHaveBeenCalled();
  });
  it("wires configured binding with existing request guards and bounded authorization failure", async () => {
    const { options, run, f } = setup();
    const binding = bindingOptions();
    const { root } = await start({ ...options, cartTransactions: { run }, cartBinding: binding });
    expect(run).not.toHaveBeenCalled();
    const send = (origin: string) =>
      fetch(root + "/bff/customer/cart-binding/prepare", {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
          "idempotency-key": id(902),
          "x-csrf-token": "b".repeat(43),
          cookie: "__Host-bop-guest=" + "a".repeat(43),
        },
        body: "{}",
      });
    const wrongOrigin = await send("https://wrong.invalid");
    expect(wrongOrigin.status).toBe(400);
    await wrongOrigin.text();
    expect(run).not.toHaveBeenCalled();
    const denied = await send(options.allowedOrigin);
    expect(denied.status).toBe(503);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(await denied.json()).toEqual({
      error: { code: "cart_binding_unavailable", messageKey: "customer.cart.binding_unavailable" },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(binding.orderingTransactions.run).not.toHaveBeenCalled();
    expect(binding.identityAudit.append).not.toHaveBeenCalled();
    expect(binding.ordering.audit).not.toHaveBeenCalled();
    expect(f.options.admission.consume).not.toHaveBeenCalled();
    expect(f.options.session.credentials.generateCredential).not.toHaveBeenCalled();
  });
});

describe("optional local Cart removal runtime", () => {
  function removalOptions(): NonNullable<LocalCustomerRuntimeOptions["cartRemoval"]> {
    return {
      writeTransactions: {
        run: vi.fn(async (): Promise<never> => {
          throw new Error("unexpected write");
        }),
      },
      references: {
        hashIntent: () => {
          throw new Error("unexpected hash");
        },
        equals: (a, b) => a === b,
      },
      audit: vi.fn(() => {
        throw new Error("unexpected audit");
      }),
    };
  }
  it("requires reads before enabling removal", () => {
    const { options, run } = setup();
    expect(() => createLocalCustomerRuntime({ ...options, cartRemoval: removalOptions() })).toThrow(
      "LOCAL_CART_REMOVAL_READS_REQUIRED",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps default removal unavailable", async () => {
    const { options, run } = setup();
    const { root } = await start(options);
    const result = await fetch(root + "/api/v1/carts/" + id(30) + "/items/" + id(31), {
      method: "DELETE",
    });
    expect(result.status).toBe(503);
    await result.text();
    expect(run).not.toHaveBeenCalled();
  });
  it("constructs without resources and preserves Origin and Session guards", async () => {
    const { options, run, f } = setup();
    const removal = removalOptions();
    const cartRun = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected Cart read");
    });
    const { root } = await start({
      ...options,
      cartTransactions: { run: cartRun },
      cartRemoval: removal,
    });
    expect(run).not.toHaveBeenCalled();
    expect(cartRun).not.toHaveBeenCalled();
    const send = (origin: string) =>
      fetch(root + "/api/v1/carts/" + id(30) + "/items/" + id(31), {
        method: "DELETE",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "idempotency-key": id(32),
          "if-match": '"1"',
          "x-csrf-token": "b".repeat(43),
          cookie: "__Host-bop-guest=" + "a".repeat(43),
        },
      });
    const wrong = await send("https://wrong.invalid");
    expect(wrong.status).toBe(400);
    await wrong.text();
    expect(run).not.toHaveBeenCalled();
    const denied = await send(options.allowedOrigin);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("synthetic");
    expect(run).toHaveBeenCalledOnce();
    expect(cartRun).not.toHaveBeenCalled();
    expect(removal.writeTransactions.run).not.toHaveBeenCalled();
    expect(removal.audit).not.toHaveBeenCalled();
    expect(f.options.session.credentials.generateCredential).not.toHaveBeenCalled();
  });
});

describe("optional local Cart item runtime", () => {
  function itemOptions(): NonNullable<LocalCustomerRuntimeOptions["cartItems"]> {
    return {
      writeTransactions: {
        run: vi.fn(async (): Promise<never> => {
          throw new Error("unexpected write");
        }),
      },
      catalog: {
        validateSelection: vi.fn(async () => {
          throw new Error("unexpected Catalog read");
        }),
      },
      references: {
        generate: () => {
          throw new Error("unexpected item allocation");
        },
        hashIntent: () => {
          throw new Error("unexpected hash");
        },
        equals: (a, b) => a === b,
      },
      audit: vi.fn(() => {
        throw new Error("unexpected audit");
      }),
    };
  }
  it("requires reads before enabling items", () => {
    const { options, run } = setup();
    expect(() => createLocalCustomerRuntime({ ...options, cartItems: itemOptions() })).toThrow(
      "LOCAL_CART_ITEM_READS_REQUIRED",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps default items unavailable", async () => {
    const { options, run } = setup();
    const { root } = await start(options);
    const result = await fetch(root + "/api/v1/carts/" + id(30) + "/items", {
      method: "POST",
    });
    expect(result.status).toBe(503);
    await result.text();
    expect(run).not.toHaveBeenCalled();
  });
  it("constructs without resources and preserves Origin and Session guards", async () => {
    const { options, run, f } = setup();
    const items = itemOptions();
    const cartRun = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected Cart read");
    });
    const { root } = await start({
      ...options,
      cartTransactions: { run: cartRun },
      cartItems: items,
    });
    expect(run).not.toHaveBeenCalled();
    expect(cartRun).not.toHaveBeenCalled();
    const send = (origin: string) =>
      fetch(root + "/api/v1/carts/" + id(30) + "/items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "idempotency-key": id(32),
          "if-match": '"1"',
          "x-csrf-token": "b".repeat(43),
          cookie: "__Host-bop-guest=" + "a".repeat(43),
        },
        body: JSON.stringify({
          sellableReference: id(31),
          quantity: 1,
          optionSelections: [],
          customerNote: null,
        }),
      });
    const wrong = await send("https://wrong.invalid");
    expect(wrong.status).toBe(400);
    await wrong.text();
    expect(run).not.toHaveBeenCalled();
    const denied = await send(options.allowedOrigin);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("synthetic");
    expect(run).toHaveBeenCalledOnce();
    expect(cartRun).not.toHaveBeenCalled();
    expect(items.writeTransactions.run).not.toHaveBeenCalled();
    expect(items.audit).not.toHaveBeenCalled();
    expect(f.options.session.credentials.generateCredential).not.toHaveBeenCalled();
  });
});
