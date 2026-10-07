import { parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import type { Membership, StoreAssignment } from "@bop/membership";
import type { BrandAdministrationContext, TenantContext } from "@bop/tenant";
import {
  materializePermissionEvidence,
  materializeBrandAdministrationPermissionEvidence,
} from "../../application/materialize-policy-evidence.js";
import {
  evaluatePermission,
  evaluateBrandAdministrationPermission,
} from "../../application/evaluate-permission.js";
import {
  parseBrandAdministrationPermissionAction,
  revalidateBrandAdministrationPermissionContext,
} from "../../contracts/brand-administration-permission.js";
import {
  parseBusinessAction,
  revalidateTenantContext,
} from "../../contracts/permission-evaluation.js";
import {
  PermissionPolicyContractError,
  createPolicyState,
  createBrandAdministrationPolicyState,
  createPermissionDefinition,
  createPermissionRole,
  createBrandAdministrationPermissionRole,
  createRoleAssignment,
  createPermissionGrant,
  createPermissionOverride,
} from "../../domain/permission-policy.js";
export interface PermissionPolicyTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const unavailable = (): never => {
  throw new PermissionPolicyContractError("PERMISSION_POLICY_MATERIALIZATION_INVALID");
};
// Private, versioned SQL transport only: each checkpoint still obtains fresh
// owning facts under the unchanged six-table SHARE lock. No decision is cached.
const policyPacketSql = `SELECT jsonb_build_object(
  'profile', 'PermissionCurrentPolicyPacketV1',
  'policy_state', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'brand_id', brand_id,
    'snapshot_id', snapshot_id,
    'version', version::text,
    'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), '[]'::jsonb)
    FROM (SELECT brand_id, snapshot_id, version, updated_at FROM bop_permission.policy_state WHERE brand_id=$1 LIMIT 1025) AS bounded_policy_state),
  'permission_definition', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'permission_id', permission_id,
    'action_code', action_code,
    'lifecycle', lifecycle,
    'version', version::text,
    'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY permission_id), '[]'::jsonb)
    FROM (SELECT permission_id, action_code, lifecycle, version, created_at, updated_at FROM bop_permission.permission_definition ORDER BY permission_id LIMIT 1025) AS bounded_permission_definition),
  'role', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role_id', role_id,
    'brand_id', brand_id,
    'store_id', store_id,
    'role_code', role_code,
    'lifecycle', lifecycle,
    'effective_from', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effective_until', to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'version', version::text,
    'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY role_id), '[]'::jsonb)
    FROM (SELECT role_id, brand_id, store_id, role_code, lifecycle, effective_from, effective_until, version, created_at, updated_at FROM bop_permission.role WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) ORDER BY role_id LIMIT 1025) AS bounded_role),
  'role_assignment', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'assignment_id', assignment_id,
    'role_id', role_id,
    'membership_id', membership_id,
    'store_assignment_id', store_assignment_id,
    'actor_id', actor_id,
    'brand_id', brand_id,
    'store_id', store_id,
    'lifecycle', lifecycle,
    'effective_from', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effective_until', to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'version', version::text,
    'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY assignment_id), '[]'::jsonb)
    FROM (SELECT assignment_id, role_id, membership_id, store_assignment_id, actor_id, brand_id, store_id, lifecycle, effective_from, effective_until, version, created_at, updated_at FROM bop_permission.role_assignment WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) AND actor_id=$3 AND membership_id=$4 ORDER BY assignment_id LIMIT 1025) AS bounded_role_assignment),
  'permission_grant', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'grant_id', grant_id,
    'role_id', role_id,
    'permission_id', permission_id,
    'brand_id', brand_id,
    'store_id', store_id,
    'lifecycle', lifecycle,
    'effective_from', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effective_until', to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'version', version::text,
    'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY grant_id), '[]'::jsonb)
    FROM (SELECT grant_id, role_id, permission_id, brand_id, store_id, lifecycle, effective_from, effective_until, version, created_at, updated_at FROM bop_permission.permission_grant WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) ORDER BY grant_id LIMIT 1025) AS bounded_permission_grant),
  'permission_override', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'override_id', override_id,
    'permission_id', permission_id,
    'actor_id', actor_id,
    'brand_id', brand_id,
    'store_id', store_id,
    'effect', effect,
    'lifecycle', lifecycle,
    'reason_reference', reason_reference,
    'correlation_reference', correlation_reference,
    'effective_from', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effective_until', to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'version', version::text,
    'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY override_id), '[]'::jsonb)
    FROM (SELECT override_id, permission_id, actor_id, brand_id, store_id, effect, lifecycle, reason_reference, correlation_reference, effective_from, effective_until, version, created_at, updated_at FROM bop_permission.permission_override WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) AND actor_id=$3 ORDER BY override_id LIMIT 1025) AS bounded_permission_override)
) AS packet`;
const packetRowFields = {
  policy_state: ["brand_id", "snapshot_id", "version", "updated_at"],
  permission_definition: [
    "permission_id",
    "action_code",
    "lifecycle",
    "version",
    "created_at",
    "updated_at",
  ],
  role: [
    "role_id",
    "brand_id",
    "store_id",
    "role_code",
    "lifecycle",
    "effective_from",
    "effective_until",
    "version",
    "created_at",
    "updated_at",
  ],
  role_assignment: [
    "assignment_id",
    "role_id",
    "membership_id",
    "store_assignment_id",
    "actor_id",
    "brand_id",
    "store_id",
    "lifecycle",
    "effective_from",
    "effective_until",
    "version",
    "created_at",
    "updated_at",
  ],
  permission_grant: [
    "grant_id",
    "role_id",
    "permission_id",
    "brand_id",
    "store_id",
    "lifecycle",
    "effective_from",
    "effective_until",
    "version",
    "created_at",
    "updated_at",
  ],
  permission_override: [
    "override_id",
    "permission_id",
    "actor_id",
    "brand_id",
    "store_id",
    "effect",
    "lifecycle",
    "reason_reference",
    "correlation_reference",
    "effective_from",
    "effective_until",
    "version",
    "created_at",
    "updated_at",
  ],
} as const;
function transportArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return unavailable();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
    result.push(descriptor.value);
  }
  return result;
}
function transportDate(value: unknown): Date {
  // The existing public parser requires canonical UTC millisecond text and an
  // exact ISO roundtrip. Domain construction below still receives Date rows.
  return new Date(parseCanonicalInstant(value));
}
function transportVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    String(Number(value)) !== value
  )
    return unavailable();
  return value;
}
function policyPacket(value: unknown) {
  if (!value || typeof value !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return unavailable();
  const outerRows = transportArray(descriptor.value, 1);
  if (outerRows.length !== 1) return unavailable();
  const outer = readClosedRecord(outerRows[0], ["packet"]);
  const packet = readClosedRecord(outer.packet, ["profile", ...Object.keys(packetRowFields)]);
  if (packet.profile !== "PermissionCurrentPolicyPacketV1") return unavailable();
  const normalize = (group: keyof typeof packetRowFields) => {
    const sourceRows = transportArray(packet[group], group === "policy_state" ? 1 : 1024);
    if (group === "policy_state" && sourceRows.length !== 1) return unavailable();
    return sourceRows.map((value) => {
      const raw = readClosedRecord(value, packetRowFields[group]);
      const row: Record<string, unknown> = { ...raw };
      for (const key of packetRowFields[group]) {
        if (key === "version") row[key] = transportVersion(raw[key]);
        else if (key === "effective_until" && raw[key] === null) row[key] = null;
        else if (
          key === "created_at" ||
          key === "updated_at" ||
          key === "effective_from" ||
          key === "effective_until"
        )
          row[key] = transportDate(raw[key]);
      }
      return row;
    });
  };
  return {
    policy_state: normalize("policy_state"),
    permission_definition: normalize("permission_definition"),
    role: normalize("role"),
    role_assignment: normalize("role_assignment"),
    permission_grant: normalize("permission_grant"),
    permission_override: normalize("permission_override"),
  };
}
function at(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return unavailable();
  return value.toISOString();
}
function timestamps(row: Record<string, unknown>, observedAt: string) {
  const updatedAt = at(row.updated_at),
    createdAt = at(row.created_at);
  if (updatedAt > observedAt) return unavailable();
  const version =
    typeof row.version === "string" && /^[1-9][0-9]*$/u.test(row.version)
      ? Number(row.version)
      : unavailable();
  if (!Number.isSafeInteger(version)) return unavailable();
  return { version, createdAt, updatedAt };
}
function period(row: Record<string, unknown>) {
  return {
    effectiveFrom: at(row.effective_from),
    effectiveUntil: row.effective_until === null ? null : at(row.effective_until),
  };
}
/** Internal workforce capability: Identity/Tenant/Membership facts must be current and fenced
 * by their owners in this same outer transaction. This is not guest-session authorization.
 * Requires the internal Permission owner role: PostgreSQL SHARE table locking needs
 * mutation privileges. Do not grant these privileges to a public read-only caller.
 */
interface PolicyFacts {
  readonly state: ReturnType<typeof createPolicyState>;
  readonly definitions: readonly ReturnType<typeof createPermissionDefinition>[];
  readonly roles: readonly ReturnType<typeof createPermissionRole>[];
  readonly assignments: readonly ReturnType<typeof createRoleAssignment>[];
  readonly grants: readonly ReturnType<typeof createPermissionGrant>[];
  readonly overrides: readonly ReturnType<typeof createPermissionOverride>[];
}
function constructPolicyFacts(
  packet: ReturnType<typeof policyPacket>,
  context: TenantContext | BrandAdministrationContext,
  membership: Membership,
  storeAssignment: StoreAssignment | null,
  administrative: boolean,
): PolicyFacts {
  const stateRows = packet.policy_state;
  if (stateRows.length !== 1) return unavailable();
  const rawState = stateRows[0];
  if (!rawState || at(rawState.updated_at) > context.resolvedAt) return unavailable();
  const state = (administrative ? createBrandAdministrationPolicyState : createPolicyState)(
    {
      brandReference: rawState.brand_id,
      snapshotReference: rawState.snapshot_id,
      version: Number(rawState.version),
      updatedAt: at(rawState.updated_at),
    },
    context.brand,
  );
  const definitionRows = packet.permission_definition;
  const definitions = definitionRows.map((r) =>
    createPermissionDefinition({
      permissionReference: r.permission_id,
      action: r.action_code,
      lifecycle: r.lifecycle,
      ...timestamps(r, context.resolvedAt),
    }),
  );
  const roleRows = packet.role;
  const roles = roleRows.map((r) => {
    const value = {
      roleReference: r.role_id,
      brandReference: r.brand_id,
      storeReference: r.store_id,
      code: r.role_code,
      lifecycle: r.lifecycle,
      ...period(r),
      ...timestamps(r, context.resolvedAt),
    };
    return administrative
      ? createBrandAdministrationPermissionRole(value, context.brand)
      : createPermissionRole(value, context.brand, r.store_id === null ? null : context.store);
  });
  const definitionById = new Map(definitions.map((d) => [String(d.permissionReference), d]));
  const roleById = new Map(roles.map((r) => [String(r.roleReference), r]));
  const assignmentRows = packet.role_assignment;
  const assignments = assignmentRows.map((r) => {
    const role = roleById.get(String(r.role_id)) ?? unavailable();
    return createRoleAssignment(
      {
        assignmentReference: r.assignment_id,
        roleReference: r.role_id,
        membershipReference: r.membership_id,
        storeAssignmentReference: r.store_assignment_id,
        actorReference: r.actor_id,
        brandReference: r.brand_id,
        storeReference: r.store_id,
        lifecycle: r.lifecycle,
        ...period(r),
        ...timestamps(r, context.resolvedAt),
      },
      role,
      membership,
      r.store_id === null ? null : storeAssignment,
    );
  });
  const grantRows = packet.permission_grant;
  const grants = grantRows.map((r) => {
    const role = roleById.get(String(r.role_id)) ?? unavailable();
    const definition = definitionById.get(String(r.permission_id)) ?? unavailable();
    return createPermissionGrant(
      {
        grantReference: r.grant_id,
        roleReference: r.role_id,
        permissionReference: r.permission_id,
        action: definition.action,
        brandReference: r.brand_id,
        storeReference: r.store_id,
        lifecycle: r.lifecycle,
        ...period(r),
        ...timestamps(r, context.resolvedAt),
      },
      role,
      definition,
    );
  });
  const overrideRows = packet.permission_override;
  const overrides = overrideRows.map((r) => {
    const definition = definitionById.get(String(r.permission_id)) ?? unavailable();
    return createPermissionOverride(
      {
        overrideReference: r.override_id,
        permissionReference: r.permission_id,
        action: definition.action,
        actorReference: r.actor_id,
        brandReference: r.brand_id,
        storeReference: r.store_id,
        effect: r.effect,
        lifecycle: r.lifecycle,
        reasonReference: r.reason_reference,
        correlationReference: r.correlation_reference,
        ...period(r),
        ...timestamps(r, context.resolvedAt),
      },
      definition,
    );
  });
  return Object.freeze({
    state,
    definitions: Object.freeze(definitions),
    roles: Object.freeze(roles),
    assignments: Object.freeze(assignments),
    grants: Object.freeze(grants),
    overrides: Object.freeze(overrides),
  });
}
function packetSignature(packet: ReturnType<typeof policyPacket>): string {
  return JSON.stringify(
    Object.keys(packetRowFields).map((group) => {
      const name = group as keyof typeof packetRowFields;
      return [
        name,
        packet[name].map((row) =>
          packetRowFields[name].map((key) => {
            const value = row[key];
            if (value instanceof Date) return at(value);
            if (
              value !== null &&
              typeof value !== "string" &&
              typeof value !== "number" &&
              typeof value !== "boolean"
            )
              return unavailable();
            if (typeof value === "number" && !Number.isFinite(value)) return unavailable();
            return value;
          }),
        ),
      ];
    }),
  );
}
// These four public constructor dependencies contain scalar fields only. Copy
// own data descriptors in fixed key order; no object/caller getter enters a
// fingerprint, and a dependency change always reconstructs all Domain facts.
function constructorDependency(value: unknown): unknown {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) return unavailable();
  const keys = Object.keys(value).sort(),
    raw = readClosedRecord(value, keys);
  return keys.map((key) => {
    const field = raw[key];
    if (
      field !== null &&
      typeof field !== "string" &&
      typeof field !== "number" &&
      typeof field !== "boolean"
    )
      return unavailable();
    if (typeof field === "number" && !Number.isFinite(field)) return unavailable();
    return [key, field];
  });
}
export function createPostgresCurrentPermissionPolicySource(
  transaction: PermissionPolicyTransaction,
) {
  return operationalPolicySource(transaction, false);
}
/** Transaction-local constructor reuse only. Each checkpoint still reads the
 * complete fresh owning packet and evaluates fresh context/Membership facts. */
