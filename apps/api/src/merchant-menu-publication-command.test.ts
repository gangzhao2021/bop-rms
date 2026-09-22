import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import type { MenuPublicationCommand, MenuPublicationPorts } from "@rms/catalog";

const state = vi.hoisted(() => ({
  createdInput: null as unknown,
  executed: null as unknown,
  changed: false,
  permission: true,
  dependencyReads: 0,
  evidenceReads: 0,
  permissionReads: 0,
  scope: null as unknown,
  binding: null as unknown,
  validation: null as unknown,
}));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => async () => state.scope,
}));
vi.mock("./menu-review-preparation-source.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./menu-review-preparation-source.js")>();
  return {
    ...original,
    createMenuReviewDependencyBindingSource: () => ({
      resolve: async () => {
        state.dependencyReads++;
        if (state.changed) throw new original.MenuReviewDependencyChangedError();
        return state.binding;
      },
    }),
  };
});
vi.mock("./menu-review-creation-source.js", () => ({
  createMenuReviewCreationSource: (options: {
    authorize: (tx: unknown, input: unknown) => Promise<boolean>;
  }) => ({
    create: async (tx: unknown, input: { actorReference: string; menuReference: string }) => {
      if (!(await options.authorize(tx, { ...input, storeReference: null, owner: "Publishing" })))
        throw Object.assign(new Error("synthetic denied"), { code: "CATALOG_PERMISSION_DENIED" });
      state.createdInput = input;
      return { status: "AlreadyCreated", record: { ...(state.binding as object), createdAt: at } };
    },
  }),
}));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  createPostgresMenuDraftSource: () => ({
    load: async () => ({
      aggregate: { draft: { versionReference: id(3) } },
      configurationDigest: digest,
    }),
  }),
  createPostgresMenuPublicationRepository: () => ({ resolveOperation: async () => null }),
  createPostgresMenuPublicationEvidenceSource: () => async () => {
    state.evidenceReads++;
    return { draft: null, validation: state.validation, approval: null };
  },
  createMenuPublicationService: (ports: MenuPublicationPorts) => ({
    execute: async (command: MenuPublicationCommand) => {
      state.executed = command;
      await ports.evidence.validation(command);
      await ports.evidence.validation(command);
      return {
        status: "Applied",
        record: { lifecycle: { version: 2, state: "Approved" }, release: null },
      };
    },
  }),
}));
const id = (n: number) => "01902405-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-13T18:00:00.000Z";
const digest = "sha256:" + "a".repeat(64);
beforeEach(() => {
  state.createdInput = null;
  state.executed = null;
  state.changed = false;
  state.permission = true;
  state.dependencyReads = 0;
  state.evidenceReads = 0;
  state.permissionReads = 0;
  state.binding = {
    lifecycleReference: id(4),
    snapshotDigest: digest,
    configurationDigest: digest,
  };
  state.validation = { evidenceReference: id(5) };
  state.scope = {
    tenantReference: id(6),
    actorReference: id(7),
    context: { brand: { brandReference: id(1) } },
    authorizeAction: async (action: string) => {
      state.permissionReads++;
      return { effect: state.permission ? "Allow" : "Deny", scopeKind: "Brand", action };
    },
  };
});
function handler(reviewCreation = false) {
  return createMerchantMenuPublicationCommand({
    ...(reviewCreation
      ? {
          reviewCreation: {
            budget: { maximumConfigurations: 10, maximumSearchSteps: 100 },
            reference: () => id(11),
          },
        }
      : {}),
    merchant: {
      now: () => "2026-08-13T18:00:01.000Z",
      transactions: {
        run: async (work: (tx: unknown) => Promise<unknown>) =>
          work({ query: async () => ({ rows: [], rowCount: 0 }) }),
      },
    },
    authentication: { authorize: async () => ({ sessionReference: id(8) }) },
    binding: async () => state.binding,
    reference: () => id(9),
  } as never);
}
const request = (action: string) => ({
  sessionCookie: "synthetic-cookie",
  csrf: "synthetic-csrf",
  command: {
    action,
    operationReference: id(10),
    menuReference: id(2),
    menuVersionReference: id(3),
    expectedVersion: 1,
    snapshotDigest: digest,
    effectivePeriod:
      action === "Publish"
        ? {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          }
        : null,
  },
});
it.each(["SubmitReview", "Approve", "Publish"])(
  "rejects changed dependencies before %s",
  async (action) => {
    state.changed = true;
    await expect(handler()(request(action))).rejects.toMatchObject({
      code: "CATALOG_VERSION_CONFLICT",
    });
    expect(state.dependencyReads).toBe(1);
  },
);
it("reuses evidence only within the transaction while checking permission again", async () => {
  const execute = handler();
  await expect(execute(request("Publish"))).resolves.toMatchObject({ status: "Applied" });
  expect(state.dependencyReads).toBe(1);
  expect(state.evidenceReads).toBe(1);
  expect(state.permissionReads).toBeGreaterThan(2);
  await execute(request("Publish"));
  expect(state.dependencyReads).toBe(2);
  expect(state.evidenceReads).toBe(2);
});

const reviewRequest = () => ({
  sessionCookie: "synthetic-cookie",
  csrf: "synthetic-csrf",
  command: {
    action: "CreateReview",
    operationReference: id(10),
    menuReference: id(2),
    menuVersionReference: id(3),
    expectedVersion: 1,
    configurationDigest: digest,
    registryVersionReference: id(12),
  },
});
it("creates review using server identity and submits its original snapshot and time", async () => {
  await expect(handler(true)(reviewRequest())).resolves.toMatchObject({
    status: "Applied",
    snapshotDigest: digest,
  });
  expect(state.createdInput).toMatchObject({
    actorReference: id(7),
    menuReference: id(2),
    observedAt: "2026-08-13T18:00:01.000Z",
    configurationDigest: digest,
    registryVersionReference: id(12),
  });
  expect(state.executed).toMatchObject({
    action: "SubmitReview",
    snapshotDigest: digest,
    requestedAt: at,
    expectedVersion: 1,
  });
});
it("requires explicit review configuration and rejects client authority or versions", async () => {
  await expect(handler()(reviewRequest())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  for (const patch of [{ actorReference: id(20) }, { expectedVersion: 2 }, { requestedAt: at }]) {
    const input = reviewRequest();
    await expect(
      handler(true)({ ...input, command: { ...input.command, ...patch } }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  }
  expect(state.createdInput).toBeNull();
});
