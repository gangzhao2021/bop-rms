import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  createSoleOperatorClient,
  parseSoleOperatorView,
  SoleOperatorClientError,
} from "./sole-operator-client.js";
import { SoleOperatorSection } from "./SoleOperatorSection.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "c".repeat(43);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const view = {
  observedAt: "2026-10-13T12:00:00.000Z",
  state: "On",
  version: 1,
  history: [
    {
      version: 1,
      state: "On",
      reasonCode: "OWNER_RUNS_STORE_ALONE",
      recordedAt: "2026-10-13T11:00:00.000Z",
      changedByYou: true,
      changedByName: "Sam",
    },
  ],
  refundApproval: {
    status: "OtherApprovers",
    youHoldApproval: true,
    otherApprovers: [{ displayName: "Mia" }],
  },
  verifiedUntil: null,
  reasons: { On: ["OWNER_RUNS_STORE_ALONE"], Off: ["OWNER_CHOICE"] },
};

it("WP-2423 Q19: reads the setting strictly and hides it from anyone but the Brand Owner", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(view))
    .mockResolvedValueOnce(json({ ...view, state: "Maybe" }))
    .mockResolvedValueOnce(json({ error: "brand_owner_required" }, 403))
    // WP-2423: a Store Manager is told there is nothing to show (no refused request).
    .mockResolvedValueOnce(json({ brandOwner: false }))
    .mockResolvedValueOnce(json({ brandOwner: true }));
  const client = createSoleOperatorClient(fetcher);
  const read = await client.read();
  expect(read?.refundApproval.otherApprovers).toEqual([{ displayName: "Mia" }]);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/organization/sole-operator");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" });
  await expect(client.read()).rejects.toMatchObject({ code: "Unavailable" });
  await expect(client.read()).rejects.toMatchObject({ code: "Denied" });
  await expect(client.read()).resolves.toBeNull();
  await expect(client.read()).rejects.toMatchObject({ code: "Unavailable" });
});

it("WP-2423 Q19: changes the setting with a reason for the target state and names refusals", async () => {
  const command = {
    state: "Off" as const,
    reasonCode: "OWNER_CHOICE" as const,
    expectedVersion: 1,
    operationReference: id(1),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({ status: "Created", state: "Off", version: 2, recordedAt: "2026-10-13T12:01:00.000Z" }),
    )
    .mockResolvedValueOnce(json({ error: "needs_reverification" }, 409))
    .mockResolvedValueOnce(json({ error: "setting_changed" }, 409))
    .mockResolvedValueOnce(json({ error: "no_change" }, 409))
    .mockResolvedValueOnce(json({ error: "brand_owner_required" }, 403))
    .mockRejectedValueOnce(new Error("offline"));
  const client = createSoleOperatorClient(fetcher);
  await expect(client.change(command, csrf)).resolves.toEqual({
    state: "Off",
    version: 2,
    recordedAt: "2026-10-13T12:01:00.000Z",
  });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(command);
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-BOP-CSRF": csrf });
  for (const code of ["NeedsReverification", "Changed", "NoChange", "Denied", "OutcomeUnknown"]) {
    const error = await client.change(command, csrf).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SoleOperatorClientError);
    expect(error).toMatchObject({ code });
  }
  // A reason that belongs to the other state never leaves the browser.
  await expect(
    client.change({ ...command, reasonCode: "OWNER_RUNS_STORE_ALONE" }, csrf),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it("WP-2423: a PIN sign-in refusal is not reported as a missing permission", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ error: "full_sign_in_required" }, 403))
    .mockResolvedValueOnce(json({ error: "brand_owner_required" }, 403));
  const client = createSoleOperatorClient(fetcher);
  const command = {
    state: "Off" as const,
    reasonCode: "OWNER_CHOICE" as const,
    expectedVersion: 1,
    operationReference: id(1),
  };
  await expect(client.change(command, csrf)).rejects.toMatchObject({
    code: "FullSignInRequired",
  });
  await expect(client.change(command, csrf)).rejects.toMatchObject({ code: "Denied" });
});

it("WP-2423 Q19: the section renders nothing until the Brand Owner's setting is read", () => {
  expect(parseSoleOperatorView(view).state).toBe("On");
  const html = renderToStaticMarkup(
    createElement(SoleOperatorSection, {
      csrf,
      verifiedUntil: null,
      onVerified: () => undefined,
      fetcher: vi.fn<typeof fetch>(),
    }),
  );
  expect(html).toBe("");
});
