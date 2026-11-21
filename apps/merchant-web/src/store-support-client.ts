import { newOperationReference } from "./operation-reference.js";
/** WP-2423 取舍 15: what platform support and the Owner send and read. Scope comes from the server. */
export interface StoreSupportSession {
  readonly csrf: string;
  readonly name: string;
  readonly canChange: boolean;
  /** WP-2423 item 13 ②: may pause and resume a merchant's new guests. */
  readonly canPause?: boolean;
  readonly stores: readonly { readonly storeReference: string; readonly name: string }[];
}
/** WP-2423 item 13 ②: every merchant here, Store by Store. */
export interface StoreSupportOverview {
  readonly observedAt: string;
  readonly merchants: readonly {
    readonly brandReference: string;
    readonly name: string;
    readonly stores: readonly {
      readonly storeReference: string;
      readonly name: string;
      readonly timeZone: string | null;
      readonly readable: boolean;
      readonly menuListed: boolean;
      readonly kitchenSetUp: boolean;
      readonly lastOrderAt: string | null;
    }[];
    /** WP-2423 item 13 ②: whether it takes new guests now; null when it can't be read. */
    readonly guestIntake?: StoreSupportGuestIntake | null;
  }[];
}
export interface StoreSupportGuestIntake {
  readonly version: number;
  readonly state: "Open" | "Paused";
  readonly since: string | null;
  readonly reason: string | null;
}
export interface StoreSupportView {
  readonly name: string;
  /** The Store's own zone: its times are shown as staff there read them. */
  readonly timeZone: string | null;
  readonly ownerAllowsChanges: boolean;
  readonly allowedUntil: string | null;
  readonly kitchenSetUp: boolean;
  readonly kitchenSince: string | null;
  readonly kitchenVersion: number;
  readonly features: { readonly version: number; readonly pickup: boolean };
  readonly menus: readonly { readonly name: string; readonly listed: boolean }[];
  readonly orders: readonly {
    readonly orderNumber: string;
    readonly orderType: string;
    readonly phase: string | null;
    readonly createdAt: string;
    readonly lineCount: number | null;
    readonly guest: string | null;
  }[];
}
export type StoreSupportMode = "Off" | "Standing" | "Limited";
export interface StoreSupportLogEntry {
  readonly occurredAt: string;
  readonly supportName: string;
  readonly kind: "Viewed" | "Changed" | "Refused";
  readonly subjectCode: string;
}
/** Where the next page of the log starts, as the last page said (b18). */
export interface StoreSupportLogCursor {
  readonly before: string;
  readonly skip: number;
}
export interface StoreSupportLogPage {
  readonly log: readonly StoreSupportLogEntry[];
  readonly logNext: StoreSupportLogCursor | null;
}
/** b18: what the whole log holds, read from all of it (never only the page shown). */
export interface StoreSupportLogSummary {
  readonly total: number;
  readonly looks: number;
  readonly lastLookAt: string | null;
  readonly actedCount: number;
  /** Changes and refused attempts, newest first (up to 50; `actedCount` is how many in all). */
  readonly acted: readonly StoreSupportLogEntry[];
}
export interface StoreSupportAccessView extends StoreSupportLogPage {
  readonly version: number;
  readonly mode: StoreSupportMode;
  readonly allowedUntil: string | null;
  readonly summary: StoreSupportLogSummary;
}
export type StoreSupportErrorCode =
  "Denied" | "OwnerOnly" | "NotAllowedByOwner" | "Invalid" | "Changed" | "Unavailable";
export class StoreSupportClientError extends Error {
  constructor(readonly code: StoreSupportErrorCode) {
    super("store support " + code);
    this.name = "StoreSupportClientError";
  }
}
const errorCodes: Readonly<Record<string, StoreSupportErrorCode>> = {
  support_denied: "Denied",
  owner_only: "OwnerOnly",
  not_allowed_by_owner: "NotAllowedByOwner",
  invalid_command: "Invalid",
  changed: "Changed",
};
async function send<T>(path: string, csrf: string | null, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrf === null ? {} : { "X-BOP-CSRF": csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new StoreSupportClientError("Unavailable");
  }
  if (response.ok) return (await response.json()) as T;
  const raw = (await response.json().catch(() => null)) as { error?: unknown } | null;
  throw new StoreSupportClientError(
    errorCodes[String(raw?.error)] ?? (response.status === 403 ? "Denied" : "Unavailable"),
  );
}
export const storeSupportClient = Object.freeze({
  session: () => send<StoreSupportSession>("/merchant/support/session", null),
  overview: (csrf: string) => send<StoreSupportOverview>("/merchant/support/overview", csrf, {}),
  view: (csrf: string, storeReference: string) =>
    send<StoreSupportView>("/merchant/support/store/view", csrf, { storeReference }),
  command: (
    csrf: string,
    storeReference: string,
    action: "SetUpKitchenLine" | "SetPickup",
    expectedVersion: number,
    value?: boolean,
  ) =>
    send<{ status: string }>("/merchant/support/store/command", csrf, {
      storeReference,
      command: {
        operationReference: newOperationReference(),
        action,
        expectedVersion,
        ...(value === undefined ? {} : { value }),
      },
    }),
  /** WP-2423 item 13 ②: pause or resume a merchant's new guests, with the reason staff see. */
  changeGuestIntake: (
    csrf: string,
    brandReference: string,
    expectedVersion: number,
    state: "Open" | "Paused",
    reason: string,
    operationReference: string,
  ) =>
    send<StoreSupportGuestIntake>("/merchant/support/merchant/guest-intake", csrf, {
      brandReference,
      operationReference,
      expectedVersion,
      state,
      reason,
    }),
  access: () => send<StoreSupportAccessView>("/merchant/store/support-access", null),
  /** b18: the next page of the log, from where the last page said it starts. */
  accessLogPage: (after: StoreSupportLogCursor) =>
    send<StoreSupportLogPage>(
      "/merchant/store/support-access?before=" +
        encodeURIComponent(after.before) +
        "&skip=" +
        String(after.skip),
      null,
    ),
  changeAccess: (
    csrf: string,
    expectedVersion: number,
    mode: StoreSupportMode,
    hours: 1 | 4 | 24 | null,
  ) =>
    send<StoreSupportAccessView>("/merchant/store/support-access", csrf, {
      operationReference: newOperationReference(),
      expectedVersion,
      mode,
      hours,
    }),
});
