import { t } from "./i18n/i18n.js";
/** WP-2423: Section 88 IAM-USER-LIST / IAM-USER-DETAIL view contract and same-origin client. */
import { FULL_SIGN_IN_REQUIRED, isFullSignInRequired } from "./full-sign-in.js";

export type StaffPageErrorCode =
  | "PermissionDenied"
  | typeof FULL_SIGN_IN_REQUIRED
  | "NotFound"
  | "Conflict"
  | "LastOwner"
  | "BrandRolesRemain"
  | "PendingRequestsRemain"
  | "Invalid"
  /** WP-2423 DEC-COGNITO-STORE-STAFF: this email already has an open invitation. */
  | "AlreadyInvited"
  /** A resend's email is not the one the invitation was sent to. */
  | "EmailMismatch"
  | "Offline"
  | "Unavailable";
export class StaffPageError extends Error {
  constructor(readonly code: StaffPageErrorCode) {
    super(t("Staff administration is unavailable"));
    this.name = "StaffPageError";
  }
}
export interface StaffAssignmentView {
  readonly assignmentReference: string;
  readonly roleReference: string;
  readonly roleName: string;
  /** Brand roles apply to every Store of the Brand (DEC-PERM-BRAND-ROLES). */
  readonly scope: "Store" | "Brand";
  readonly since: string;
  readonly mayRevoke: boolean;
}
export interface StaffPendingView {
  readonly changeReference: string;
  readonly roleName: string;
  readonly scope: "Store" | "Brand";
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly mayDecide: boolean;
  readonly mayWithdraw: boolean;
}
/** WP-2423 DEC-COGNITO-STORE-STAFF: an invitation to sign in with their own account. */
export interface StaffInvitationView {
  readonly status: "Pending" | "Expired" | "Accepted" | "Revoked";
  readonly delivery: StaffInvitationDelivery;
  /** Masked, such as "m•••@example.com"; the full address is never shown. */
  readonly emailHint: string;
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly sendCount: number;
  readonly version: number;
  readonly mayResend: boolean;
  readonly mayRevoke: boolean;
}
export type StaffInvitationDelivery = "Sending" | "Sent" | "Unknown";
export interface StaffMemberView {
  readonly actorReference: string;
  readonly displayName: string | null;
  readonly label: string;
  readonly self: boolean;
  readonly membershipStatus: string;
  readonly storeAssignmentStatus: string;
  readonly profileVersion: number;
  readonly assignments: readonly StaffAssignmentView[];
  readonly pending: readonly StaffPendingView[];
  readonly mayRequest: boolean;
  readonly mayRename: boolean;
  /** WP-2423 step 9: may remove this person from the Store (not oneself). */
  readonly mayRemove: boolean;
  /** Null when the person was not invited (or the server does not say). */
  readonly invitation: StaffInvitationView | null;
}
export interface StaffPageView {
  readonly screenId: "IAM-USER-LIST" | "IAM-USER-DETAIL";
  readonly sourceAsOf: string;
  readonly viewer: {
    readonly mayManage: boolean;
    readonly mayApprove: boolean;
    readonly brandMayManage: boolean;
    readonly brandMayApprove: boolean;
    /** WP-2423 DEC-COGNITO-STORE-STAFF: may invite a new staff member (false when not said). */
    readonly mayInvite: boolean;
  };
  readonly roles: readonly {
    readonly roleReference: string;
    readonly code: string;
    readonly name: string;
    readonly scope: "Store" | "Brand";
  }[];
  readonly staff: readonly StaffMemberView[];
  /**
   * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 8: the Brand's other members who may be added
   * to this Store (only for those who manage staff here; empty otherwise).
   */
  readonly otherStoresStaff: readonly { readonly actorReference: string; readonly label: string }[];
}
export type StaffCommandRequest =
  | {
      readonly operation: "SetDisplayName";
      readonly actorReference: string;
      readonly expectedProfileVersion: number;
      readonly displayName: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "RequestRole";
      readonly actorReference: string;
      readonly roleReference: string;
      readonly operationReference: string;
    }
  | { readonly operation: "Approve" | "Reject" | "Withdraw"; readonly changeReference: string }
  | {
      readonly operation: "Revoke";
      readonly assignmentReference: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "RemoveFromStore" | "AddToStore";
      readonly actorReference: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "Invite";
      readonly displayName: string;
      readonly email: string;
      readonly roleReference: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "ResendInvitation";
      readonly actorReference: string;
      readonly expectedVersion: number;
      readonly operationReference: string;
      /** Only when the server asked for it again (`emailNeeded`). */
      readonly email?: string;
    }
  | {
      readonly operation: "RevokeInvitation";
      readonly actorReference: string;
      readonly expectedVersion: number;
      readonly operationReference: string;
    };
