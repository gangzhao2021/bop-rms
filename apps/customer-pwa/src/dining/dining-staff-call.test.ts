import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diningStaffCallNotOfferedRecheckMs,
  createHttpDiningStaffCallClient,
  parseDiningStaffCallView,
} from "./dining-staff-call-client.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";

const call = "018f2331-0000-7000-8000-000000000030";
describe("WP-2423 Q28 staff call answer", () => {
  it("reads only what the server is expected to send", () => {
    expect(
      parseDiningStaffCallView({
        open: { callReference: call, reason: "OrderProblem", calledAt: "2026-10-25T18:00:00.000Z" },
        recentlyClosed: null,
        nextCallAt: null,
      }).open?.reason,
    ).toBe("OrderProblem");
    // WP-2423 (M171): an allergy question is a reason the server may send back.
    expect(
      parseDiningStaffCallView({
        open: {
          callReference: call,
          reason: "AllergyQuestion",
          calledAt: "2026-10-25T18:00:00.000Z",
        },
        recentlyClosed: null,
        nextCallAt: null,
      }).open?.reason,
    ).toBe("AllergyQuestion");
    for (const bad of [
      { open: null, recentlyClosed: null },
      {
        open: { callReference: call, reason: "Coffee", calledAt: "2026-10-25T18:00:00.000Z" },
        recentlyClosed: null,
        nextCallAt: null,
      },
      {
        open: null,
        recentlyClosed: { kind: "Expired", closedAt: "2026-10-25T18:00:00.000Z" },
        nextCallAt: null,
      },
      { open: null, recentlyClosed: null, nextCallAt: "soon" },
    ])
      expect(() => parseDiningStaffCallView(bad)).toThrow();
  });
  afterEach(() => setCustomerCsrfCredential(null));
  it("WP-2423 item 8 ⑦: a store that has calling staff off offers nothing (not an error)", async () => {
    setCustomerCsrfCredential("a".repeat(43));
    const client = createHttpDiningStaffCallClient(async () =>
      Response.json(
        {
          schemaVersion: 1,
          error: {
            code: "dining_staff_call_not_offered",
            messageKey: "customer.dining.staff_call.not_offered",
          },
        },
        { status: 409 },
      ),
    );
    await expect(client.read()).rejects.toMatchObject({ code: "not-offered" });
  });
  it("batch 52 (v15 b51 live): the Store's 'not offered' is kept a while, not asked on every visit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-23T07:00:00.000Z"));
      setCustomerCsrfCredential("b".repeat(43));
      const asked: string[] = [];
      const request = async (_input: RequestInfo | URL, init?: RequestInit) => {
        asked.push(init?.method ?? "GET");
        return Response.json(
          {
            schemaVersion: 1,
            error: {
              code: "dining_staff_call_not_offered",
              messageKey: "customer.dining.staff_call.not_offered",
            },
          },
          { status: 409 },
        );
      };
      // Each visit to Your table makes its own client, as the panel does.
      await expect(createHttpDiningStaffCallClient(request).read()).rejects.toMatchObject({
        code: "not-offered",
      });
      await expect(createHttpDiningStaffCallClient(request).read()).rejects.toMatchObject({
        code: "not-offered",
      });
      expect(asked).toEqual(["GET"]);
      // Later on, the Store may have turned calling staff on: it is asked again.
      vi.setSystemTime(Date.now() + diningStaffCallNotOfferedRecheckMs);
      await expect(createHttpDiningStaffCallClient(request).read()).rejects.toMatchObject({
        code: "not-offered",
      });
      expect(asked).toEqual(["GET", "GET"]);
      // A new visit (another credential) asks at once.
      setCustomerCsrfCredential("c".repeat(43));
      await expect(createHttpDiningStaffCallClient(request).read()).rejects.toMatchObject({
        code: "not-offered",
      });
      expect(asked).toEqual(["GET", "GET", "GET"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