export function createPostgresTransactionCurrentPermissionPolicySource(
  transaction: PermissionPolicyTransaction,
) {
  return operationalPolicySource(transaction, true);
}
interface CurrentPolicyInput {
  readonly tenantContext: TenantContext;
  readonly membership: Membership;
  readonly storeAssignment: StoreAssignment | null;
  readonly actions: readonly string[];
}
interface CurrentAdministrationPolicyInput {
  readonly administrationContext: BrandAdministrationContext;
  readonly membership: Membership;
  readonly storeAssignment: null;
  readonly actions: readonly string[];
}
type SinglePolicyInput = Omit<CurrentPolicyInput, "actions"> & { readonly action: string };
type SingleAdministrationPolicyInput = Omit<CurrentAdministrationPolicyInput, "actions"> & {
  readonly action: string;
};
function operationalPolicySource(transaction: PermissionPolicyTransaction, reuse: boolean) {
  const source = createPermissionPolicySource(transaction, reuse, false);
  return Object.freeze({
    authorizeActionsWithRoles: (input: CurrentPolicyInput) =>
      source.authorizeActionsWithRoles(input),
    authorizeWithRoles: (input: SinglePolicyInput) => source.authorizeWithRoles(input),
    authorize: (input: SinglePolicyInput) => source.authorize(input),
  });
}
/** Actual administrative context only; no operational TenantContext is created.
 * Identity, Brand and Membership remain held by their owners in this same tx. */
