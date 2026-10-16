import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  assertCatalogProductTaxClassificationRegistrySuccessor,
  catalogProductTaxClassificationRegistryDigest,
  parseCatalogTaxClassificationRegistryCommand,
  type CatalogProductTaxClassificationRegistry,
  type ProductTaxClassificationRegistryStoreOptions,
} from "@rms/catalog";
import {
  MerchantTaxClassificationError,
  createMerchantTaxClassifications,
  parseTaxClassificationCommandBody,
} from "./merchant-tax-classifications.js";

/**
 * Isolated composition: a synthetic Brand scope and an in-memory registry owner that calls the
 * composed authority and pre-COMMIT hooks the way the Postgres owner does. The restricted-role
 * database acceptance (packages/database tax-classification-admin) proves SQL, RLS and grants.
 */
type Command = ReturnType<typeof parseCatalogTaxClassificationRegistryCommand>;
const db = vi.hoisted(() => ({
  history: [] as { command: Command; registry: CatalogProductTaxClassificationRegistry }[],
  audits: [] as unknown[],
  holds: [] as { action: string; mode: string }[],
  outage: false,
}));
vi.mock("@rms/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/catalog")>();
  return {
    ...actual,
    createPostgresProductTaxClassificationRegistryStore: (
      options: ProductTaxClassificationRegistryStoreOptions,
    ) => {
      const hold = async (
        tx: unknown,
        action: "catalog.tax-classification.read" | "catalog.tax-classification.manage",
        mode: "Intent" | "Register" | "Replay" | "Read",
        registry: CatalogProductTaxClassificationRegistry | null,
      ) => {
        db.holds.push({ action, mode });
        await options.authority.holdUntilTransactionCompletes(tx as never, {
          tenantReference: options.tenantReference,
          brandReference: options.brandReference,
          actorReference: options.actorReference,
          actorKind: options.actorKind,
          purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
          permission: "catalog.manage",
          action,
          mode,
          registry,
          requiredFields: actual.taxClassificationRegistryFields,
          observedAt: options.clock.now(),
        });
      };
      return {
        withCurrentRegistry: (observation: unknown, work: (source: unknown) => unknown) =>
          options.transactions.run(async (tx) => {
            let bound: CatalogProductTaxClassificationRegistry | null = null;
            await options.registerBeforeCommit(
              tx,
              async () => {
                if (bound === null) throw new actual.CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
                await hold(tx, "catalog.tax-classification.read", "Read", bound);
              },
              () => undefined,
            );
            await hold(tx, "catalog.tax-classification.read", "Read", null);
            if (db.outage) throw new actual.CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            const current = db.history.at(-1)?.registry ?? null;
            if (current === null)
              throw new actual.CatalogError("CATALOG_TAX_CLASSIFICATION_NOT_REGISTERED");
            bound = current;
            return work({
              registry: current,
              snapshotDigest: actual.catalogProductTaxClassificationRegistryDigest(current),
              observation,
              sourceAuthority: "CurrentTransactionHeld",
            });
          }),
        execute: async (value: unknown) => {
          const command = actual.parseCatalogTaxClassificationRegistryCommand(value);
          return options.transactions.run(async (tx) => {
            await options.registerBeforeCommit(
              tx,
              () => hold(tx, "catalog.tax-classification.manage", "Register", command.registry),
              () => undefined,
            );
            await hold(tx, "catalog.tax-classification.manage", "Intent", null);
            const original = db.history.find(
              (entry) => entry.command.operationReference === command.operationReference,
            );
            if (original) {
              if (original.command.intentDigest !== command.intentDigest)
                throw new actual.CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
              return { status: "Replayed", registry: original.registry };
            }
            const current = db.history.at(-1)?.registry ?? null;
            if ((current?.registryVersion ?? 0) !== command.expectedRegistryVersion)
              throw new actual.CatalogError("CATALOG_VERSION_CONFLICT");
            actual.assertCatalogProductTaxClassificationRegistrySuccessor(
              current,
              command.registry,
            );
            await hold(tx, "catalog.tax-classification.manage", "Register", command.registry);
            const pending = (tx as unknown as { writes: (() => void)[] }).writes;
            const audit = options.audit?.create(command);
            pending.push(() => {
              db.history.push({ command, registry: command.registry });
              db.audits.push(audit);
            });
            return { status: "Applied", registry: command.registry };
          });
        },
      };
    },
  };
});

const id = (n: number) => `01902423-7a00-7000-8000-${n.toString(16).padStart(12, "0")}`;
const owner = id(4),
  operation = (n: number) => `0199e8a0-${n.toString(16).padStart(4, "0")}-7000-8000-000000000001`;
