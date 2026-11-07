import { beforeEach, expect, it, vi } from "vitest";

// WP-2423 item 4: a table guest's QR/table context is resolved once per session and instant within
// one Guest Session binding check that lends a single transaction (`oneTransaction`), and on every
// call otherwise. The owner modules are doubles that count what the composition asks of them.
const seen = vi.hoisted(() => ({ resolves: [], issues: 0, contexts: [] }));
vi.mock("../../apps/api/dist/configured-dining-qr-context.js", () => ({
  createConfiguredDiningQrContext: () => ({}),
}));
vi.mock("../../apps/api/dist/configured-dining-guest-context.js", () => ({
  createConfiguredDiningGuestContext: (options) => {
    seen.contexts.push(options);
    return {
      resolve: async (input) => {
        seen.resolves.push(input.purpose);
        return input.session.unavailable ? null : { table: "T1", at: input.observedAt };
      },
    };
  },
}));
vi.mock("../../apps/api/dist/persistent-customer-entry.js", () => ({
  RetiredTableQrError: class extends Error {},
  createPersistentCustomerEntryComposition: () => ({}),
}));
vi.mock("../../packages/bop/identity/src/index.ts", () => ({
  createPostgresGuestEntryAdmissionStore: () => ({}),
}));
vi.mock("../../packages/bop/audit/src/index.ts", () => ({
  appendAuditRecordInTransaction: async () => undefined,
}));
vi.mock("../../packages/rms/dining/src/index.ts", () => ({
  createPostgresDiningTableQrStore: () => ({
    loadByQrReference: async () => {
      seen.issues += 1;
      return {
        qrReference: "qr",
        tableReference: "table",
        issuedAt: "2026-10-19T00:00:00.000Z",
        expiresAt: "2027-04-17T00:00:00.000Z",
      };
    },
  }),
  createPostgresDiningTableStore: () => ({}),
  readDiningTableQrPayload: () => ({}),
}));
const { createIssuedDiningEntries } = await import("./pilot-dining-issued-entry.mjs");

const qrReference = "01a15400-0000-7000-8000-000000000001";
const session = { channel: "DineIn", qrReference, sessionReference: "guest", version: 3 };
const at = "2026-10-19T14:00:00.000Z",
  later = "2026-10-19T14:00:00.005Z";
let runs = 0;
const runner = {
  run: async (work) => {
    runs += 1;
    return work({ query: async () => ({ rows: [] }) });
  },
};
async function entries() {
  return createIssuedDiningEntries(
    {
      scope: { brandReference: "brand", storeReference: "store" },
      transactions: runner,
      credentials: { sessions: {} },
      publicProfile: { authorize: async () => true },
    },
    {
      loadProfile: async () => ({ binding: { tenantReference: "tenant" } }),
      loadKeys: async () => ({}),
    },
  );
}
beforeEach(() => {
  seen.resolves = [];
  seen.issues = 0;
  seen.contexts = [];
  runs = 0;
});

it("reuses the context within one binding check for the same session and instant", async () => {
  const binding = (await entries()).binding(runner, { oneTransaction: true });
  expect(await binding.validate(session, at)).toBe("Current");
  const admission = await binding.resolve({ session, observedAt: at, purpose: "DiningAdmission" });
  expect(admission).toEqual({ table: "T1", at });
  expect(seen.resolves).toEqual(["GuestSessionBinding"]);
  expect(seen.issues).toBe(1);
  // A later instant, another session version or the entry purpose is resolved again.
  await binding.resolve({ session, observedAt: later, purpose: "DiningAdmission" });
  await binding.resolve({
    session: { ...session, version: 4 },
    observedAt: at,
    purpose: "DiningJoin",
  });
  await binding.resolve({ session, observedAt: at, purpose: "CustomerEntry" });
  expect(seen.resolves).toEqual([
    "GuestSessionBinding",
    "DiningAdmission",
    "DiningJoin",
    "CustomerEntry",
  ]);
  // The context reads go through the same lent runner.
  expect(seen.contexts.every((options) => options.transactions === runner)).toBe(true);
});

it("keeps an unavailable answer for the rest of the same check", async () => {
  const binding = (await entries()).binding(runner, { oneTransaction: true });
  const gone = { ...session, unavailable: true };
  expect(await binding.validate(gone, at)).toBe("Unavailable");
  expect(await binding.resolve({ session: gone, observedAt: at, purpose: "DiningAdmission" })).toBe(
    null,
  );
  expect(seen.resolves).toEqual(["GuestSessionBinding"]);
});

it("resolves on every call when no single transaction is lent", async () => {
  const binding = (await entries()).binding(runner);
  expect(await binding.validate(session, at)).toBe("Current");
  await binding.resolve({ session, observedAt: at, purpose: "DiningAdmission" });
  await binding.resolve({ session, observedAt: at, purpose: "DiningAdmission" });
  expect(seen.resolves).toEqual(["GuestSessionBinding", "DiningAdmission", "DiningAdmission"]);
  expect(seen.issues).toBe(3);
  // Not a table guest or a malformed code: no read at all.
  expect(await binding.validate({ ...session, channel: "Pickup" }, at)).toBe("Unavailable");
  expect(await binding.validate({ ...session, qrReference: "x" }, at)).toBe("Unavailable");
  expect(seen.issues).toBe(3);
  expect(runs).toBe(3);
});