export function createPostgresCurrentBrandAdministrationPermissionPolicySource(
  transaction: PermissionPolicyTransaction,
) {
  const source = createPermissionPolicySource(transaction, true, true);
  return Object.freeze({
    authorizeActionsWithRoles: (input: CurrentAdministrationPolicyInput) =>
      source.authorizeActionsWithRoles(input),
    authorizeWithRoles: (input: SingleAdministrationPolicyInput) =>
      source.authorizeWithRoles(input),
    authorize: (input: SingleAdministrationPolicyInput) => source.authorize(input),
  });
}
function createPermissionPolicySource(
  transaction: PermissionPolicyTransaction,
  reuseConstructors: boolean,
  administrative: boolean,
) {
  const capturedQuery = transaction.query;
  let active = false,
    poisoned = false,
    shared = false,
    tupleIdentity: string | undefined,
    selectedStore: string | undefined,
    administrativeIdentity: string | undefined,
    latestObservation: string | undefined,
    administrativeDeadline: string | undefined;
  const factsByScope = new Map<
    string,
    { readonly signature: string; readonly facts: PolicyFacts }
  >();
  const check = () => {
    if (
      reuseConstructors &&
      (poisoned || typeof capturedQuery !== "function" || transaction.query !== capturedQuery)
    ) {
      poisoned = true;
      return unavailable();
    }
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await transaction.query(sql, values);
    check();
    return result;
  };
  const source = {
    async authorizeActionsWithRoles(input: CurrentPolicyInput | CurrentAdministrationPolicyInput) {
      if (reuseConstructors && active) {
        poisoned = true;
        return unavailable();
      }
      if (reuseConstructors) active = true;
      try {
        const raw = readClosedRecord(input, [
          administrative ? "administrationContext" : "tenantContext",
          "membership",
          "storeAssignment",
          "actions",
        ]);
        const list = raw.actions;
        if (
          !Array.isArray(list) ||
          Object.getPrototypeOf(list) !== Array.prototype ||
          list.length < 1 ||
          list.length > 16 ||
          Reflect.ownKeys(list).length !== list.length + 1
        )
          return unavailable();
        const actions: ReturnType<typeof parseBusinessAction>[] = [];
        for (let i = 0; i < list.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(list, String(i));
          if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
          const action = administrative
            ? parseBrandAdministrationPermissionAction(descriptor.value)
            : parseBusinessAction(descriptor.value);
          if (actions.includes(action)) return unavailable();
          actions.push(action);
        }
        const context = administrative
            ? revalidateBrandAdministrationPermissionContext(raw.administrationContext)
            : revalidateTenantContext(raw.tenantContext as TenantContext),
          membership = input.membership,
          storeAssignment = input.storeAssignment;
        const brand = context.brand.brandReference,
          store = context.store?.storeReference ?? null;
        const actor = context.actor.actorReference;
        if (actor === null) return unavailable();
        if (administrative) {
          if (store !== null || storeAssignment !== null) return unavailable();
          const identity = JSON.stringify([
            constructorDependency(context.actor),
            constructorDependency(context.brand),
            constructorDependency(membership),
          ]);
          if (administrativeIdentity !== undefined && identity !== administrativeIdentity)
            return unavailable();
          administrativeIdentity = identity;
          administrativeDeadline ??= new Date(Date.parse(context.resolvedAt) + 5000).toISOString();
          if (
            (latestObservation !== undefined && context.resolvedAt < latestObservation) ||
            context.resolvedAt >= administrativeDeadline
          )
            return unavailable();
          latestObservation = context.resolvedAt;
        }
        check();
        const dependencies = reuseConstructors
          ? JSON.stringify([
              constructorDependency(context.brand),
              constructorDependency(context.store),
              constructorDependency(membership),
              constructorDependency(storeAssignment),
            ])
          : undefined;
        if (reuseConstructors) {
          const identity = JSON.stringify([brand, actor, membership.membershipReference]);
          if (tupleIdentity !== undefined && tupleIdentity !== identity) return unavailable();
          tupleIdentity = identity;
          if (store !== null) {
            if (selectedStore !== undefined && selectedStore !== store) return unavailable();
            selectedStore = store;
          }
        }
        await query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store ?? ""],
        );
        if (!reuseConstructors || !shared) {
          await query(
            "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE MODE",
            [],
          );
          if (reuseConstructors) shared = true;
        }
        const packet = policyPacket(
          await query(policyPacketSql, [brand, store, actor, membership.membershipReference]),
        );
        if (reuseConstructors) {
          // Timestamp validity is current-observation dependent, even when the
          // complete SQL packet and all constructor dependencies are unchanged.
          const rawState = packet.policy_state[0];
          if (!rawState || at(rawState.updated_at) > context.resolvedAt) return unavailable();
          for (const group of [
            packet.permission_definition,
            packet.role,
            packet.role_assignment,
            packet.permission_grant,
            packet.permission_override,
          ]) {
            for (const row of group) timestamps(row, context.resolvedAt);
          }
        }
        let facts: PolicyFacts;
        if (reuseConstructors) {
          const key = store === null ? "Brand" : "Store",
            signature = JSON.stringify([packetSignature(packet), dependencies]),
            cached = factsByScope.get(key);
          if (cached?.signature === signature) facts = cached.facts;
          else {
            facts = constructPolicyFacts(
              packet,
              context,
              membership,
              storeAssignment,
              administrative,
            );
            factsByScope.set(key, Object.freeze({ signature, facts }));
          }
        } else
          facts = constructPolicyFacts(
            packet,
            context,
            membership,
            storeAssignment,
            administrative,
          );
        const { state, definitions, roles, assignments, grants, overrides } = facts;
        const policyInput = {
          policyState: state,
          membership: membership,
          storeAssignment: storeAssignment,
          permissionDefinitions: Object.freeze(definitions),
          roles: Object.freeze(roles),
          roleAssignments: Object.freeze(assignments),
          permissionGrants: Object.freeze(grants),
          permissionOverrides: Object.freeze(overrides),
        };
        const policy =
          "profile" in context
            ? materializeBrandAdministrationPermissionEvidence(
                Object.freeze({
                  ...policyInput,
                  administrationContext: context,
                  storeAssignment: null,
                }),
              )
            : materializePermissionEvidence(
                Object.freeze({ ...policyInput, tenantContext: context }),
              );
        // One fresh owning materialization for this checkpoint; every action
        // receives the canonical evaluator's complete decision in input order.
        const decisions = Object.freeze(
          actions.map((action) => {
            const evaluation = {
              action,
              resourceScope: {
                kind: "scopeKind" in context ? context.scopeKind : ("Brand" as const),
                brandReference: brand,
                storeReference: store,
              },
              policySnapshotReference: policy.policySnapshotReference,
              policyVersion: policy.policyVersion,
              evidence: policy.evidence,
            };
            return "profile" in context
              ? evaluateBrandAdministrationPermission({
                  ...evaluation,
                  administrationContext: context,
                  resourceScope: { kind: "Brand", brandReference: brand, storeReference: null },
                })
              : evaluatePermission({ ...evaluation, tenantContext: context });
          }),
        );
        // SQL locks prevent changes to these validated rows, but they do not
        // stop an existing period from starting or expiring. A consumer holding
        // this observation must stop at the first such future boundary, even if
        // it belongs to a currently inactive or otherwise unrelated policy row.
        // Boundaries at/before resolvedAt are already evaluated by the owner.
        let validUntil: string | null = administrativeDeadline ?? null;
        for (const fact of [
          ...roles,
          ...assignments,
          ...grants,
          ...overrides,
          membership,
          ...(storeAssignment === null ? [] : [storeAssignment]),
        ]) {
          for (const boundary of [fact.effectiveFrom, fact.effectiveUntil]) {
            if (
              boundary !== null &&
              boundary > context.resolvedAt &&
              (validUntil === null || boundary < validUntil)
            )
              validUntil = boundary;
          }
        }
        if (administrative && validUntil !== null) administrativeDeadline = validUntil;
        check();
        return Object.freeze({ decisions, activeRoleCodes: policy.activeRoleCodes, validUntil });
      } catch {
        if (reuseConstructors) poisoned = true;
        return unavailable();
      } finally {
        if (reuseConstructors) active = false;
      }
    },
  };
  return Object.freeze({
    authorizeActionsWithRoles: source.authorizeActionsWithRoles,
    async authorizeWithRoles(input: SinglePolicyInput | SingleAdministrationPolicyInput) {
      try {
        const result = await source.authorizeActionsWithRoles(single(input));
        const decision = result.decisions[0];
        if (!decision) return unavailable();
        return Object.freeze({
          decision,
          activeRoleCodes: result.activeRoleCodes,
          validUntil: result.validUntil,
        });
      } catch {
        if (administrative) poisoned = true;
        return unavailable();
      }
    },
    async authorize(input: SinglePolicyInput | SingleAdministrationPolicyInput) {
      try {
        const result = await source.authorizeActionsWithRoles(single(input));
        return result.decisions[0] ?? unavailable();
      } catch {
        if (administrative) poisoned = true;
        return unavailable();
      }
    },
  });
  function single(input: SinglePolicyInput | SingleAdministrationPolicyInput) {
    if (administrative) {
      readClosedRecord(input, ["administrationContext", "membership", "storeAssignment", "action"]);
      if (input.storeAssignment !== null) return unavailable();
    }
    const common = {
      membership: input.membership,
      storeAssignment: input.storeAssignment,
      actions: Object.freeze([input.action]),
    };
    return "administrationContext" in input
      ? Object.freeze({
          ...common,
          administrationContext: input.administrationContext,
          storeAssignment: null,
        })
      : Object.freeze({ ...common, tenantContext: input.tenantContext });
  }
}