export interface StaffInviteResult {
  readonly status: "Invited" | "AlreadyApplied";
  readonly actorReference: string;
  readonly delivery: StaffInvitationDelivery;
}
export interface StaffResendResult {
  readonly status: "Resent";
  readonly delivery: StaffInvitationDelivery;
  /** The invitation's email is needed again before a new one can be sent. */
  readonly emailNeeded: boolean;
}
export interface StaffRevokeResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly accountRemoved: boolean;
}
export interface StaffPageClient {
  load(actorReference: string | null): Promise<unknown>;
  command?(request: StaffCommandRequest): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
const invalid = (): never => {
  throw new Error("STAFF_PAGE_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
}
/** A closed record whose `optional` keys may be absent (older servers do not send them). */
function closedWith(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  const present =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? optional.filter((field) => Object.hasOwn(value, field))
      : [];
  return closed(value, [...fields, ...present]);
}
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : invalid());
const text = (value: unknown) =>
  typeof value === "string" && safe.test(value) ? value : invalid();
const time = (value: unknown) =>
  typeof value === "string" && instant.test(value) ? value : invalid();
const flag = (value: unknown) => (typeof value === "boolean" ? value : invalid());
const level = (value: unknown) => (value === "Store" || value === "Brand" ? value : invalid());
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const delivery = (value: unknown): StaffInvitationDelivery =>
  value === "Sending" || value === "Sent" || value === "Unknown" ? value : invalid();
function invitation(value: unknown): StaffInvitationView | null {
  if (value === null) return null;
  const x = closed(value, [
    "status",
    "delivery",
    "emailHint",
    "sentAt",
    "expiresAt",
    "sendCount",
    "version",
    "mayResend",
    "mayRevoke",
  ]);
  if (
    x.status !== "Pending" &&
    x.status !== "Expired" &&
    x.status !== "Accepted" &&
    x.status !== "Revoked"
  )
    invalid();
  return Object.freeze({
    status: x.status as StaffInvitationView["status"],
    delivery: delivery(x.delivery),
    emailHint: text(x.emailHint),
    sentAt: time(x.sentAt),
    expiresAt: time(x.expiresAt),
    sendCount: count(x.sendCount),
    version: count(x.version),
    mayResend: flag(x.mayResend),
    mayRevoke: flag(x.mayRevoke),
  });
}
const list = <T>(value: unknown, map: (item: unknown) => T): readonly T[] =>
  Array.isArray(value) ? Object.freeze(value.map(map)) : invalid();

export function parseStaffRouteReference(value: unknown): string {
  return ref(value);
}
export function parseStaffPageView(
  value: unknown,
  screenId: StaffPageView["screenId"],
): StaffPageView {
  // Segment 8 adds `otherStoresStaff`; a server before it sends none.
  const withOthers =
    value !== null && typeof value === "object" && Object.hasOwn(value, "otherStoresStaff");
  const r = closed(value, [
    "screenId",
    "sourceAsOf",
    "viewer",
    "roles",
    "staff",
    ...(withOthers ? ["otherStoresStaff"] : []),
  ]);
  if (r.screenId !== screenId) invalid();
  const viewer = closedWith(
    r.viewer,
    ["mayManage", "mayApprove", "brandMayManage", "brandMayApprove"],
    ["mayInvite"],
  );
  const staff = list(r.staff, (item) => {
    const m = closedWith(
      item,
      [
        "actorReference",
        "displayName",
        "label",
        "self",
        "membershipStatus",
        "storeAssignmentStatus",
        "profileVersion",
        "assignments",
        "pending",
        "mayRequest",
        "mayRename",
        "mayRemove",
      ],
      ["invitation"],
    );
    if (!Number.isSafeInteger(m.profileVersion) || (m.profileVersion as number) < 0) invalid();
    return Object.freeze({
      actorReference: ref(m.actorReference),
      displayName: m.displayName === null ? null : text(m.displayName),
      label: text(m.label),
      self: flag(m.self),
      membershipStatus: text(m.membershipStatus),
      storeAssignmentStatus: text(m.storeAssignmentStatus),
      profileVersion: m.profileVersion as number,
      assignments: list(m.assignments, (a) => {
        const x = closed(a, [
          "assignmentReference",
          "roleReference",
          "roleName",
          "scope",
          "since",
          "mayRevoke",
        ]);
        return Object.freeze({
          assignmentReference: ref(x.assignmentReference),
          roleReference: ref(x.roleReference),
          roleName: text(x.roleName),
          scope: level(x.scope),
          since: time(x.since),
          mayRevoke: flag(x.mayRevoke),
        });
      }),
      pending: list(m.pending, (p) => {
        const x = closed(p, [
          "changeReference",
          "roleName",
          "scope",
          "requestedBy",
          "requestedAt",
          "mayDecide",
          "mayWithdraw",
        ]);
        return Object.freeze({
          changeReference: ref(x.changeReference),
          roleName: text(x.roleName),
          scope: level(x.scope),
          requestedBy: text(x.requestedBy),
          requestedAt: time(x.requestedAt),
          mayDecide: flag(x.mayDecide),
          mayWithdraw: flag(x.mayWithdraw),
        });
      }),
      mayRequest: flag(m.mayRequest),
      mayRename: flag(m.mayRename),
      mayRemove: flag(m.mayRemove),
      invitation: Object.hasOwn(m, "invitation") ? invitation(m.invitation) : null,
    });
  });
  if (screenId === "IAM-USER-DETAIL" && staff.length !== 1) invalid();
  return Object.freeze({
    screenId,
    sourceAsOf: time(r.sourceAsOf),
    viewer: Object.freeze({
      mayManage: flag(viewer.mayManage),
      mayApprove: flag(viewer.mayApprove),
      brandMayManage: flag(viewer.brandMayManage),
      brandMayApprove: flag(viewer.brandMayApprove),
      mayInvite: Object.hasOwn(viewer, "mayInvite") ? flag(viewer.mayInvite) : false,
    }),
    roles: list(r.roles, (item) => {
      const x = closed(item, ["roleReference", "code", "name", "scope"]);
      return Object.freeze({
        roleReference: ref(x.roleReference),
        code: text(x.code),
        name: text(x.name),
        scope: level(x.scope),
      });
    }),
    staff,
    otherStoresStaff: withOthers
      ? list(r.otherStoresStaff, (item) => {
          const x = closed(item, ["actorReference", "label"]);
          return Object.freeze({ actorReference: ref(x.actorReference), label: text(x.label) });
        })
      : Object.freeze([]),
  });
}

export const unavailableStaffPageClient: StaffPageClient = {
  load: async () => {
    throw new StaffPageError("Unavailable");
  },
};
const codes: Record<string, StaffPageErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  LastOwner: "LastOwner",
  BrandRolesRemain: "BrandRolesRemain",
  PendingRequestsRemain: "PendingRequestsRemain",
  Invalid: "Invalid",
  AlreadyInvited: "AlreadyInvited",
  EmailMismatch: "EmailMismatch",
};

