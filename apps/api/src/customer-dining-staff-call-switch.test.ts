import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the Guest identity and the Dining owner records are doubles; the port's own steps (who the
// guest is, the Store's switch, then the call) are the real code.
const state = vi.hoisted(() => ({ staffCall: false, calls: 0, withdrawals: 0 }));
const ref = (n: number) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");
vi.mock("@bop/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/identity")>();
  return {
    ...actual,
    GuestSessionService: class {
      authorize = async () => ({
        brandReference: ref(2),
        storeReference: ref(3),
        channel: "DineIn",
        diningState: "DiningBound",
        diningSessionReference: ref(10),
        diningParticipantReference: ref(11),
      });
    },
    assertGuestSessionUsable: () => undefined,
    createPostgresGuestSessionEntryStore: () => ({}),
    createPostgresFencedGuestSessionEntryStore: () => ({}),
  };
});
vi.mock("@rms/dining", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/dining")>();
  return {
    ...actual,
    loadDiningServiceSetting: async () => ({
      version: 1,
      staffCall: state.staffCall,
      chaseDish: false,
      changedAt: null,
    }),
    createPostgresDiningStaffCallStore: () => ({
      status: async () => ({ seated: true, open: null, recentlyClosed: null, nextCallAt: null }),
      call: async () => {
        state.calls++;
        return {
          status: "Called",
          call: {
            callReference: ref(20),
            reason: "Question",
            calledAt: "2026-10-29T15:00:00.000Z",
          },
        };
      },
      withdraw: async () => {
        state.withdrawals++;
        return { status: "Closed", kind: "Withdrawn" };
      },
    }),
  };
});

const { createCustomerDiningStaffCall } = await import("./customer-dining-staff-call.js");
const credential = "a".repeat(43);
const port = () =>
  createCustomerDiningStaffCall({
    scope: { tenantReference: ref(1), brandReference: ref(2), storeReference: ref(3) },
    transactions: { run: (work) => work({} as never) },
    credentials: {} as never,
    binding: () => ({ validate: async () => "Current" }) as never,
    hashIntent: (value) => value,
    newReference: () => ref(30),
    now: () => "2026-10-29T15:00:00.000Z",
  });
const guest = { sessionCredential: credential, csrfCredential: credential };

describe("WP-2423 item 8 ⑦: guests call staff only while the store has it on", () => {
  beforeEach(() => {
    state.staffCall = false;
    state.calls = 0;
    state.withdrawals = 0;
  });
  it("offers nothing and records no call while it is off", async () => {
    await expect(port().read(guest)).rejects.toMatchObject({ code: "NotOffered" });
    await expect(
      port().call({ ...guest, operationReference: ref(40), reason: "Question" }),
    ).rejects.toMatchObject({ code: "NotOffered" });
    expect(state.calls).toBe(0);
  });
  it("a call made before it was turned off can still be withdrawn", async () => {
    expect(
      await port().withdraw({ ...guest, operationReference: ref(41), callReference: ref(20) }),
    ).toBe("Withdrawn");
    expect(state.withdrawals).toBe(1);
  });
  it("reads and calls once it is on", async () => {
    state.staffCall = true;
    expect((await port().read(guest)).open).toBeNull();
    expect(
      (await port().call({ ...guest, operationReference: ref(42), reason: "Question" })).status,
    ).toBe("Called");
    expect(state.calls).toBe(1);
  });
});
