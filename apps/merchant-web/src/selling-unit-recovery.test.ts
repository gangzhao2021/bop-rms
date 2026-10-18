import { expect, it, vi } from "vitest";
import { createSellingUnitRecovery } from "./selling-unit-recovery.js";
import {
  createProductSellingUnitsClient,
  ProductSellingUnitsError,
} from "./product-selling-units-client.js";
import type {
  SellingUnitCursor,
  SellingUnitRecoveryScope,
} from "./selling-unit-recovery-client.js";
const id = (n: number) => "019a2421-0018-7000-8000-" + n.toString(16).padStart(12, "0"),
  csrf = "c".repeat(43),
  hash = "sha256:" + "1".repeat(64),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(5),
  };
function fixture() {
  const state = {
      epoch: 0,
      cursor: null as SellingUnitCursor | null,
      unavailable: false,
      race: false,
      deny: false,
      cleanup: false,
      lose: true,
      actor: scope.actorReference,
      outcome: "Committed" as "Committed" | "Abandoned",
      late: false,
    },
    events: string[] = [],
    bodies: string[] = [];
  const client = {
    context: vi.fn(async (action: "Create" | "ReplaceDraft") => {
      if (state.deny) throw new ProductSellingUnitsError("Denied");
      return {
        ...scope,
        actorReference: state.actor,
        action,
        observedAt: "2026-10-04T12:00:00.000Z",
        validUntil: "2026-10-04T12:00:05.000Z",
      };
    }),
    resolve: vi.fn(async () => {
      if (state.deny) throw new ProductSellingUnitsError("Denied");
      if (state.late) state.epoch++;
      return {
        outcome: state.outcome,
        registryReference: state.outcome === "Committed" ? id(9) : null,
        versionReference: state.outcome === "Committed" ? id(10) : null,
        registryVersion: state.outcome === "Committed" ? 1 : null,
        originalIntentDigest: state.outcome === "Committed" ? hash : null,
        snapshotDigest: state.outcome === "Committed" ? hash : null,
        recordedAt: "2026-10-04T12:00:00.000Z",
        digest: hash,
      };
    }),
  };
  const journal = (_selected: SellingUnitRecoveryScope) => (
    void _selected,
    {
      async load() {
        if (state.unavailable) throw new ProductSellingUnitsError("Unavailable");
        return state.cursor;
      },
      async reserve(value: SellingUnitCursor) {
        events.push("reserve");
        if (state.race) state.cursor = { ...value, operationReference: id(99) };
        if (
          state.unavailable ||
          (state.cursor && JSON.stringify(state.cursor) !== JSON.stringify(value))
        )
          throw new ProductSellingUnitsError("Conflict");
        state.cursor = value;
      },
      async complete(value: SellingUnitCursor) {
        events.push("complete");
        if (state.cleanup || JSON.stringify(value) !== JSON.stringify(state.cursor))
          throw new ProductSellingUnitsError("Unavailable");
        state.cursor = null;
      },
    }
  );
  const commands = createProductSellingUnitsClient(async (_url, init) => {
    events.push("dispatch");
    bodies.push(String(init?.body));
    if (state.lose) throw Error("Synthetic response lost");
    const c = JSON.parse(String(init?.body)) as { operationReference: string };
    return new Response(
      JSON.stringify({
        profile: "CatalogProductSellingUnitRegistryResultV1",
        status: "Replayed",
        operationReference: c.operationReference,
        registryVersion: 1,
        snapshotDigest: hash,
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  });
  const prepare = (operationReference = id(8), action: "Create" | "ReplaceDraft" = "Create") =>
    commands.prepare(
      {
        action,
        operationReference,
        expectedRegistryVersion: 0,
        defaultLocale: "en-CA",
        units: [
          {
            unitReference: null,
            code: "PACK",
            semanticDefinition: "Synthetic private unit meaning",
            quantityDecimalPlaces: 2,
            localizedNames: { "en-CA": "Synthetic name" },
            lifecycle: "Active",
          },
        ],
      },
      scope,
    );
  const create = () =>
    createSellingUnitRecovery({ currentContext: () => state.epoch, client, journal });
  return { state, events, bodies, prepare, create, client, signal: new AbortController().signal };
}
it("durably reserves only identity before dispatch and reload resolves original without another registration", async () => {
  const s = fixture(),
    first = s.create();
  await expect(first.execute(s.prepare(), csrf, s.signal)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.events).toEqual(["reserve", "dispatch"]);
  expect(JSON.stringify(s.state.cursor)).not.toContain("private unit meaning");
  expect(Object.keys(s.state.cursor ?? {})).toEqual([
    "profile",
    "scope",
    "action",
    "operationReference",
    "expectedRegistryVersion",
  ]);
  const reloaded = s.create();
  await reloaded.inspect("ReplaceDraft", scope, csrf, s.signal);
  expect(reloaded.view().pending).toBe(true);
  await expect(reloaded.resolve("ReplaceDraft", scope, csrf, s.signal)).resolves.toMatchObject({
    outcome: "Committed",
    registryVersion: 1,
  });
  expect(s.state.cursor).toBeNull();
  expect(s.bodies).toHaveLength(1);
});
it("Create and Edit share one pending slot and cannot replace a different original operation", async () => {
  const s = fixture();
  await expect(s.create().execute(s.prepare(), csrf, s.signal)).rejects.toThrow();
  await expect(
    s.create().execute(s.prepare(id(99), "ReplaceDraft"), csrf, s.signal),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(s.state.cursor?.operationReference).toBe(id(8));
  expect(s.bodies).toHaveLength(1);
});
it("missing durable storage prevents registration dispatch", async () => {
  const s = fixture();
  s.state.unavailable = true;
  await expect(s.create().execute(s.prepare(), csrf, s.signal)).rejects.toThrow();
  expect(s.bodies).toHaveLength(0);
});
it("denied context or resolution keeps the original barrier; durable abandonment alone permits a new operation", async () => {
  const s = fixture(),
    r = s.create();
  await expect(r.execute(s.prepare(), csrf, s.signal)).rejects.toThrow();
  s.state.deny = true;
  await expect(r.resolve("Create", scope, csrf, s.signal)).rejects.toMatchObject({
    code: "Denied",
  });
  expect(r.view().pending).toBe(true);
  s.state.deny = false;
  s.state.outcome = "Abandoned";
  await expect(r.resolve("Create", scope, csrf, s.signal)).resolves.toMatchObject({
    outcome: "Abandoned",
  });
  expect(s.state.cursor).toBeNull();
  s.state.lose = false;
  await r.execute(s.prepare(id(99)), csrf, s.signal);
  expect(s.bodies).toHaveLength(2);
});
it("exact mounted retry keeps its bytes and cleanup failure preserves a resolvable identity", async () => {
  const s = fixture(),
    r = s.create(),
    original = s.prepare();
  await expect(r.execute(original, csrf, s.signal)).rejects.toThrow();
  s.state.lose = false;
  s.state.cleanup = true;
  await r.execute(original, csrf, s.signal);
  expect(s.bodies[1]).toBe(s.bodies[0]);
  expect(r.view()).toMatchObject({ pending: true, cleanupFailed: true });
  s.state.cleanup = false;
  await r.resolve("Create", scope, csrf, s.signal);
  expect(s.state.cursor).toBeNull();
});
it("Actor rotation and late scope resolution cannot clear an original marker", async () => {
  const s = fixture(),
    r = s.create();
  await expect(r.execute(s.prepare(), csrf, s.signal)).rejects.toThrow();
  s.state.actor = id(99);
  await expect(r.resolve("Create", scope, csrf, s.signal)).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(s.state.cursor).not.toBeNull();
  s.state.actor = scope.actorReference;
  s.state.late = true;
  await expect(r.resolve("Create", scope, csrf, s.signal)).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(s.state.cursor).not.toBeNull();
});

it("a competing CAS reservation locks the UI until the actual stored original is inspected", async () => {
  const s = fixture(),
    r = s.create();
  s.state.race = true;
  await expect(r.execute(s.prepare(), csrf, s.signal)).rejects.toMatchObject({ code: "Conflict" });
  expect(r.view().checked).toBe(false);
  expect(s.bodies).toHaveLength(0);
  await r.inspect("Create", scope, csrf, s.signal);
  expect(r.view()).toMatchObject({ checked: true, pending: true });
  expect(s.state.cursor?.operationReference).toBe(id(99));
});
