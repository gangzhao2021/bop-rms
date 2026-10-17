import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_INTERVAL_MS,
  activityRecorded,
  activityRetryMs,
  createStaffSessionClient,
  isOperationalScreen,
  remaining,
  sessionNotice,
  shouldReportActivity,
  type SessionDeadlines,
} from "./staff-session.js";
import { StaffSignedOutPanel } from "./StaffSession.js";

const base = Date.parse("2026-10-14T18:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
const deadlines = (idle: number, absolute = 720, offset = 0): SessionDeadlines => ({
  idleExpiresAt: at(idle),
  absoluteExpiresAt: at(absolute),
  idleTimeoutMinutes: 30,
  serverOffsetMs: offset,
});

describe("WP-2423 Q18 staff activity rule", () => {
  it("treats only the live operational screens as activity while visible", () => {
    for (const path of [
      "/operations/orders",
      "/operations/kitchen",
      "/operations/kitchen/work-items/1",
      "/operations/pickup",
      "/operations/dining",
    ])
      expect(isOperationalScreen(path)).toBe(true);
    for (const path of ["/app", "/app/operations/tables", "/operations/inventory", "/app/staff"])
      expect(isOperationalScreen(path)).toBe(false);
  });

  it("never reports from a hidden tab and reports at most once a minute", () => {
    const now = base;
    const report = (overrides: Partial<Parameters<typeof shouldReportActivity>[0]>) =>
      shouldReportActivity({
        visible: true,
        operational: false,
        lastInputAt: now - 1_000,
        lastReportAt: now - ACTIVITY_INTERVAL_MS,
        now,
        ...overrides,
      });
    expect(report({})).toBe(true);
    expect(report({ visible: false })).toBe(false);
    expect(report({ visible: false, operational: true })).toBe(false);
    expect(report({ lastReportAt: now - ACTIVITY_INTERVAL_MS + 1 })).toBe(false);
    // No input since the last report: only an operational screen keeps the Session alive.
    expect(report({ lastInputAt: now - 2 * ACTIVITY_INTERVAL_MS })).toBe(false);
    expect(report({ lastInputAt: now - 2 * ACTIVITY_INTERVAL_MS, operational: true })).toBe(true);
  });
});

describe("v15 c9b377cb activity that the server skipped", () => {
  it("counts a report only when the answer shows the idle deadline moved", () => {
    const now = base + 20 * 60_000;
    // Written: idle deadline is now + 30 min.
    expect(activityRecorded(deadlines(50), now)).toBe(true);
    // Within the one-minute write interval of the last write: nothing to do.
    expect(activityRecorded(deadlines(49), now)).toBe(true);
    // The row was busy and the server answered with the old deadline (signed in at minute 0).
    expect(activityRecorded(deadlines(30), now)).toBe(false);
    // The 12-hour cap: the deadline cannot move further.
    expect(activityRecorded(deadlines(725, 725), base + 710 * 60_000)).toBe(true);
    // Server clock 5 minutes ahead of the tablet.
    expect(activityRecorded(deadlines(55, 720, 5 * 60_000), now)).toBe(true);
    expect(activityRecorded(deadlines(50, 720, 5 * 60_000), now)).toBe(false);
  });

  it("retries a skipped report soon, backing off to a minute, off the page's read timers", () => {
    expect(activityRetryMs(1, () => 0)).toBe(5_000);
    expect(activityRetryMs(2, () => 0)).toBe(10_000);
    expect(activityRetryMs(3, () => 0.5)).toBe(21_000);
    expect(activityRetryMs(10, () => 0)).toBe(ACTIVITY_INTERVAL_MS);
    expect(activityRetryMs(1, () => 0.999)).toBeLessThan(7_000);
  });
});

describe("WP-2423 Q18 session notices", () => {
  it("warns two minutes before idle sign-out and ends at the idle deadline", () => {
    expect(sessionNotice(deadlines(30), base + 27 * 60_000)).toEqual({ kind: "None" });
    expect(sessionNotice(deadlines(30), base + 28 * 60_000)).toEqual({
      kind: "IdleWarning",
      at: at(30),
    });
    expect(sessionNotice(deadlines(30), base + 30 * 60_000)).toEqual({
      kind: "Ended",
      reason: "Idle",
    });
  });

  it("explains the 12-hour limit ten minutes ahead and ends there", () => {
    expect(sessionNotice(deadlines(715, 720), base + 709 * 60_000)).toEqual({ kind: "None" });
    expect(sessionNotice(deadlines(715 + 5, 720), base + 711 * 60_000)).toEqual({
      kind: "AbsoluteWarning",
      at: at(720),
    });
    // Idle deadline capped at the absolute deadline: no "stay signed in" offer.
    expect(sessionNotice(deadlines(720, 720), base + 719 * 60_000).kind).toBe("AbsoluteWarning");
    expect(sessionNotice(deadlines(720, 720), base + 720 * 60_000)).toEqual({
      kind: "Ended",
      reason: "Absolute",
    });
    // Idle sign-out that comes first is still offered "stay signed in".
    expect(sessionNotice(deadlines(713, 720), base + 712 * 60_000).kind).toBe("IdleWarning");
  });

  it("uses the server clock, not the device clock", () => {
    // The tablet clock is 5 minutes slow.
    expect(sessionNotice(deadlines(30, 720, 5 * 60_000), base + 24 * 60_000).kind).toBe(
      "IdleWarning",
    );
    expect(remaining(at(30), deadlines(30), base + 28 * 60_000 + 15_000)).toBe("1:45");
  });
});

describe("WP-2423 Q18 staff session client", () => {
  const response = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const body = {
    idleExpiresAt: at(50),
    absoluteExpiresAt: at(720),
    idleTimeoutMinutes: 30,
    serverTime: at(20),
  };

  it("posts activity with the CSRF header and measures the server clock offset", async () => {
    const request = vi.fn(async () => response(200, body));
    const client = createStaffSessionClient(request as typeof fetch, () => base + 19 * 60_000);
    expect(await client.activity("c".repeat(43))).toEqual({
      idleExpiresAt: at(50),
      absoluteExpiresAt: at(720),
      idleTimeoutMinutes: 30,
      serverOffsetMs: 60_000,
    });
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/merchant/session/activity");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ "X-BOP-CSRF": "c".repeat(43) });
  });

  it("reports an ended Session only on the explicit 401 session_ended answer", async () => {
    const ended = createStaffSessionClient(
      vi.fn(async () => response(401, { error: "session_ended" })) as typeof fetch,
    );
    expect(await ended.expiry("c".repeat(43))).toBe("Ended");
    expect(await ended.activity("c".repeat(43))).toBe("Ended");
    // A refused, busy or unavailable check is never an ended Session.
    for (const [status, body] of [
      [403, { error: "request_denied" }],
      [401, { error: "request_denied" }],
      [401, undefined],
      [503, { error: "session_check_unavailable" }],
      [500, undefined],
    ] as const) {
      const other = createStaffSessionClient(
        vi.fn(async () => response(status, body)) as typeof fetch,
      );
      await expect(other.activity("c".repeat(43))).rejects.toThrow("STAFF_SESSION_UNAVAILABLE");
    }
    const open = createStaffSessionClient(
      vi.fn(async () => response(200, { ...body, sessionReference: "x" })) as typeof fetch,
    );
    await expect(open.expiry("c".repeat(43))).rejects.toThrow("STAFF_SESSION_INVALID");
    const beyond = createStaffSessionClient(
      vi.fn(async () => response(200, { ...body, idleExpiresAt: at(721) })) as typeof fetch,
    );
    await expect(beyond.activity("c".repeat(43))).rejects.toThrow("STAFF_SESSION_INVALID");
    const down = createStaffSessionClient(vi.fn(async () => response(503)) as typeof fetch);
    await expect(down.activity("c".repeat(43))).rejects.toThrow("STAFF_SESSION_UNAVAILABLE");
  });

  it("accepts only a same-origin sign-in path", async () => {
    const pilot = createStaffSessionClient(
      vi.fn(async () =>
        response(200, { path: "/internal-test/staff", testOnly: true }),
      ) as typeof fetch,
    );
    expect(await pilot.signInEntry()).toEqual({ path: "/internal-test/staff", testOnly: true });
    for (const path of ["//evil.invalid/x", "https://evil.invalid/", "javascript:alert(1)"]) {
      const unsafe = createStaffSessionClient(
        vi.fn(async () => response(200, { path, testOnly: false })) as typeof fetch,
      );
      await expect(unsafe.signInEntry()).rejects.toThrow("STAFF_SIGN_IN_INVALID");
    }
  });

  it("signs out through the merchant logout", async () => {
    const request = vi.fn(async () => response(204));
    await createStaffSessionClient(request as typeof fetch).signOut();
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/merchant/logout");
    expect(init.method).toBe("POST");
    await expect(
      createStaffSessionClient(vi.fn(async () => response(500)) as typeof fetch).signOut(),
    ).rejects.toThrow("STAFF_SIGN_OUT_FAILED");
  });

  it("renders the signed-out panel without a hard-coded sign-in link", () => {
    const html = renderToStaticMarkup(createElement(StaffSignedOutPanel));
    expect(html).toContain("Sign in required");
    expect(html).toContain("Finding the sign-in page");
    expect(html).not.toContain("href=");
  });
});
