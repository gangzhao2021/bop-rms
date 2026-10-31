import { appendAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import {
  createIdentityActor,
  parseCurrentWorkforceAccount,
  readClosedRecord,
  type IdentityActor,
  type CurrentWorkforceAccount,
} from "@bop/identity";
import {
  createInitialBrandMembership,
  resolveActiveMembership,
  type Membership,
} from "@bop/membership";
import { createBrand, parseCanonicalInstant, type Brand } from "@bop/tenant";
import {
  BrandInitialPolicyError,
  brandInitialPolicyArray,
  hashBrandInitialPolicyRequest,
  parseBrandInitialPolicyRequest,
  type BrandInitialPolicyRequest,
} from "../../contracts/brand-initial-policy.js";
import {
  createBrandAdministrationPolicyState,
  createBrandAdministrationPermissionRole,
  createPermissionDefinition,
  createRoleAssignment,
  createPermissionGrant,
} from "../../domain/permission-policy.js";

export interface BrandInitialPolicyTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface BrandInitialPolicyAuthority {
  /** Hold actual public Tenant/Identity/Membership facts and the independently
   * approved complete request through COMMIT. Matching a claimed planDigest
   * alone is insufficient: derive the exact request from the signed static plan
   * and fixed server observation, then verify its requestDigest, current trusted
   * signer and withdrawal source. The runtime requestDigest is not planDigest.
   * Brand and Membership must have been CREATED by their actual public owners
   * in this same outer transaction. Timestamp equality alone is not that proof. */
  hold(
    tx: BrandInitialPolicyTransaction,
    input: {
      readonly request: BrandInitialPolicyRequest;
      readonly requestDigest: string;
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ): Promise<{
    readonly operationReference: string;
    readonly brand: Brand;
    readonly planDigest: string;
    readonly requestDigest: string;
    readonly approvalEvidenceReference: string;
    readonly operator: IdentityActor;
    readonly approvedByReference: string;
    readonly recipients: readonly {
      readonly account: CurrentWorkforceAccount;
      readonly membership: Membership;
    }[];
    readonly validUntil: string;
  }>;
}
export interface BrandInitialPolicyStoreOptions {
  readonly transaction: BrandInitialPolicyTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly authority: BrandInitialPolicyAuthority;
  readonly appendAudit: typeof appendAuditRecordInTransaction;
  readonly registerBeforeCommit: (
    tx: BrandInitialPolicyTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
const stamp = (value: unknown): string => String(parseCanonicalInstant(value));
const stateSql = `SELECT brand_id::text AS "brandReference",snapshot_id::text AS "snapshotReference",version::text AS version,
 to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.policy_state WHERE brand_id=$1 LIMIT 2`;
const rolesSql = `SELECT role_id::text AS "roleReference",brand_id::text AS "brandReference",store_id::text AS "storeReference",role_code AS code,lifecycle,
 to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",version::text AS version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 effective_from=date_trunc('milliseconds',effective_from) AND (effective_until IS NULL OR effective_until=date_trunc('milliseconds',effective_until)) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.role WHERE brand_id=$1 ORDER BY role_id LIMIT 21`;
const assignmentsSql = `SELECT assignment_id::text AS "assignmentReference",role_id::text AS "roleReference",membership_id::text AS "membershipReference",store_assignment_id::text AS "storeAssignmentReference",actor_id::text AS "actorReference",brand_id::text AS "brandReference",store_id::text AS "storeReference",lifecycle,
 to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",version::text AS version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 effective_from=date_trunc('milliseconds',effective_from) AND (effective_until IS NULL OR effective_until=date_trunc('milliseconds',effective_until)) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.role_assignment WHERE brand_id=$1 ORDER BY assignment_id LIMIT 21`;
// action is owning definition data, not a duplicated field in permission_grant.
const grantsSql = `SELECT grant_id::text AS "grantReference",role_id::text AS "roleReference",permission_id::text AS "permissionReference",brand_id::text AS "brandReference",store_id::text AS "storeReference",lifecycle,
 to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",version::text AS version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 effective_from=date_trunc('milliseconds',effective_from) AND (effective_until IS NULL OR effective_until=date_trunc('milliseconds',effective_until)) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.permission_grant WHERE brand_id=$1 ORDER BY grant_id LIMIT 121`;
const overridesSql = `SELECT override_id::text AS "overrideReference" FROM bop_permission.permission_override WHERE brand_id=$1 LIMIT 1`;
const definitionsSql = `SELECT permission_id::text AS "permissionReference",action_code AS action,lifecycle,version::text AS version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.permission_definition WHERE permission_id=ANY($1::uuid[]) ORDER BY permission_id FOR SHARE`;
const temporalFields = [
  "effectiveFrom",
  "effectiveUntil",
  "version",
  "createdAt",
  "updatedAt",
  "precise",
];
const fields = {
  state: ["brandReference", "snapshotReference", "version", "updatedAt", "precise"],
  roles: [
    "roleReference",
    "brandReference",
    "storeReference",
    "code",
    "lifecycle",
    ...temporalFields,
  ],
  assignments: [
    "assignmentReference",
    "roleReference",
    "membershipReference",
    "storeAssignmentReference",
    "actorReference",
    "brandReference",
    "storeReference",
    "lifecycle",
    ...temporalFields,
  ],
  grants: [
    "grantReference",
    "roleReference",
    "permissionReference",
    "brandReference",
    "storeReference",
    "lifecycle",
    ...temporalFields,
  ],
  definitions: [
    "permissionReference",
    "action",
    "lifecycle",
    "version",
    "createdAt",
    "updatedAt",
    "precise",
  ],
};
function rows(value: unknown, keys: readonly string[], maximum: number) {
  const descriptor =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > maximum
  )
    throw new BrandInitialPolicyError("BRAND_INITIAL_POLICY_UNAVAILABLE");
  const values: readonly unknown[] =
    descriptor.value.length === 0
      ? Object.getPrototypeOf(descriptor.value) === Array.prototype &&
        Reflect.ownKeys(descriptor.value).length === 1
        ? []
        : (() => {
            throw new BrandInitialPolicyError();
          })()
      : brandInitialPolicyArray(descriptor.value, maximum);
  return Object.freeze(values.map((row) => readClosedRecord(row, keys)));
}
const fingerprint = (value: unknown): string => canonicalizeRfc8785(value);
const serialized = <T extends { readonly version: number }>(value: T) => ({
  ...value,
  version: String(value.version),
  precise: true,
});

/** Initialize only, on a borrowed READ COMMITTED transaction. The outer owner
 * must resolve its immutable full-operation original before invoking this writer.
 * It never replays, repairs an existing policy or creates permission definitions.
 * RLS residual checks cover the Brand policy root and visible Brand-only facts;
 * absence of pre-existing hidden Store facts relies on the required actual
 * same-transaction Brand creation guarantee, never a widened read privilege. */
export function createPostgresBrandInitialPolicyStore(options: BrandInitialPolicyStoreOptions) {
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    append = options.appendAudit,
    register = options.registerBeforeCommit,
    observedAt = stamp(options.originalObservedAt),
    originalDeadline = stamp(options.originalValidUntil);
  if (
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [queryPort, now, hold, append, register].some((port) => typeof port !== "function")
  )
    throw new BrandInitialPolicyError();
  let phase: "Open" | "Writing" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    latest = observedAt,
    deadline = originalDeadline,
    asyncCalls = 0,
    finalCalls = 0,
    checked = false,
    heldIdentity: string | undefined,
    request: BrandInitialPolicyRequest | undefined,
    requestDigest: string | undefined,
    expected: string | undefined,
    definitionIdentity: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    throw new BrandInitialPolicyError("BRAND_INITIAL_POLICY_UNAVAILABLE");
  };
  const check = () => {
    const at = stamp(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      tx !== options.transaction ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== now ||
      options.authority !== authority ||
      authority.hold !== hold ||
      options.appendAudit !== append ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const currentRequest = () => request ?? poison();
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
      [currentRequest().brandReference],
    );
  const authorize = async () => {
    const command = currentRequest();
    const raw = readClosedRecord(
      await hold.call(authority, tx, {
        request: command,
        requestDigest: requestDigest ?? poison(),
        observedAt,
        validUntil: deadline,
      }),
      [
        "operationReference",
        "brand",
        "planDigest",
        "requestDigest",
        "approvalEvidenceReference",
        "operator",
        "approvedByReference",
        "recipients",
        "validUntil",
      ],
    );
    check();
    const brand = createBrand(raw.brand),
      operator = createIdentityActor(raw.operator),
      validUntil = stamp(raw.validUntil);
    if (
      raw.operationReference !== command.operationReference ||
      raw.planDigest !== command.planDigest ||
      raw.requestDigest !== requestDigest ||
      raw.approvalEvidenceReference !== command.approvalEvidenceReference ||
      raw.approvedByReference !== command.approvedByReference ||
      brand.brandReference !== command.brandReference ||
      brand.lifecycle !== "Draft" ||
      brand.version !== 1 ||
      String(brand.createdAt) !== command.occurredAt ||
      String(brand.updatedAt) !== command.occurredAt ||
      operator.actorReference !== command.operatorReference ||
      operator.actorType !== "User" ||
      operator.status !== "Active" ||
      operator.authenticationMethod !== "Oidc" ||
      (operator.accountKind !== "Workforce" && operator.accountKind !== "Platform") ||
      operator.authenticatedAt === null ||
      String(operator.authenticatedAt) > check() ||
      (operator.recentMfaAt !== null && String(operator.recentMfaAt) > latest) ||
      validUntil <= latest
    )
      return poison();
    const recipients = brandInitialPolicyArray(raw.recipients, 20).map((value, index) => {
      const row = readClosedRecord(value, ["account", "membership"]),
        account = parseCurrentWorkforceAccount(row.account),
        member = createInitialBrandMembership(row.membership, account, observedAt),
        recipient = command.recipients[index] ?? poison();
      if (
        account.actorReference !== recipient.actorReference ||
        String(account.observedAt) < observedAt ||
        String(account.observedAt) > latest ||
        String(account.validUntil) <= latest ||
        member.membershipReference !== recipient.membershipReference ||
        member.version !== 1 ||
        String(member.createdAt) !== command.occurredAt ||
        String(member.updatedAt) !== command.occurredAt ||
        recipient.effectiveFrom < String(member.effectiveFrom) ||
        (member.effectiveUntil !== null &&
          (recipient.effectiveUntil === null ||
            recipient.effectiveUntil > String(member.effectiveUntil))) ||
        recipient.effectiveFrom > command.occurredAt ||
        (recipient.effectiveUntil !== null && recipient.effectiveUntil <= latest)
      )
        return poison();
      resolveActiveMembership([member], account.actorReference, brand.brandReference, latest);
      if (String(account.validUntil) < deadline) deadline = String(account.validUntil);
      if (member.effectiveUntil !== null && String(member.effectiveUntil) < deadline)
        deadline = String(member.effectiveUntil);
      if (recipient.effectiveUntil !== null && recipient.effectiveUntil < deadline)
        deadline = recipient.effectiveUntil;
      return Object.freeze({ account, membership: member });
    });
    if (recipients.length !== command.recipients.length) return poison();
    const identity = fingerprint({
      brand,
      operator,
      recipients: recipients.map(({ account, membership }) => {
        const { observedAt: accountObservedAt, validUntil: accountValidUntil, ...facts } = account;
        void accountObservedAt;
        void accountValidUntil;
        return { account: facts, membership };
      }),
    });
    if (heldIdentity !== undefined && heldIdentity !== identity) return poison();
    heldIdentity = identity;
    if (validUntil < deadline) deadline = validUntil;
    check();
    await restore();
    return { brand, recipients };
  };
  const readFacts = async () => {
    const values = [currentRequest().brandReference];
    return {
      state: rows(await query(stateSql, values), fields.state, 1),
      roles: rows(await query(rolesSql, values), fields.roles, 20),
      assignments: rows(await query(assignmentsSql, values), fields.assignments, 20),
      grants: rows(await query(grantsSql, values), fields.grants, 120),
      overrides: rows(await query(overridesSql, values), ["overrideReference"], 1),
    };
  };
  const definitions = async () => {
    const references = [
      ...new Set(
        currentRequest().recipients.flatMap((r) => r.grants.map((g) => g.permissionReference)),
      ),
    ].sort();
    const data = rows(await query(definitionsSql, [references]), fields.definitions, 6);
    if (data.length !== references.length) return poison();
    const result = data.map((row, index) => {
      if (
        row.precise !== true ||
        row.permissionReference !== references[index] ||
        typeof row.version !== "string" ||
        !/^[1-9][0-9]*$/u.test(row.version)
      )
        return poison();
      const definition = createPermissionDefinition({
        permissionReference: row.permissionReference,
        action: row.action,
        lifecycle: row.lifecycle,
        version: Number(row.version),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      if (
        definition.lifecycle !== "Active" ||
        String(definition.updatedAt) > currentRequest().occurredAt
      )
        return poison();
      return definition;
    });
    const identity = fingerprint(data);
    if (definitionIdentity !== undefined && identity !== definitionIdentity) return poison();
    definitionIdentity = identity;
    return result;
  };
  const inserted = async (sql: string, values: readonly unknown[], reference: string) => {
    const result = rows(await query(sql, values), ["reference"], 1);
    if (result.length !== 1 || result[0]?.reference !== reference) return poison();
  };
  return Object.freeze({
    async initialize(value: unknown) {
      try {
        if (phase !== "Open" || busy) return poison();
        busy = true;
        phase = "Writing";
        // The outer host may already contain the newly created Brand/Membership.
        // Register before even input/clock preflight, so catching an invalid
        // request cannot leave those tentative owner facts committable.
        if (
          (await register(
            tx,
            async () => {
              try {
                if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
                busy = true;
                await authorize();
                await definitions();
                if (fingerprint(await readFacts()) !== expected) return poison();
                check();
                checked = true;
              } catch {
                return poison();
              } finally {
                busy = false;
              }
            },
            () => {
              if (busy || phase !== "Ready" || !checked || asyncCalls !== 1 || ++finalCalls !== 1)
                return poison();
              check();
              phase = "Final";
            },
          )) !== undefined
        )
          return poison();
        check();
        request = parseBrandInitialPolicyRequest(value);
        requestDigest = hashBrandInitialPolicyRequest(request);
        if (request.occurredAt !== observedAt) return poison();
        const isolation = rows(
          await query("SHOW transaction_isolation", []),
          ["transaction_isolation"],
          1,
        );
        if (isolation.length !== 1 || isolation[0]?.transaction_isolation !== "read committed")
          return poison();
        const held = await authorize();
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "Brand:" + request.brandReference,
        ]);
        const before = await readFacts();
        if (Object.values(before).some((group) => group.length > 0)) {
          phase = "Poison";
          throw new BrandInitialPolicyError("BRAND_INITIAL_POLICY_ALREADY_EXISTS");
        }
        const registered = await definitions(),
          byId = new Map(registered.map((d) => [String(d.permissionReference), d]));
        const state = createBrandAdministrationPolicyState(
          {
            brandReference: request.brandReference,
            snapshotReference: request.policySnapshotReference,
            version: 1,
            updatedAt: request.occurredAt,
          },
          held.brand,
        );
        const command = currentRequest();
        const recipients = command.recipients.map((recipient, index) => {
          const period = {
            effectiveFrom: recipient.effectiveFrom,
            effectiveUntil: recipient.effectiveUntil,
            version: 1,
            createdAt: command.occurredAt,
            updatedAt: command.occurredAt,
            lifecycle: "Active",
          };
          const role = createBrandAdministrationPermissionRole(
            {
              roleReference: recipient.roleReference,
              brandReference: held.brand.brandReference,
              storeReference: null,
              code: recipient.roleCode,
              ...period,
            },
            held.brand,
          );
          const member = held.recipients[index]?.membership ?? poison();
          const assignment = createRoleAssignment(
            {
              assignmentReference: recipient.assignmentReference,
              roleReference: role.roleReference,
              membershipReference: member.membershipReference,
              storeAssignmentReference: null,
              actorReference: member.actorReference,
              brandReference: role.brandReference,
              storeReference: null,
              ...period,
            },
            role,
            member,
            null,
          );
          const grants = recipient.grants.map((grant) =>
            createPermissionGrant(
              {
                ...grant,
                roleReference: role.roleReference,
                brandReference: role.brandReference,
                storeReference: null,
                ...period,
              },
              role,
              byId.get(grant.permissionReference) ?? poison(),
            ),
          );
          return Object.freeze({ role, assignment, grants: Object.freeze(grants) });
        });
        const expectedFacts = {
          state: [serialized(state)],
          roles: recipients
            .map((r) => serialized(r.role))
            .sort((a, b) => a.roleReference.localeCompare(b.roleReference)),
          assignments: recipients
            .map((r) => serialized(r.assignment))
            .sort((a, b) => a.assignmentReference.localeCompare(b.assignmentReference)),
          grants: recipients
            .flatMap((r) => r.grants)
            .map(({ action, ...grant }) => {
              void action;
              return serialized(grant);
            })
            .sort((a, b) => a.grantReference.localeCompare(b.grantReference)),
          overrides: [],
        };
        expected = fingerprint(expectedFacts);
        await inserted(
          "INSERT INTO bop_permission.policy_state(brand_id,snapshot_id,version,updated_at) VALUES($1,$2,1,$3) RETURNING snapshot_id::text AS reference",
          [state.brandReference, state.snapshotReference, state.updatedAt],
          state.snapshotReference,
        );
        for (const recipient of recipients) {
          const { role, assignment } = recipient;
          await inserted(
            "INSERT INTO bop_permission.role(role_id,brand_id,store_id,role_code,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$6,$6) RETURNING role_id::text AS reference",
            [
              role.roleReference,
              role.brandReference,
              role.code,
              role.effectiveFrom,
              role.effectiveUntil,
              role.createdAt,
            ],
            role.roleReference,
          );
          await inserted(
            "INSERT INTO bop_permission.role_assignment(assignment_id,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$8,$8) RETURNING assignment_id::text AS reference",
            [
              assignment.assignmentReference,
              assignment.roleReference,
              assignment.membershipReference,
              assignment.actorReference,
              assignment.brandReference,
              assignment.effectiveFrom,
              assignment.effectiveUntil,
              assignment.createdAt,
            ],
            assignment.assignmentReference,
          );
          for (const grant of recipient.grants)
            await inserted(
              "INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$7,$7) RETURNING grant_id::text AS reference",
              [
                grant.grantReference,
                grant.roleReference,
                grant.permissionReference,
                grant.brandReference,
                grant.effectiveFrom,
                grant.effectiveUntil,
                grant.createdAt,
              ],
              grant.grantReference,
            );
        }
        await append(tx, {
          auditId: request.auditReference,
          brandId: request.brandReference,
          actor: { type: "User", reference: request.operatorReference },
          actionCode: "BRAND_INITIAL_POLICY_CREATED",
          targetType: "PermissionPolicy",
          targetId: request.policySnapshotReference,
          afterSummary: {
            operationReference: request.operationReference,
            planDigest: request.planDigest,
            requestDigest,
            approvalEvidenceReference: request.approvalEvidenceReference,
            approvedByReference: request.approvedByReference,
            recipientCount: recipients.length,
            grantCount: expectedFacts.grants.length,
            policyVersion: 1,
          },
          reasonCode: "APPROVED_BRAND_INITIALIZATION",
          correlationId: request.operationReference,
          occurredAt: request.occurredAt,
          sourceChannel: "DEPLOYMENT",
          dataClassification: "Restricted",
          retentionPolicyCode: "PERMISSION_POLICY_AUDIT",
          retentionPolicyVersion: 1,
        });
        check();
        await authorize();
        await definitions();
        if (fingerprint(await readFacts()) !== expected) return poison();
        phase = "Ready";
        return Object.freeze({
          profile: "BrandInitialPolicyResultV1" as const,
          request,
          requestDigest,
          state,
          recipients: Object.freeze(recipients),
          validUntil: deadline,
        });
      } catch (error) {
        phase = "Poison";
        if (error instanceof BrandInitialPolicyError) throw error;
        throw new BrandInitialPolicyError("BRAND_INITIAL_POLICY_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || asyncCalls !== 1 || finalCalls !== 1 || !checked) return poison();
    },
  });
}
