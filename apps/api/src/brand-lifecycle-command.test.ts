import { beforeEach, expect, it, vi } from "vitest";
import { sha256Hex } from "@bop/audit";
import {
  createBrand,
  transitionBrand,
  parseBrandAdministrationReference,
  BrandAdministrationServiceError,
  type Brand,
  type BrandAdministrationOperation,
  type BrandLifecycleAdministrationRecordedOperation,
} from "@bop/tenant";
import {
  createBrandLifecycleCommand,
  executeBrandLifecycleAdministration,
  parseBrandLifecycleCommand,
} from "./brand-lifecycle-command.js";

const ports = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresBrandLifecycleStore: (...args: unknown[]) => ports.store(...args),
}));
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z";
const draft = () =>
  createBrand({
    brandReference: id(1),
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Draft",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
const command = () =>
  parseBrandLifecycleCommand({
    brandReference: id(1),
    action: "ActivateBrand",
    expectedBrandVersion: 1,
    operationReference: id(2),
  });
function fixture() {
  let current = draft(),
    recorded: BrandLifecycleAdministrationRecordedOperation | null = null;
  const allocate = vi.fn(() => id(4)),
    planned = vi.fn(),
    saved = vi.fn(),
    authorize = vi.fn(async () => true),
    load = vi.fn(async () => current),
    resolve = vi.fn(async () => recorded?.operation ?? null),
    resolveRecorded = vi.fn(async () => recorded);
  const commit = vi.fn(
    async (input: {
      operation: BrandAdministrationOperation;
      expectedBrandVersion: number;
      audit: {
        actorReference: string;
        purposeCode: string;
        auditReference: string;
        occurredAt: string;
      };
    }) => {
      current = createBrand(input.operation.artifact);
      recorded = {
        operation: input.operation,
        actorReference: input.audit.actorReference,
        purposeCode: "BRAND_ADMINISTRATION",
        auditReference: input.audit.auditReference,
        occurredAt: input.audit.occurredAt,
      };
      return input.operation;
    },
  );
  const store = {
    loadBrand: load,
    resolveOperation: resolve,
    resolveRecordedOperation: resolveRecorded,
    commit,
  };
  const options = {
    store,
    command: command(),
    actorReference: id(3),
    occurredAt: at,
    nextAuditReference: allocate,
    authorize,
    onPlanned: planned,
    onRecorded: saved,
  };
  return {
    options,
    store,
    allocate,
    planned,
    saved,
    commit,
    load,
    current: () => current,
    setCurrent(value: Brand) {
      current = value;
    },
    recorded: () => recorded,
    setRecorded(value: BrandLifecycleAdministrationRecordedOperation | null) {
      recorded = value;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.store.mockReset();
});
it("uses actual Tenant service for transition/digest and resolves original before allocation", async () => {
  const f = fixture();
  expect(await executeBrandLifecycleAdministration(f.options)).toEqual({
    profile: "MerchantBrandLifecycleReceiptV1",
    actorReference: id(3),
    brandReference: id(1),
    action: "ActivateBrand",
    operationReference: id(2),
    expectedBrandVersion: 1,
    status: "Applied",
    lifecycle: "Active",
    version: 2,
    occurredAt: at,
  });
  expect(f.planned).toHaveBeenCalledWith(
    draft(),
    transitionBrand(draft(), draft().version, "Active", at),
  );
  expect(f.allocate).toHaveBeenCalledOnce();
  expect(f.commit).toHaveBeenCalledOnce();
  const allocationOrder = f.allocate.mock.invocationCallOrder[0];
  if (allocationOrder === undefined) throw new Error("Expected recorded Audit allocation");
  expect(f.store.resolveRecordedOperation.mock.invocationCallOrder[0]).toBeLessThan(
    allocationOrder,
  );
  expect(f.recorded()?.operation.intentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
});
it("replays the actual immutable Active original after later Archive with no allocation or transition", async () => {
  const f = fixture();
  await executeBrandLifecycleAdministration(f.options);
  f.setCurrent(
    transitionBrand(f.current(), f.current().version, "Archived", "2026-10-06T10:00:01.000Z"),
  );
  f.allocate.mockClear();
  f.planned.mockClear();
  f.load.mockClear();
  f.commit.mockClear();
  const replay = await executeBrandLifecycleAdministration({
    ...f.options,
    occurredAt: "2026-10-06T10:00:02.000Z",
  });
  expect(replay).toMatchObject({
    status: "AlreadyApplied",
    lifecycle: "Active",
    version: 2,
    occurredAt: at,
  });
  expect(f.current().lifecycle).toBe("Archived");
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.planned).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.load).not.toHaveBeenCalled();
});
it.each(["Actor", "Purpose", "Audit", "Time", "Digest", "Action", "Expected"])(
  "rejects altered original %s without treating it as terminal Conflict",
  async (field) => {
    const f = fixture();
    await executeBrandLifecycleAdministration(f.options);
    const original = f.recorded();
    if (!original) throw new Error("Expected recorded lifecycle operation");
    if (field === "Actor") f.setRecorded({ ...original, actorReference: id(9) });
    if (field === "Purpose") f.setRecorded({ ...original, purposeCode: "OTHER" } as never);
    if (field === "Audit") f.setRecorded({ ...original, auditReference: id(9) });
    if (field === "Time") f.setRecorded({ ...original, occurredAt: "2026-10-06T10:00:01.000Z" });
    if (field === "Digest")
      f.setRecorded({
        ...original,
        operation: { ...original.operation, intentDigest: "sha256:" + "a".repeat(64) },
      });
    const next =
      field === "Action"
        ? { ...f.options, command: { ...command(), action: "ArchiveBrand" as const } }
        : field === "Expected"
          ? { ...f.options, command: { ...command(), expectedBrandVersion: 2 } }
          : f.options;
    f.allocate.mockClear();
    await expect(executeBrandLifecycleAdministration(next)).rejects.toMatchObject({
      code: "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.allocate).not.toHaveBeenCalled();
  },
);
it("returns narrow conflicts only for absent original and actual current version/lifecycle", async () => {
  const f = fixture();
  f.setCurrent(createBrand({ ...draft(), lifecycle: "Active", version: 2 }));
  expect(await executeBrandLifecycleAdministration(f.options)).toEqual({ conflict: "Version" });
  f.setCurrent(createBrand({ ...draft(), lifecycle: "Archived" }));
  expect(await executeBrandLifecycleAdministration(f.options)).toEqual({ conflict: "Lifecycle" });
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
});
it("keeps dependency failure and a future current observation unknown", async () => {
  const f = fixture();
  await expect(
    executeBrandLifecycleAdministration({
      ...f.options,
      command: { ...command(), expectedBrandVersion: 2 },
    }),
  ).rejects.toMatchObject({ code: "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE" });
  f.setCurrent(createBrand({ ...draft(), updatedAt: "2026-10-06T10:00:01.000Z" }));
  await expect(executeBrandLifecycleAdministration(f.options)).rejects.toMatchObject({
    code: "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE",
  });
  f.store.resolveRecordedOperation.mockRejectedValue(new Error("controlled source failure"));
  await expect(executeBrandLifecycleAdministration(f.options)).rejects.toThrow();
  expect(f.allocate).not.toHaveBeenCalled();
});
it("closed browser command refuses actor/time injection and getters", () => {
  expect(() => parseBrandLifecycleCommand({ ...command(), actorReference: id(3) })).toThrow();
  const getter = vi.fn(() => id(1));
  expect(() =>
    parseBrandLifecycleCommand({
      ...command(),
      get brandReference() {
        return getter();
      },
    }),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("preserves existing generic factory result and original service digest", async () => {
  const f = fixture();
  ports.store.mockReturnValue(f.store);
  const tx = { query: async () => ({ rows: [], rowCount: 0 }) };
  const execute = createBrandLifecycleCommand({
    transactions: { run: (work) => work(tx) },
    now: () => at,
    auditReference: () => id(4),
    authorize: async () => ({ actorReference: id(3), purposeCode: "BRAND_ADMINISTRATION" }),
  });
  expect(
    await execute({ sessionCookie: "controlled", csrf: "controlled", command: command() }),
  ).toEqual({ status: "Applied", brandReference: id(1), lifecycle: "Active", version: 2 });
  const input = {
    operationReference: parseBrandAdministrationReference(id(2)),
    actorReference: parseBrandAdministrationReference(id(3)),
    purposeCode: "BRAND_ADMINISTRATION",
    auditReference: parseBrandAdministrationReference(id(4)),
    expectedBrandVersion: 1,
    occurredAt: at,
    artifact: f.current(),
  };
  expect(f.recorded()?.operation.intentDigest).toBe(
    "sha256:" + sha256Hex(JSON.stringify({ command: "ActivateBrand", ...input })),
  );
  f.setCurrent(createBrand({ ...draft(), version: 3 }));
  f.setRecorded(null);
  await expect(
    execute({
      sessionCookie: "controlled",
      csrf: "controlled",
      command: { ...command(), operationReference: id(9) },
    }),
  ).rejects.toBeInstanceOf(BrandAdministrationServiceError);
});
