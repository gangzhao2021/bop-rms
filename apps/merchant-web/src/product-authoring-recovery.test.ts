import { expect, it, vi } from "vitest";
import { createProductAuthoringRecovery } from "./product-authoring-recovery.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
import type {
  ProductAuthoringCursor,
  ProductAuthoringRecoveryScope,
} from "./product-authoring-recovery-client.js";
const id = (n: number) => "019a2421-0018-7000-8000-" + n.toString(16).padStart(12, "0"),
  csrf = "c".repeat(43),
  scope = { brandReference: id(2), storeReference: id(3) };
function fixture() {
  const state = {
      context: 0,
      cursor: null as ProductAuthoringCursor | null,
      lose: true,
      deny: false,
      cleanup: false,
      corrupt: false,
      actor: id(5),
      outcome: "Committed" as "Committed" | "Abandoned",
    },
    events: string[] = [],
    bodies: string[] = [];
  const client = {
    context: vi.fn(async () => {
      if (state.deny) throw Error("Synthetic denied");
      return {
        tenantReference: id(1),
        ...scope,
        actorReference: state.actor,
        action: "Create" as const,
        observedAt: "2026-10-04T12:00:00.000Z",
        validUntil: "2026-10-04T12:00:05.000Z",
      };
    }),
    resolve: vi.fn(async () => {
      if (state.deny) throw Error("Synthetic denied");
      return {
        outcome: state.outcome,
        productReference: state.outcome === "Committed" ? id(4) : null,
        versionReference: state.outcome === "Committed" ? id(6) : null,
        aggregateVersion: state.outcome === "Committed" ? 1 : null,
      };
    }),
  };
  const journal = vi.fn((currentScope: ProductAuthoringRecoveryScope) => ({
    async load() {
      if (state.corrupt) throw Error("Synthetic corrupt journal");
      void currentScope;
      return state.cursor;
    },
    async reserve(cursor: ProductAuthoringCursor) {
      events.push("reserve");
      if (state.cursor && JSON.stringify(state.cursor) !== JSON.stringify(cursor))
        throw Error("Synthetic CAS mismatch");
      state.cursor = cursor;
    },
    async complete(cursor: ProductAuthoringCursor) {
      events.push("complete");
      if (state.cleanup || JSON.stringify(state.cursor) !== JSON.stringify(cursor))
        throw Error("Synthetic CAS refused");
      state.cursor = null;
    },
  }));
  const commands = createProductCommandClient(async (_url, init) => {
    events.push("dispatch");
    bodies.push(String(init?.body));
    if (state.lose) throw Error("Synthetic lost reply");
    const command = JSON.parse(String(init?.body)) as { operationReference: string };
    return new Response(
      JSON.stringify({
        status: "AlreadyApplied",
        scope,
        operationReference: command.operationReference,
        productReference: id(4),
        versionReference: id(6),
        aggregateVersion: 1,
        lifecycle: "Draft",
        skus: [],
      }),
      { status: 200, headers: { "cache-control": "no-store", "content-type": "application/json" } },
    );
  });
  const create = () =>
    createProductAuthoringRecovery({
      action: "Create",
      productReference: null,
      currentContext: () => state.context,
      client,
      journal,
      commands,
    });
  const command = () => ({
    internalCode: "SYNTHETIC",
    productType: "PreparedFood",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic text never retained" },
    taxClassificationReference: null,
    operationReference: id(8),
    skus: [],
  });
  return {
    state,
    client,
    journal,
    commands,
    create,
    command,
    events,
    bodies,
    signal: new AbortController().signal,
  };
}
it("reserves identity before transport and a remounted context resolves committed outcome without another write", async () => {
  const s = fixture(),
    first = s.create();
  await expect(
    first.commands.prepareCreate(s.command(), scope).execute(csrf, s.signal),
  ).rejects.toThrow();
  expect(s.events).toEqual(["reserve", "dispatch"]);
  expect(first.view().pending).toBe(true);
  expect(JSON.stringify(s.state.cursor)).not.toContain("Synthetic text");
  const reloaded = s.create();
  await reloaded.inspect(scope, csrf, s.signal);
  expect(reloaded.view().pending).toBe(true);
  await expect(reloaded.resolve(scope, csrf, s.signal)).resolves.toMatchObject({
    outcome: "Committed",
    aggregateVersion: 1,
  });
  expect(s.state.cursor).toBeNull();
  expect(s.bodies).toHaveLength(1);
});
it("only a durable terminal abandonment releases an uncommitted original after remount", async () => {
  const s = fixture();
  await expect(
    s.create().commands.prepareCreate(s.command(), scope).execute(csrf, s.signal),
  ).rejects.toThrow();
  s.state.outcome = "Abandoned";
  await expect(s.create().resolve(scope, csrf, s.signal)).resolves.toMatchObject({
    outcome: "Abandoned",
  });
  expect(s.state.cursor).toBeNull();
  expect(s.bodies).toHaveLength(1);
});
it("competing prepared intent is refused before another dispatch while the original cursor survives", async () => {
  const s = fixture(),
    recovery = s.create();
  await expect(
    recovery.commands.prepareCreate(s.command(), scope).execute(csrf, s.signal),
  ).rejects.toThrow();
  await expect(
    recovery.commands
      .prepareCreate({ ...s.command(), operationReference: id(99) }, scope)
      .execute(csrf, s.signal),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(s.state.cursor?.operationReference).toBe(id(8));
  expect(s.bodies).toHaveLength(1);
});
it("denial or corrupt storage never means no original intent", async () => {
  const s = fixture(),
    recovery = s.create();
  s.state.corrupt = true;
  await expect(recovery.inspect(scope, csrf, s.signal)).rejects.toThrow();
  expect(recovery.view().checked).toBe(false);
  await expect(
    recovery.commands.prepareCreate(s.command(), scope).execute(csrf, s.signal),
  ).rejects.toThrow();
  expect(s.bodies).toEqual([]);
});
it("acknowledged receipt remains acknowledged if local cleanup fails", async () => {
  const s = fixture(),
    recovery = s.create();
  s.state.lose = false;
  s.state.cleanup = true;
  await expect(
    recovery.commands.prepareCreate(s.command(), scope).execute(csrf, s.signal),
  ).resolves.toMatchObject({ status: "AlreadyApplied" });
  expect(recovery.view()).toMatchObject({ pending: true, cleanupFailed: true });
  s.state.cleanup = false;
  await recovery.resolve(scope, csrf, s.signal);
  expect(recovery.view().pending).toBe(false);
});
it("actual Actor change in a mounted context blocks access to its prior journal", async () => {
  const s = fixture(),
    recovery = s.create();
  await recovery.inspect(scope, csrf, s.signal);
  s.state.actor = id(99);
  await expect(recovery.inspect(scope, csrf, s.signal)).rejects.toMatchObject({
    code: "ScopeChanged",
  });
  expect(s.journal).toHaveBeenCalledTimes(1);
  expect(recovery.view().checked).toBe(false);
});
it("captures authoring action and ports before an awaited context read", async () => {
  const s = fixture(),
    actual = await s.client.context(),
    commands = { ...s.commands };
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  s.client.context.mockImplementationOnce(async () => {
    await paused;
    return actual;
  });
  const options = {
    action: "Create" as "Create" | "ReplaceDraft",
    productReference: null as string | null,
    currentContext: () => s.state.context,
    client: s.client,
    journal: s.journal,
    commands,
  };
  const recovery = createProductAuthoringRecovery(options);
  const original = recovery.commands.prepareCreate(s.command(), scope);
  const dispatched = original.execute(csrf, s.signal);
  const rejected = expect(dispatched).rejects.toThrow();
  options.action = "ReplaceDraft";
  options.productReference = id(99);
  options.journal = vi.fn(() => {
    throw Error("Replacement journal must not run");
  });
  s.client.context = vi.fn(async () => {
    throw Error("Replacement context must not run");
  });
  s.client.resolve = vi.fn(async () => {
    throw Error("Replacement resolver must not run");
  });
  commands.prepareCreate = vi.fn(() => {
    throw Error("Replacement command must not run");
  });
  if (!release) throw Error("Synthetic context pause not installed");
  release();
  await rejected;
  expect(s.state.cursor).toMatchObject({
    scope: { action: "Create", productReference: null },
    operationReference: id(8),
    expectedAggregateVersion: null,
  });
  expect(s.events).toEqual(["reserve", "dispatch"]);
  await expect(recovery.resolve(scope, csrf, s.signal)).resolves.toMatchObject({
    outcome: "Committed",
    productReference: id(4),
  });
  expect(s.state.cursor).toBeNull();
  expect(s.bodies).toHaveLength(1);
});
it("changing the options callback cannot hide an actual context departure while awaiting authority", async () => {
  const s = fixture(),
    actual = await s.client.context();
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  s.client.context.mockImplementationOnce(async () => {
    await paused;
    return actual;
  });
  const options = {
    action: "Create" as const,
    productReference: null,
    currentContext: () => s.state.context,
    client: s.client,
    journal: s.journal,
    commands: s.commands,
  };
  const recovery = createProductAuthoringRecovery(options);
  const executing = recovery.commands.prepareCreate(s.command(), scope).execute(csrf, s.signal);
  const rejected = expect(executing).rejects.toMatchObject({ code: "ScopeChanged" });
  s.state.context += 1;
  options.currentContext = () => 0;
  if (!release) throw Error("Synthetic context pause not installed");
  release();
  await rejected;
  expect(s.journal).not.toHaveBeenCalled();
  expect(s.state.cursor).toBeNull();
  expect(s.bodies).toEqual([]);
});
