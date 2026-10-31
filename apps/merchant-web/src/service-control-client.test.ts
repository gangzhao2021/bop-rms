import { expect, it, vi } from "vitest";
import {
  createServiceControlClient,
  parseServiceControlState,
  serviceOperationReference,
} from "./service-control-client.js";
const store = "018f7f9a-ad3e-7a11-8d01-000000000003";
const hours = {
  configurationSource: "StoreOverride",
  effectiveFrom: "2026-07-29T11:00:00.000Z",
  effectiveUntil: null,
  businessDayStartLocalTime: "04:00:00",
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [],
  })),
  exceptions: [],
};
const state = {
  hours,
  screenId: "STORE-HOURS-SERVICE",
  storeReference: store,
  configurationReference: store,
  timeZone: "America/Toronto",
  enabledServiceModes: ["Pickup"],
  observedAt: "2026-07-29T12:00:00.000Z",
  expectedVersion: 0,
  activePauses: [],
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("rejects wrong scope, malformed version and inactive pause content", () => {
  expect(parseServiceControlState(state, store).expectedVersion).toBe(0);
  expect(() => parseServiceControlState(state, serviceOperationReference())).toThrow();
  expect(() => parseServiceControlState({ ...state, expectedVersion: -1 }, store)).toThrow();
  expect(() =>
    parseServiceControlState(
      {
        ...state,
        activePauses: [
          {
            closureReference: store,
            effectiveFrom: state.observedAt,
            effectiveUntil: state.observedAt,
            serviceModes: null,
          },
        ],
      },
      store,
    ),
  ).toThrow();
});
it("uses version7 random references for independent mutation and audit identity", () => {
  const first = serviceOperationReference();
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(serviceOperationReference()).not.toBe(first);
});
it("uses same-origin bounded transport and keeps retry identity", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(state));
  const client = createServiceControlClient(fetcher),
    signal = new AbortController().signal;
  expect(await client.load(store, signal)).toEqual(state);
  const command = {
    command: "PauseService" as const,
    operationReference: serviceOperationReference(),
    auditReference: serviceOperationReference(),
    configurationReference: store,
    expectedVersion: 0,
    content: { effectiveUntil: "2026-07-29T13:00:00.000Z", serviceModes: null },
  };
  fetcher
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockResolvedValueOnce(response({ status: "AlreadyApplied", resultingVersion: 1 }));
  await expect(client.execute(command, "synthetic-csrf", signal)).rejects.toThrow();
  await client.execute(command, "synthetic-csrf", signal);
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[2]?.[1]?.body);
  expect(fetcher).toHaveBeenLastCalledWith(
    "/merchant/service-control",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: expect.objectContaining({ "X-BOP-CSRF": "synthetic-csrf" }),
    }),
  );
});
it("discards a response after context cancellation", async () => {
  const abort = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    abort.abort();
    return response(state);
  });
  await expect(createServiceControlClient(fetcher).load(store, abort.signal)).rejects.toThrow();
});
it.each([403, 409, 503])(
  "maps denial/conflict/unavailable without echoing payload (%i)",
  async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private synthetic detail", { status }));
    await expect(
      createServiceControlClient(fetcher).load(store, new AbortController().signal),
    ).rejects.not.toThrow("private synthetic detail");
  },
);

it("validates complete published hours instead of accepting missing or malformed fields", () => {
  expect(parseServiceControlState(state, store).hours.businessDayStartLocalTime).toBe("04:00:00");
  for (const invalid of [
    { ...hours, weeklySchedule: [] },
    { ...hours, businessDayStartLocalTime: "25:00:00" },
    { ...hours, effectiveFrom: "2026-07-30T00:00:00.000Z" },
    { ...hours, exceptions: [{ localDate: "2026-02-30", kind: "Holiday", intervals: [] }] },
  ])
    expect(() => parseServiceControlState({ ...state, hours: invalid }, store)).toThrow();
});
