import { beforeEach, describe, expect, it, vi } from "vitest";

// The session lookup and the Dining and Kitchen owner records are doubles; the command's own
// steps (switch, dish still being made, retry, too soon) are the real code.
const state = vi.hoisted(() => ({
  chaseDish: true,
  making: [] as { workItemReference: string; orderBatchReference: string }[],
  recorded: new Set<string>(),
  tooSoon: null as string | null,
}));
const ref = (n: number) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async () => ({
    selected: { tenantReference: ref(1) },
    context: { brand: { brandReference: ref(2) } },
    store: { storeReference: ref(3) },
    actorReference: ref(4),
    allowed: async () => true,
  }),
}));
vi.mock("@rms/dining", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/dining")>()),
  loadDiningServiceSetting: async () => ({
    version: 1,
    staffCall: false,
    chaseDish: state.chaseDish,
    changedAt: null,
  }),
}));
vi.mock("@rms/kitchen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/kitchen")>();
  return {
    ...actual,
    listKitchenWorkItemsToMake: async () => state.making,
    kitchenWorkChaseRecorded: async (_tx: unknown, _scope: unknown, chase: string) =>
      state.recorded.has(chase),
    recordKitchenWorkChase: async (
      _tx: unknown,
      _scope: unknown,
      input: { chaseReference: string },
    ) => {
      if (state.tooSoon !== null) throw new actual.KitchenChaseTooSoonError(state.tooSoon);
      state.recorded.add(input.chaseReference);
      return { recorded: true };
    },
    listKitchenWorkChases: async () =>
      state.recorded.size === 0
        ? []
        : [
            {
              workItemReference: ref(50),
              orderItemReference: ref(60),
              count: state.recorded.size,
              lastChasedAt: "2026-10-29T15:00:00.000Z",
            },
          ],
  };
});

const { createMerchantDiningChase } = await import("./merchant-dining-chase.js");
const command = () =>
  createMerchantDiningChase({
    persistence: { transactions: { run: (work: (tx: unknown) => unknown) => work({}) } } as never,
    authentication: { authorize: async () => ({ sessionReference: ref(9) }) } as never,
    now: () => "2026-10-29T15:00:00.000Z",
  });
const chase = (operation: number) =>
  command()({
    sessionCookie: "cookie",
    csrf: "csrf",
    command: { orderItemReference: ref(60), operationReference: ref(operation) },
  });

describe("WP-2423 item 8 ⑦: a server chases a dish", () => {
  beforeEach(() => {
    state.chaseDish = true;
    state.making = [{ workItemReference: ref(50), orderBatchReference: ref(70) }];
    state.recorded = new Set();
    state.tooSoon = null;
  });
  it("chases a dish still being made, and a retry of the same chase records nothing new", async () => {
    expect(await chase(100)).toEqual({ status: "Chased", chaseCount: 1 });
    state.making = [];
    expect(await chase(100)).toEqual({ status: "AlreadyChased", chaseCount: 1 });
  });
  it("refuses while the store has chasing off, for a dish no longer being made, and too soon", async () => {
    state.chaseDish = false;
    await expect(chase(101)).rejects.toMatchObject({ code: "DINING_CHASE_NOT_OFFERED" });
    state.chaseDish = true;
    state.making = [];
    await expect(chase(102)).rejects.toMatchObject({ code: "DINING_CHASE_NOT_BEING_MADE" });
    state.making = [{ workItemReference: ref(50), orderBatchReference: ref(70) }];
    state.tooSoon = "2026-10-29T15:05:00.000Z";
    await expect(chase(103)).rejects.toMatchObject({
      code: "DINING_CHASE_TOO_SOON",
      retryAt: "2026-10-29T15:05:00.000Z",
    });
    await expect(
      command()({ sessionCookie: "c", csrf: "c", command: { orderItemReference: "x" } }),
    ).rejects.toMatchObject({ code: "DINING_CHASE_INPUT_INVALID" });
  });
});