let clock = Date.parse("2026-10-15T12:00:00.000Z");
const now = () => new Date((clock += 7)).toISOString();
const ownerActions = [
  "catalog.manage",
  "catalog.tax-classification.read",
  "catalog.tax-classification.manage",
];
const menuManagerActions = ["catalog.manage", "catalog.tax-classification.read"];
function brandScope(allowed: () => readonly string[], actor = owner) {
  return {
    tenantReference: id(1),
    selectedStoreReference: id(3),
    actorReference: actor,
    context: { brand: { brandReference: id(2), defaultLocale: "en-CA" } },
    authorizeActionsWithValidity: vi.fn(async (actions: readonly string[]) => ({
      decisions: actions.map((action) => ({
        action,
        effect: allowed().includes(action) ? "Allow" : "Deny",
        scopeKind: "Brand",
      })),
      validUntil: null,
    })),
  };
}
function harness(allowedAt: (call: number) => readonly string[] = () => ownerActions) {
  let calls = 0;
  const resolveScope = vi.fn(async () => {
    const call = ++calls;
    return brandScope(() => allowedAt(call));
  });
  const committed: number[] = [];
  const persistence = {
    now,
    transactions: {
      async run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
        const tx = { writes: [] as (() => void)[], query: vi.fn() };
        const result = await work(tx);
        for (const write of tx.writes) write();
        committed.push(tx.writes.length);
        return result;
      },
    },
  };
  const bff = createMerchantTaxClassifications({
    persistence: persistence as never,
    authentication: { authorize: vi.fn(async () => ({ sessionReference: id(9) })) } as never,
    resolveScope: resolveScope as never,
  });
  const input = { sessionCookie: "c".repeat(43), csrf: "x".repeat(43) };
  return {
    bff,
    resolveScope,
    committed,
    query: () => bff.query(input),
    command: (body: unknown) => bff.command({ ...input, body }),
  };
}
const add = (n: number, expected: number, ...names: string[]) => ({
  action: "Add",
  operationReference: operation(n),
  expectedRegistryVersion: expected,
  classifications: names.map((name) => ({ names: { "en-CA": name } })),
});
const refusal = (code: MerchantTaxClassificationError["code"]) =>
  expect.objectContaining({ name: "MerchantTaxClassificationError", code });

beforeEach(() => {
  db.history.length = 0;
  db.audits.length = 0;
  db.holds.length = 0;
  db.outage = false;
});