/** The answer to `Invite`; anything else is not trusted as sent. */
export function parseStaffInviteResult(value: unknown): StaffInviteResult {
  const x = closed(value, ["status", "actorReference", "delivery"]);
  if (x.status !== "Invited" && x.status !== "AlreadyApplied") invalid();
  return Object.freeze({
    status: x.status as StaffInviteResult["status"],
    actorReference: ref(x.actorReference),
    delivery: delivery(x.delivery),
  });
}
export function parseStaffResendResult(value: unknown): StaffResendResult {
  const x = closed(value, ["status", "delivery", "emailNeeded"]);
  if (x.status !== "Resent") invalid();
  return Object.freeze({
    status: "Resent",
    delivery: delivery(x.delivery),
    emailNeeded: flag(x.emailNeeded),
  });
}
export function parseStaffRevokeResult(value: unknown): StaffRevokeResult {
  const x = closed(value, ["status", "accountRemoved"]);
  if (x.status !== "Applied" && x.status !== "AlreadyApplied") invalid();
  return Object.freeze({
    status: x.status as StaffRevokeResult["status"],
    accountRemoved: flag(x.accountRemoved),
  });
}
export function createStaffPageClient(csrf: string, fetcher: typeof fetch = fetch) {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new StaffPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (isFullSignInRequired(response.status, payload))
        throw new StaffPageError(FULL_SIGN_IN_REQUIRED);
      throw new StaffPageError(
        codes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (actorReference: string | null) =>
      post("/merchant/organization/staff/query", { actorReference }),
    command: (request: StaffCommandRequest) =>
      post("/merchant/organization/staff/command", request),
  } satisfies StaffPageClient;
}
