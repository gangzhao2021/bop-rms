import { afterEach, beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({
  storeOptions: null,
  selectionOptions: null,
  created: [],
  selections: [],
}));
vi.mock("../../packages/bop/identity/src/index.ts", async (original) => {
  const actual = await original();
  return {
    ...actual,
    createPostgresBrowserSessionStore(options) {
      seam.storeOptions = options;
      return {
        async createSession(input) {
          await options.onSessionCreated(
            {
              query: () => {
                throw Error("UNEXPECTED_SQL");
              },
            },
            { session: input },
          );
          seam.created.push(input);
        },
      };
    },
    createPostgresBrowserSessionSelectionStore(options) {
      seam.selectionOptions = options;
      return {
        async write(tx, session, scope, at) {
          if (!(await options.validate(tx, session, scope, at))) throw Error("SELECTION_DENIED");
          seam.selections.push({ actorReference: session.actor.actorReference, scope, at });
        },
      };
    },
    BrowserSessionService: class {
      constructor(options) {
        this.options = options;
      }
      async authorize(input) {
        return this.options.store.authorize(input);
      }
    },
  };
});
import { createInternalMerchantSession } from "./pilot-merchant-session.mjs";
const id = (n) => "0190fa31-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T13:00:00.000Z",
  scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  seam.storeOptions = null;
  seam.selectionOptions = null;
  seam.created = [];
  seam.selections = [];
});
afterEach(() => vi.unstubAllEnvs());
function setup(multiple = true) {
  let value = multiple
      ? {
          schemaVersion: 2,
          environment: "InternalTest",
          database: "synthetic_pilot",
          scope,
          actors: [
            { selector: "author", actorReference: id(4), validUntil: until },
            { selector: "reviewer", actorReference: id(5), validUntil: until },
          ],
        }
      : {
          environment: "InternalTest",
          database: "synthetic_pilot",
          scope,
          actorReference: id(4),
          validUntil: until,
        },
    clock = at,
    sequence = 20;
  const encrypt = vi.fn(async () => ({
      algorithm: "SYNTHETIC_AES_256_GCM",
      ciphertext: "controlled",
    })),
    loadEmployee = vi.fn(async () => value),
    createInternalMerchantCredentials = vi.fn(async () => ({
      hasher: { hash: () => "controlled" },
      envelopes: { encrypt },
    })),
    transactions = {
      run: vi.fn(async (work) =>
        work({
          query: () => {
            throw Error("NO_AUTHORIZATION_SQL_FROM_ROSTER");
          },
        }),
      ),
    },
    resources = {
      scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
      publicProfile: { binding: scope },
      now: () => clock,
      transactions,
      credentials: { reference: () => id(++sequence) },
    };
  return {
    resources,
    encrypt,
    loadEmployee,
    createInternalMerchantCredentials,
    transactions,
    get value() {
      return value;
    },
    change(v) {
      value = v;
    },
    time(v) {
      clock = v;
    },
    create: () =>
      createInternalMerchantSession(resources, {
        loadEmployee,
        expectedDatabaseName: "synthetic_pilot",
        createInternalMerchantCredentials,
      }),
  };
}
it("retains legacy single-Actor issue and exposes only its safe alias", async () => {
  const f = setup(false),
    session = await f.create();
  expect(await session.staffChoices()).toEqual([{ selector: "staff", label: "DEMO staff staff" }]);
  const receipt = await session.issue();
  expect(typeof receipt.sessionCookie).toBe("string");
  expect(receipt.sessionCookie.length).toBe(43);
  expect(seam.created).toHaveLength(1);
  expect(seam.created[0].actor.actorReference).toBe(id(4));
  expect(seam.selections).toEqual([{ actorReference: id(4), scope, at }]);
  expect(f.transactions.run).not.toHaveBeenCalled(); // Mock owning session storage; roster does not create grants.
});
it("requires explicit multi-Actor selection and binds two independent session identities", async () => {
  const f = setup(),
    session = await f.create();
  await expect(session.issue()).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  await expect(session.issue("unknown")).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  await expect(session.issue(id(4))).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  expect(seam.created).toHaveLength(0);
  const choices = await session.staffChoices();
  expect(choices.map((choice) => choice.selector)).toEqual(["author", "reviewer"]);
  expect(JSON.stringify(choices).includes(id(4))).toBe(false);
  expect(Object.isFrozen(choices)).toBe(true);
  await session.issue("author");
  await session.issue("reviewer");
  expect(seam.created.map((value) => value.actor.actorReference)).toEqual([id(4), id(5)]);
  expect(seam.created[0].sessionReference).not.toBe(seam.created[1].sessionReference);
  expect(f.createInternalMerchantCredentials).toHaveBeenCalledTimes(1);
  expect(Object.hasOwn(choices[0], "permissions")).toBe(false);
});
it("fresh roster removal and expiry deny existing Actor resolution and selected association", async () => {
  const f = setup(),
    session = await f.create();
  await session.issue("author");
  const previous = seam.created[0];
  expect((await session.currentActor(null, id(4), at, at)).actorReference).toBe(id(4));
  f.change({ ...f.value, actors: [f.value.actors[1]] });
  await expect(session.currentActor(null, id(4), at, at)).rejects.toThrow(
    /^INTERNAL_MERCHANT_DENIED$/,
  );
  expect(await session.validateAssociation(null, previous, scope, at)).toBe(false);
  f.time(until);
  expect(await session.staffChoices()).toEqual([]);
  await expect(session.issue("reviewer")).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  expect(seam.created).toHaveLength(1);
});
it("rechecks scope/database and does not trust arbitrary Actor or scope selected by a caller", async () => {
  const f = setup(),
    session = await f.create();
  await session.issue("author");
  expect(
    await session.validateAssociation(
      null,
      seam.created[0],
      { ...scope, storeReference: id(8) },
      at,
    ),
  ).toBe(false);
  await expect(session.currentActor(null, id(9), at, at)).rejects.toThrow(
    /^INTERNAL_MERCHANT_DENIED$/,
  );
  f.change({ ...f.value, scope: { ...scope, tenantReference: id(8) } });
  await expect(session.staffChoices()).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  expect(await session.validateAssociation(null, seam.created[0], scope, at)).toBe(false);
});
it("fresh selection validation refuses removal during encryption before owning session commits", async () => {
  const f = setup(),
    session = await f.create();
  f.encrypt.mockImplementation(async () => {
    f.change({ ...f.value, actors: [f.value.actors[1]] });
    return { algorithm: "SYNTHETIC_AES_256_GCM", ciphertext: "controlled" };
  });
  await expect(session.issue("author")).rejects.toThrow("SELECTION_DENIED");
  expect(seam.created).toHaveLength(0);
  expect(seam.selections).toHaveLength(0);
});
it.each([
  (v) => ({ ...v, actors: [] }),
  (v) => ({ ...v, actors: [...v.actors, v.actors[0]] }),
  (v) => ({ ...v, actors: [v.actors[0], { ...v.actors[1], selector: "author" }] }),
  (v) => ({ ...v, actors: [v.actors[0], { ...v.actors[1], actorReference: id(4) }] }),
  (v) => ({ ...v, actors: [{ ...v.actors[0], permissions: ["catalog.product.approve"] }] }),
  (v) => ({ ...v, actors: [{ ...v.actors[0], selector: "<script>" }] }),
  (v) => ({ ...v, actors: [{ ...v.actors[0], validUntil: "2026-99-04T13:00:00.000Z" }] }),
  (v) => ({ ...v, actors: [{ ...v.actors[0], actorReference: "bad" }] }),
  (v) => ({ ...v, schemaVersion: 3 }),
  (v) => ({ ...v, actorReference: id(4) }),
  (v) => ({ ...v, database: "other" }),
])("rejects malformed roster without reading credentials", async (change) => {
  const f = setup();
  f.change(change(f.value));
  await expect(f.create()).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  expect(f.createInternalMerchantCredentials).not.toHaveBeenCalled();
});
it("rejects accessors without evaluating them and sanitizes loader failures", async () => {
  const f = setup(),
    getter = vi.fn(() => f.value.actors),
    value = { ...f.value };
  Object.defineProperty(value, "actors", { enumerable: true, get: getter });
  f.change(value);
  await expect(f.create()).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
  expect(getter).not.toHaveBeenCalled();
  f.loadEmployee.mockRejectedValue(new Error("private file detail"));
  await expect(f.create()).rejects.toThrow(/^INTERNAL_MERCHANT_DENIED$/);
});
it("production is rejected before reading identity configuration or credentials", async () => {
  const f = setup();
  vi.stubEnv("NODE_ENV", "production");
  await expect(f.create()).rejects.toThrow(/^INTERNAL_TEST_ONLY$/);
  expect(f.loadEmployee).not.toHaveBeenCalled();
  expect(f.createInternalMerchantCredentials).not.toHaveBeenCalled();
});
