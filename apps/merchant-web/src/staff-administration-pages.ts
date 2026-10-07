/** WP-2423: Section 88 IAM-USER-LIST / IAM-USER-DETAIL view contract and same-origin client. */
export type StaffPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "LastOwner"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class StaffPageError extends Error {
  constructor(readonly code: StaffPageErrorCode) {
    super("Staff administration is unavailable");
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
}
export interface StaffPageView {
  readonly screenId: "IAM-USER-LIST" | "IAM-USER-DETAIL";
  readonly sourceAsOf: string;
  readonly viewer: {
    readonly mayManage: boolean;
    readonly mayApprove: boolean;
    readonly brandMayManage: boolean;
    readonly brandMayApprove: boolean;
  };
  readonly roles: readonly {
    readonly roleReference: string;
    readonly code: string;
    readonly name: string;
    readonly scope: "Store" | "Brand";
  }[];
  readonly staff: readonly StaffMemberView[];
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
    };
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
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : invalid());
const text = (value: unknown) =>
  typeof value === "string" && safe.test(value) ? value : invalid();
const time = (value: unknown) =>
  typeof value === "string" && instant.test(value) ? value : invalid();
const flag = (value: unknown) => (typeof value === "boolean" ? value : invalid());
const level = (value: unknown) => (value === "Store" || value === "Brand" ? value : invalid());
const list = <T>(value: unknown, map: (item: unknown) => T): readonly T[] =>
  Array.isArray(value) ? Object.freeze(value.map(map)) : invalid();

export function parseStaffRouteReference(value: unknown): string {
  return ref(value);
}
export function parseStaffPageView(
  value: unknown,
  screenId: StaffPageView["screenId"],
): StaffPageView {
  const r = closed(value, ["screenId", "sourceAsOf", "viewer", "roles", "staff"]);
  if (r.screenId !== screenId) invalid();
  const viewer = closed(r.viewer, ["mayManage", "mayApprove", "brandMayManage", "brandMayApprove"]);
  const staff = list(r.staff, (item) => {
    const m = closed(item, [
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
    ]);
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
  Invalid: "Invalid",
};
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
