import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpDiningInvitationClient } from "./dining-invitation-client.js";
import { DiningInvitationView, type DiningInvitationState } from "./DiningInvitationPanel.js";
import { formatClockTime } from "../journey/format.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";

afterEach(() => setCustomerCsrfCredential(null));
const key = "01902423-0000-7000-8000-000000000001";
const expiresAt = "2026-10-17T18:15:00.000Z";
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe("WP-2423 DEC-DINING-GUEST-INVITATION client", () => {
  it("reads whether this guest may invite with only the CSRF header", async () => {
    setCustomerCsrfCredential("c".repeat(43));
    const request = vi.fn(async () =>
      json({ schemaVersion: 1, invitation: { canInvite: true } }, 200),
    );
    const client = createHttpDiningInvitationClient(request as unknown as typeof fetch);
    await expect(client.canInvite()).resolves.toBe(true);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/invitation");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ accept: "application/json", "x-csrf-token": "c".repeat(43) });
    request.mockResolvedValueOnce(json({ schemaVersion: 1, invitation: { canInvite: 1 } }, 200));
    await expect(client.canInvite()).rejects.toMatchObject({ code: "unavailable" });
    request.mockResolvedValueOnce(json({}, 404));
    await expect(client.canInvite()).rejects.toMatchObject({ code: "not-joined" });
  });

  it("issues with the request key, decodes the code and maps refusals", async () => {
    setCustomerCsrfCredential("c".repeat(43));
    const request = vi.fn(async () =>
      json({ schemaVersion: 1, invitation: { status: "Issued", code: "482913", expiresAt } }, 201),
    );
    const client = createHttpDiningInvitationClient(request as unknown as typeof fetch, () => key);
    expect(client.newOperationReference()).toBe(key);
    await expect(client.issue(key)).resolves.toEqual({
      status: "Issued",
      code: "482913",
      expiresAt,
    });
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.headers).toMatchObject({ "idempotency-key": key, "x-csrf-token": "c".repeat(43) });
    const error = (code: string) => ({ schemaVersion: 1, error: { code, messageKey: "x" } });
    for (const [response, expected] of [
      [
        json({ schemaVersion: 1, invitation: { status: "AlreadyIssued" } }, 200),
        { status: "Lost" },
      ],
      [json(error("dining_invitation_not_host"), 403), { status: "NotHost" }],
      [json(error("dining_invitation_table_changed"), 409), { status: "TableChanged" }],
      [
        json({ ...error("dining_invitation_rate_limited"), retryAt: expiresAt }, 429),
        { status: "TooMany", retryAt: expiresAt },
      ],
    ] as const) {
      request.mockResolvedValueOnce(response);
      await expect(client.issue(key)).resolves.toEqual(expected);
    }
    // A code that is not six digits is never shown.
    request.mockResolvedValueOnce(
      json({ schemaVersion: 1, invitation: { status: "Issued", code: "12345", expiresAt } }, 201),
    );
    await expect(client.issue(key)).rejects.toMatchObject({ code: "unavailable" });
    request.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.issue(key)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not call the server without this browser's session", async () => {
    const request = vi.fn();
    const client = createHttpDiningInvitationClient(request as unknown as typeof fetch);
    await expect(client.canInvite()).rejects.toMatchObject({ code: "not-joined" });
    await expect(client.issue(key)).rejects.toMatchObject({ code: "not-joined" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("WP-2423 DEC-DINING-GUEST-INVITATION panel", () => {
  const render = (state: DiningInvitationState) =>
    renderToStaticMarkup(<DiningInvitationView state={state} onMake={() => undefined} />);

  it("is absent for a guest who is not the table's host", () => {
    expect(render({ status: "hidden" })).toBe("");
  });

  it("offers the host a code in plain words", () => {
    const html = render({ status: "ready" });
    expect(html).toContain("Invite someone at your table");
    expect(html).toContain("They scan the QR code on the table, then enter the code");
    expect(html).toContain(">Make a code</button>");
  });

  it("shows the code grouped, readable by screen readers, with its one-time 15-minute rule", () => {
    const html = render({ status: "issued", code: "482913", expiresAt });
    expect(html).toContain('aria-hidden="true">482 913</span>');
    expect(html).toContain('<span class="sr-only">4 8 2 9 1 3</span>');
    expect(html).toContain("Show this code to the person joining you. It works once and for 15");
    expect(html).toContain(formatClockTime(expiresAt));
    expect(html).toContain("A new code replaces this one.");
    expect(html).toContain('role="status"');
  });

  it.each([
    [{ status: "expired" }, "This code has expired."],
    [{ status: "lost" }, "We couldn’t show that code. Make a new one."],
    [{ status: "not-host" }, "Only the person who joined this table first can make codes."],
    [{ status: "table-changed" }, "Ask a staff member for a code for your new table."],
    [
      { status: "too-many", retryAt: expiresAt },
      `You can make another at ${formatClockTime(expiresAt)}, or ask a staff member for one.`,
    ],
    [{ status: "failed", offline: true }, "You’re offline, so no code was made."],
    [{ status: "failed", offline: false }, "We couldn’t make a code. Try again"],
  ] as const)("explains %o without internal codes", (state, text) => {
    const html = render(state as DiningInvitationState);
    expect(html).toContain(text);
    expect(html).not.toMatch(/dining_invitation|Session|participant|capability/u);
  });
});