describe("WP-2423 Brand tax classifications (merchant BFF)", () => {
  it("parses only closed command bodies with UUIDv7 references and the two name languages", () => {
    expect(parseTaxClassificationCommandBody(add(1, 0, "Fees"))).toEqual({
      action: "Add",
      operationReference: operation(1),
      expectedRegistryVersion: 0,
      classifications: [{ names: { "en-CA": "Fees" } }],
    });
    expect(
      parseTaxClassificationCommandBody({
        action: "Rename",
        operationReference: operation(2),
        expectedRegistryVersion: 1,
        classificationReference: id(7),
        names: { "en-CA": "  Prepared   food ", "fr-CA": "" },
      }),
    ).toMatchObject({ names: { "en-CA": "Prepared food" } });
    for (const body of [
      null,
      { ...add(1, 0, "Fees"), extra: true },
      { ...add(1, 0, "Fees"), classifications: [] },
      { ...add(1, 0, "Fees"), operationReference: "not-a-reference" },
      { ...add(1, 0, "Fees"), expectedRegistryVersion: -1 },
      { ...add(1, 0), classifications: [{ names: { "de-DE": "Gebühren" } }] },
      { ...add(1, 0), classifications: [{ names: { "en-CA": "  " } }] },
      {
        action: "Inactivate",
        operationReference: operation(1),
        expectedRegistryVersion: 1,
        classificationReference: id(7),
      },
      {
        action: "Retire",
        operationReference: operation(1),
        expectedRegistryVersion: 1,
        classificationReference: null,
      },
    ])
      expect(() => parseTaxClassificationCommandBody(body)).toThrow(MerchantTaxClassificationError);
  });

  it("shows an empty list before the first classification, with manage rights for the Brand Owner", async () => {
    const h = harness();
    const view = await h.query();
    expect(view).toMatchObject({
      screenId: "CAT-TAX-CLASSIFICATION-LIST",
      permissions: { mayManage: true },
      registryVersion: 0,
      defaultLocale: "en-CA",
      locales: ["en-CA", "fr-CA"],
      classifications: [],
    });
    // Resolved in full at the start and once more before the reply; owner reads took the guard.
    expect(h.resolveScope).toHaveBeenCalledTimes(2);
  });

  it("adds, renames, sets the default and retires as append-only versions, with audit", async () => {
    const h = harness();
    const first = await h.command(add(1, 0, "Prepared food", "Alcohol"));
    expect(first.status).toBe("Applied");
    expect(first.view.registryVersion).toBe(1);
    expect(first.view.classifications.map((c) => c.names["en-CA"])).toEqual([
      "Alcohol",
      "Prepared food",
    ]);
    const record = db.history[0];
    expect(record?.command.reasonCode).toBe("TAX_CLASSIFICATIONS_ADDED");
    expect(record?.registry.definitions.map((d) => d.code).sort()).toEqual([
      "ALCOHOL",
      "PREPARED_FOOD",
    ]);
    expect(db.audits[0]).toMatchObject({
      actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
      targetType: "CatalogTaxClassificationRegistry",
      reasonCode: "TAX_CLASSIFICATIONS_ADDED",
      actor: { type: "User", reference: owner },
      sourceChannel: "MERCHANT_WEB",
    });
    const alcohol = first.view.classifications.find((c) => c.names["en-CA"] === "Alcohol");
    const food = first.view.classifications.find((c) => c.names["en-CA"] === "Prepared food");
    const renamed = await h.command({
      action: "Rename",
      operationReference: operation(2),
      expectedRegistryVersion: 1,
      classificationReference: alcohol?.classificationReference,
      names: { "en-CA": "Alcoholic drinks", "fr-CA": "Boissons alcoolisées" },
    });
    expect(renamed.view.registryVersion).toBe(2);
    const withDefault = await h.command({
      action: "SetDefault",
      operationReference: operation(3),
      expectedRegistryVersion: 2,
      classificationReference: food?.classificationReference,
    });
    expect(withDefault.view.classifications.find((c) => c.isDefault)?.names["en-CA"]).toBe(
      "Prepared food",
    );
    const retired = await h.command({
      action: "Retire",
      operationReference: operation(4),
      expectedRegistryVersion: 3,
      classificationReference: food?.classificationReference,
    });
    expect(retired.view.registryVersion).toBe(4);
    expect(retired.view.classifications.find((c) => c.isDefault)).toBeUndefined();
    expect(
      retired.view.classifications.find(
        (c) => c.classificationReference === food?.classificationReference,
      )?.lifecycle,
    ).toBe("Retired");
    expect(db.history.map((entry) => entry.command.reasonCode)).toEqual([
      "TAX_CLASSIFICATIONS_ADDED",
      "TAX_CLASSIFICATION_RENAMED",
      "TAX_CLASSIFICATION_DEFAULT_CHANGED",
      "TAX_CLASSIFICATION_RETIRED",
    ]);
    // Each version chains to the previous snapshot, as the owner requires.
    for (let i = 1; i < db.history.length; i++)
      expect(db.history[i]?.registry.previousSnapshotDigest).toBe(
        catalogProductTaxClassificationRegistryDigest(db.history[i - 1]?.registry),
      );
    // A retired classification cannot come back.
    await expect(
      h.command({
        action: "SetDefault",
        operationReference: operation(5),
        expectedRegistryVersion: 4,
        classificationReference: food?.classificationReference,
      }),
    ).rejects.toEqual(refusal("Retired"));
    expect(() =>
      assertCatalogProductTaxClassificationRegistrySuccessor(
        db.history[3]?.registry ?? null,
        db.history[3]?.registry as never,
      ),
    ).toThrow(CatalogError);
  });

  it("replays a retried operation and refuses a changed intent or a stale version as a conflict", async () => {
    const h = harness();
    const first = await h.command(add(1, 0, "Fees"));
    const again = await h.command(add(1, 0, "Fees"));
    expect(again.status).toBe("Replayed");
    expect(again.view.classifications).toEqual(first.view.classifications);
    expect(db.history).toHaveLength(1);
    // Same operation, different change: the list moved on, so it is a conflict, not a replay.
    await expect(h.command(add(1, 0, "Alcohol"))).rejects.toEqual(refusal("Conflict"));
    // Same operation reused against the current version: the owner's idempotency check refuses it.
    await expect(h.command(add(1, 1, "Alcohol"))).rejects.toEqual(refusal("Conflict"));
    // Someone else changed the list after this page loaded.
    await expect(h.command(add(2, 0, "Alcohol"))).rejects.toEqual(refusal("Conflict"));
    expect(db.history).toHaveLength(1);
  });

  it("refuses names already in use and unknown classifications in plain codes", async () => {
    const h = harness();
    await h.command(add(1, 0, "Fees"));
    await expect(h.command(add(2, 1, "FEES"))).rejects.toEqual(refusal("NameTaken"));
    await expect(
      h.command({
        action: "Retire",
        operationReference: operation(3),
        expectedRegistryVersion: 1,
        classificationReference: id(77),
      }),
    ).rejects.toEqual(refusal("NotFound"));
    expect(db.history).toHaveLength(1);
  });

  it("lets a Menu Manager read the list without changing it, and refuses others", async () => {
    const menu = harness(() => menuManagerActions);
    expect((await menu.query()).permissions.mayManage).toBe(false);
    db.holds.length = 0;
    await expect(menu.command(add(1, 0, "Fees"))).rejects.toEqual(refusal("PermissionDenied"));
    expect(db.history).toHaveLength(0);
    expect(db.holds).toEqual([]);
    const storeManager = harness(() => []);
    await expect(storeManager.query()).rejects.toEqual(refusal("PermissionDenied"));
  });

  it("commits nothing when the permission is withdrawn before COMMIT", async () => {
    const h = harness((call) => (call === 1 ? ownerActions : menuManagerActions));
    await expect(h.command(add(1, 0, "Fees"))).rejects.toEqual(refusal("PermissionDenied"));
    // The fake runner applies writes only after work resolves; the refusal rolled them back.
    expect(db.history).toHaveLength(0);
  });

  it("maps an owner outage to Unavailable without exposing its code", async () => {
    const h = harness();
    db.outage = true;
    await expect(h.query()).rejects.toEqual(refusal("Unavailable"));
  });
});
