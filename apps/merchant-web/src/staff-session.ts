/**
 * WP-2423 Q18 (DEC-STAFF-SESSION-CONTINUITY): keep a staff member signed in while they work, warn
 * before the Session ends, and send them to a working sign-in when it has ended.
 *
 * Activity rule: only a visible document reports activity. It reports when staff used the screen
 * (pointer, touch or key input) or when an operational screen (Orders, Kitchen, Pickup, Tables) is
 * on screen, at most once a minute. A hidden or background tab never reports, so it cannot keep a
 * Session alive; the server additionally never extends past the 12-hour absolute limit.
 */

export interface SessionDeadlines {
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly idleTimeoutMinutes: number;
  /** Server clock minus browser clock, measured when the deadlines were read. */
  readonly serverOffsetMs: number;
}

export interface SignInEntry {
  readonly path: string;
  readonly testOnly: boolean;
}

export type SessionRead = SessionDeadlines | "Ended";

export interface StaffSessionClient {
  activity(csrf: string): Promise<SessionRead>;
  expiry(csrf: string): Promise<SessionRead>;
  signInEntry(): Promise<SignInEntry>;
  signOut(): Promise<void>;
}

export const ACTIVITY_INTERVAL_MS = 60_000;
export const IDLE_WARNING_MS = 2 * 60_000;
export const ABSOLUTE_WARNING_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SIGN_IN_PATH = /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,200}$/u;

const operationalScreens = [/^\/operations\/(orders|kitchen|pickup|dining)(\/|$)/u];

/**
 * Screens staff keep open to watch live work; while visible they count as activity. A visible
 * staff screen also counts while a paid order is waiting for acceptance with a refund deadline
 * (the guard's `awaitingAcceptance`): the screen is then alerting staff to live work.
 */
export function isOperationalScreen(path: string): boolean {
  return operationalScreens.some((pattern) => pattern.test(path));
}

export function shouldReportActivity(input: {
  readonly visible: boolean;
  readonly operational: boolean;
  readonly lastInputAt: number;
  readonly lastReportAt: number;
  readonly now: number;
}): boolean {
  if (!input.visible) return false;
  if (input.now - input.lastReportAt < ACTIVITY_INTERVAL_MS) return false;
  return input.operational || input.lastInputAt > input.lastReportAt;
}

/**
 * v15 c9b377cb defect 1: the server records activity at most once a minute, and skips the write
 * (answering 200 with the unchanged deadlines) while the page's own reads hold the Session row.
 * Those reads run on 15/30-second timers started with the page, so a report due on the same
 * minute collided every time and staff were signed out 30 minutes after sign-in although they had
 * used the screen. A report counts only when the answer shows the idle deadline was moved (or is
 * already within the write interval of "now + idle time", or capped at the 12-hour limit).
 */
export function activityRecorded(deadlines: SessionDeadlines, browserNow: number): boolean {
  const serverNow = browserNow + deadlines.serverOffsetMs;
  const expected = Math.min(
    serverNow + deadlines.idleTimeoutMinutes * 60_000 - ACTIVITY_INTERVAL_MS - 30_000,
    Date.parse(deadlines.absoluteExpiresAt),
  );
  return Date.parse(deadlines.idleExpiresAt) >= expected;
}

/** Retry delay after an unrecorded (busy) report: 5 s doubling to 60 s, with up to 2 s jitter. */
export function activityRetryMs(misses: number, random: () => number = Math.random): number {
  return (
    Math.min(ACTIVITY_RETRY_MS * 2 ** Math.max(0, misses - 1), ACTIVITY_INTERVAL_MS) +
    Math.floor(random() * 2_000)
  );
}

export const ACTIVITY_RETRY_MS = 5_000;

export type SessionNotice =
  | { readonly kind: "None" }
  | { readonly kind: "IdleWarning"; readonly at: string }
  | { readonly kind: "AbsoluteWarning"; readonly at: string }
  | { readonly kind: "Ended"; readonly reason: "Idle" | "Absolute" };

