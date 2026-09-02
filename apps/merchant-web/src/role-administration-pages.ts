export type RoleAdministrationPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class RoleAdministrationPageError extends Error {
  constructor(readonly code: RoleAdministrationPageErrorCode) {
    super("Role administration is unavailable");
    this.name = "RoleAdministrationPageError";
  }
}
export interface RolePermissionView {
  readonly action: string;
  readonly group: string;
  readonly highRisk: boolean;
  readonly dependencies: readonly string[];
}
export interface RoleAdministrationItemView {
  readonly roleReference: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly scope: "Brand" | "Store";
  readonly status: "Draft" | "InReview" | "Approved" | "Active" | "Rejected" | "Deactivated";
  readonly type: "System" | "Custom";
  readonly version: number;
  readonly memberCount: number;
  readonly permissions: readonly RolePermissionView[];
  readonly submittedBy: string | null;
  readonly approvedBy: string | null;
  readonly history: readonly string[];
}
export interface RoleAdministrationPageView {
  readonly screenId: "IAM-ROLE-LIST" | "IAM-ROLE-EDITOR";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly roles: readonly RoleAdministrationItemView[];
  readonly mayManage: boolean;
}
export interface RoleAdministrationPageClient {
  loadRoles(): Promise<unknown>;
  loadRole(roleReference: string): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  action = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,7}$/u,
  roleCode = /^[a-z][a-z0-9_]{1,62}[a-z0-9]$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    throw new Error("ROLE_ADMIN_PAGE_INVALID");
  return value as Record<string, unknown>;
}
const text = (value: unknown) => {
  if (typeof value !== "string" || !safe.test(value)) throw new Error("ROLE_ADMIN_PAGE_INVALID");
  return value;
};
export function parseRoleAdministrationRouteReference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("ROLE_ADMIN_PAGE_INVALID");
  return value;
}
function permission(value: unknown): RolePermissionView {
  const input = closed(value, ["action", "group", "highRisk", "dependencies"]);
  if (
    typeof input.action !== "string" ||
    !action.test(input.action) ||
    typeof input.highRisk !== "boolean" ||
    !Array.isArray(input.dependencies)
  )
    throw new Error("ROLE_ADMIN_PAGE_INVALID");
  const dependencies = Object.freeze(
    input.dependencies.map((item) => {
      if (typeof item !== "string" || !action.test(item))
        throw new Error("ROLE_ADMIN_PAGE_INVALID");
      return item;
    }),
  );
  return Object.freeze({
    action: input.action,
    group: text(input.group),
    highRisk: input.highRisk,
    dependencies,
  });
}
function role(value: unknown): RoleAdministrationItemView {
  const input = closed(value, [
    "roleReference",
    "code",
    "name",
    "description",
    "scope",
    "status",
    "type",
    "version",
    "memberCount",
    "permissions",
    "submittedBy",
    "approvedBy",
    "history",
  ]);
  if (
    typeof input.code !== "string" ||
    !roleCode.test(input.code) ||
    !["Brand", "Store"].includes(String(input.scope)) ||
    !["Draft", "InReview", "Approved", "Active", "Rejected", "Deactivated"].includes(
      String(input.status),
    ) ||
    !["System", "Custom"].includes(String(input.type)) ||
    !Number.isSafeInteger(input.version) ||
    (input.version as number) < 1 ||
    !Number.isSafeInteger(input.memberCount) ||
    (input.memberCount as number) < 0 ||
    !Array.isArray(input.permissions) ||
    !Array.isArray(input.history)
  )
    throw new Error("ROLE_ADMIN_PAGE_INVALID");
  const permissions = Object.freeze(input.permissions.map(permission)),
    history = Object.freeze(input.history.map(text));
  if (
    new Set(permissions.map((item) => item.action)).size !== permissions.length ||
    (input.approvedBy !== null && input.approvedBy === input.submittedBy)
  )
    throw new Error("ROLE_ADMIN_PAGE_INVALID");
  return Object.freeze({
    roleReference: parseRoleAdministrationRouteReference(input.roleReference),
    code: input.code,
    name: text(input.name),
    description: text(input.description),
    scope: input.scope,
    status: input.status,
    type: input.type,
    version: input.version,
    memberCount: input.memberCount,
    permissions,
    submittedBy: input.submittedBy === null ? null : text(input.submittedBy),
    approvedBy: input.approvedBy === null ? null : text(input.approvedBy),
    history,
  }) as RoleAdministrationItemView;
}
export function parseRoleAdministrationPageView(
  value: unknown,
  screenId: RoleAdministrationPageView["screenId"],
): RoleAdministrationPageView {
  const input = closed(value, [
    "screenId",
    "sourceAsOf",
    "freshness",
    "completeness",
    "roles",
    "mayManage",
  ]);
  if (
    input.screenId !== screenId ||
    !["Fresh", "Stale"].includes(String(input.freshness)) ||
    !["Complete", "Partial"].includes(String(input.completeness)) ||
    !Array.isArray(input.roles) ||
    typeof input.mayManage !== "boolean" ||
    typeof input.sourceAsOf !== "string" ||
    !instant.test(input.sourceAsOf)
  )
    throw new Error("ROLE_ADMIN_PAGE_INVALID");
  const roles = Object.freeze(input.roles.map(role));
  if (
    new Set(roles.map((item) => item.roleReference)).size !== roles.length ||
    (screenId === "IAM-ROLE-EDITOR" && roles.length !== 1)
  )
    throw new Error("ROLE_ADMIN_PAGE_INVALID");
  return Object.freeze({ ...input, roles }) as RoleAdministrationPageView;
}
export const unavailableRoleAdministrationPageClient: RoleAdministrationPageClient = {
  loadRoles: async () => {
    throw new RoleAdministrationPageError("Unavailable");
  },
  loadRole: async () => {
    throw new RoleAdministrationPageError("Unavailable");
  },
};
