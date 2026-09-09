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