export function sessionNotice(deadlines: SessionDeadlines, browserNow: number): SessionNotice {
  const now = browserNow + deadlines.serverOffsetMs;
  const idle = Date.parse(deadlines.idleExpiresAt),
    absolute = Date.parse(deadlines.absoluteExpiresAt);
  const idleFirst = idle < absolute;
  if (now >= Math.min(idle, absolute))
    return { kind: "Ended", reason: idleFirst ? "Idle" : "Absolute" };
  if (idleFirst && idle - now <= IDLE_WARNING_MS)
    return { kind: "IdleWarning", at: deadlines.idleExpiresAt };
  if (absolute - now <= ABSOLUTE_WARNING_MS)
    return { kind: "AbsoluteWarning", at: deadlines.absoluteExpiresAt };
  return { kind: "None" };
}

/** Minutes and seconds left, e.g. "1:45". */
export function remaining(at: string, deadlines: SessionDeadlines, browserNow: number): string {
  const left = Math.max(0, Date.parse(at) - (browserNow + deadlines.serverOffsetMs));
  const seconds = Math.ceil(left / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("STAFF_SESSION_INVALID");
  return value as Readonly<Record<string, unknown>>;
}

function deadlines(value: unknown, browserNow: number): SessionDeadlines {
  const body = exact(value, [
    "idleExpiresAt",
    "absoluteExpiresAt",
    "idleTimeoutMinutes",
    "serverTime",
  ]);
  if (
    typeof body.idleExpiresAt !== "string" ||
    !INSTANT.test(body.idleExpiresAt) ||
    typeof body.absoluteExpiresAt !== "string" ||
    !INSTANT.test(body.absoluteExpiresAt) ||
    typeof body.serverTime !== "string" ||
    !INSTANT.test(body.serverTime) ||
    !Number.isSafeInteger(body.idleTimeoutMinutes) ||
    (body.idleTimeoutMinutes as number) < 1 ||
    Date.parse(body.idleExpiresAt) > Date.parse(body.absoluteExpiresAt)
  )
    throw new Error("STAFF_SESSION_INVALID");
  return Object.freeze({
    idleExpiresAt: body.idleExpiresAt,
    absoluteExpiresAt: body.absoluteExpiresAt,
    idleTimeoutMinutes: body.idleTimeoutMinutes as number,
    serverOffsetMs: Date.parse(body.serverTime) - browserNow,
  });
}

export function createStaffSessionClient(
  request: typeof fetch = (input, init) => globalThis.fetch(input, init),
  clock: () => number = () => Date.now(),
): StaffSessionClient {
  async function send(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await request(path, {
        ...init,
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  async function read(path: string, csrf: string, method: "GET" | "POST"): Promise<SessionRead> {
    const response = await send(path, {
      method,
      headers: { Accept: "application/json", "X-BOP-CSRF": csrf },
    });
    // Only the explicit "session ended" answer ends the Session; a refused (403), busy or
    // unavailable (5xx) check is retried later and never signs staff out.
    if (response.status === 401) {
      const body: unknown = await response.json().catch(() => null);
      if (
        body !== null &&
        typeof body === "object" &&
        (body as { error?: unknown }).error === "session_ended"
      )
        return "Ended";
    }
    if (!response.ok) throw new Error("STAFF_SESSION_UNAVAILABLE");
    return deadlines(await response.json(), clock());
  }
  return Object.freeze({
    activity: (csrf: string) => read("/merchant/session/activity", csrf, "POST"),
    expiry: (csrf: string) => read("/merchant/session/expiry", csrf, "GET"),
    async signInEntry() {
      const response = await send("/merchant/sign-in-entry", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("STAFF_SIGN_IN_UNAVAILABLE");
      const body = exact(await response.json(), ["path", "testOnly"]);
      if (
        typeof body.path !== "string" ||
        !SIGN_IN_PATH.test(body.path) ||
        typeof body.testOnly !== "boolean"
      )
        throw new Error("STAFF_SIGN_IN_INVALID");
      return Object.freeze({ path: body.path, testOnly: body.testOnly });
    },
    async signOut() {
      const response = await send("/merchant/logout", { method: "POST" });
      if (!response.ok) throw new Error("STAFF_SIGN_OUT_FAILED");
    },
  });
}
