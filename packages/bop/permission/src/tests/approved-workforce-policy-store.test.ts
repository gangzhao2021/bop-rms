import {
  AUDIT_CHAIN_VERSION,
  auditChainContent,
  computeAuditRecordHash,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { describe, expect, it } from "vitest";
import { createIdentityActor } from "@bop/identity";
import {
  createApprovedPendingWorkforceMembership,
  parseApprovedWorkforceMembership,
  resolveActiveMembership,
} from "@bop/membership";
import { createBrand } from "@bop/tenant";
import {
  hashApprovedWorkforcePolicyPlan,
  parseApprovedWorkforcePolicyPlan,
  parsePrepareApprovedWorkforcePolicy,
  type PrepareApprovedWorkforcePolicy,
} from "../contracts/approved-workforce-policy.js";
import {
  createPostgresApprovedWorkforcePolicyStore,
  type ApprovedWorkforcePolicyStoreOptions,
  type ApprovedWorkforcePolicyTransaction,
  type ApprovedWorkforcePolicyAuthority,
} from "../infrastructure/persistence/approved-workforce-policy-store.js";
import * as f from "./current-policy.fixture.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Controlled fixture missing");
  return value;
}
const ORIGIN = f.AT,
  DEADLINE = "2026-07-28T12:30:05.000Z";
function command() {
  const policy = parseApprovedWorkforcePolicyPlan({
    profile: "ApprovedWorkforcePolicyV1",
    brandReference: f.BRAND,
    actorReference: f.ACTOR,
    membershipReference: f.MEMBERSHIP,
    effectiveFrom: f.FROM,
    effectiveUntil: f.UNTIL,
    roles: [
      {
        roleReference: f.BRAND_ROLE,
        roleCode: "invited_administrator",
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: f.LATER,
        assignment: {
          assignmentReference: f.BRAND_ASSIGNMENT,
          effectiveFrom: f.FROM,
          effectiveUntil: f.UNTIL,
        },
        grants: [
          {
            grantReference: f.BRAND_GRANT,
            permissionReference: f.PERMISSION,
            action: "organization.manage",
            effectiveFrom: f.FROM,
            effectiveUntil: f.LATER,
          },
        ],
      },
    ],
  });
  const approval = parseApprovedWorkforceMembership({
    profile: "ApprovedWorkforceMembershipV1",
    operationReference: f.uuid("51"),
    planDigest: `sha256:${"1".repeat(64)}`,
    operatorReference: f.uuid("52"),
    approvedByReference: f.uuid("53"),
    approvalEvidenceReference: f.uuid("54"),
    environmentReference: f.uuid("55"),
    brandReference: f.BRAND,
    membershipReference: f.MEMBERSHIP,
    actorReference: f.ACTOR,
    workforceRelationshipReference: f.WORKFORCE,
    relationshipEvidenceReference: f.uuid("56"),
    relationshipRevision: 2,
    effectiveFrom: f.FROM,
    effectiveUntil: f.UNTIL,
    approvedPolicyDigest: hashApprovedWorkforcePolicyPlan(policy),
  });
  return parsePrepareApprovedWorkforcePolicy({
    profile: "PrepareApprovedWorkforcePolicyV1",
    operationReference: approval.operationReference,
    approval,
    policy,
    expectedPolicy: null,
    policySnapshotReference: f.NEXT_SNAPSHOT,
  });
}
type Row = Record<string, unknown>;
/** Controlled SQL/authority/Audit ports exercise actual public Domain parsing,
 * mutations and host guard behavior. They are not native persistence or actual
 * signed approval, Provider verification or a completed onboarding callback. */
function fixture(input = command()) {
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    audit: AppendAuditRecordInput[] = [];
  const tables: Record<
    "state" | "roles" | "assignments" | "grants" | "overrides" | "definitions",
    Row[]
  > = {
    state: [],
    roles: [],
    assignments: [],
    grants: [],
    overrides: [],
    definitions: [
      {
        permissionReference: f.PERMISSION,
        action: "organization.manage",
        lifecycle: "Active",
        version: "1",
        createdAt: f.FROM,
        updatedAt: f.FROM,
        precise: true,
      },
    ],
  };
  const control = {
    time: String(ORIGIN),
    transactionId: "100",
    autocommit: false,
    isolation: "read committed",
    allowed: true,
    auditFailure: false,
    response: (_sql: string, result: unknown): unknown => result,
    beforeQuery: async (_sql: string) => {
      void _sql;
    },
    beforeGuards: async () => undefined,
    beforeFinal: () => undefined,
    authority: (value: ApprovedWorkforcePolicyAuthority): ApprovedWorkforcePolicyAuthority => value,
  };
  const brand = createBrand({ ...f.brand, lifecycle: "Draft" });
  const member = createApprovedPendingWorkforceMembership(
    { ...f.membership, lifecycle: "PendingActivation", version: 1 },
    f.ACTOR,
  );
  const tx: ApprovedWorkforcePolicyTransaction = {
    async query(sql, values) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      await control.beforeQuery(sql);
      let result: unknown;
      if (sql.includes("pg_current_xact_id")) {
        if (control.autocommit) control.transactionId = String(Number(control.transactionId) + 1);
        result = {
          rows: [{ isolation: control.isolation, transaction_id: control.transactionId }],
        };
      } else if (
        sql.includes("set_config") ||
        sql.includes("pg_advisory_xact_lock") ||
        sql.startsWith("LOCK TABLE")
      )
        result = { rows: [] };
      else if (sql.startsWith("SELECT role_id::text AS reference"))
        result = { rows: tables.roles.slice(0, 1).map((r) => ({ reference: r.roleReference })) };
      else if (sql.startsWith("SELECT assignment_id::text AS reference"))
        result = {
          rows: tables.assignments.slice(0, 1).map((r) => ({ reference: r.assignmentReference })),
        };
      else if (sql.startsWith("SELECT grant_id::text AS reference"))
        result = { rows: tables.grants.slice(0, 1).map((r) => ({ reference: r.grantReference })) };
      else if (sql.includes("FROM bop_permission.policy_state")) result = { rows: tables.state };
      else if (sql.includes("FROM bop_permission.permission_definition"))
        result = {
          rows: tables.definitions.filter(
            (d) => Array.isArray(values[0]) && values[0].includes(d.permissionReference),
          ),
        };
      else if (sql.includes("FROM bop_permission.role_assignment"))
        result = {
          rows: tables.assignments.filter(
            (a) => a.actorReference === values[1] || a.membershipReference === values[2],
          ),
        };
      else if (sql.includes("FROM bop_permission.role "))
        result = {
          rows: tables.roles.filter(
            (r) =>
              (Array.isArray(values[1]) && values[1].includes(r.roleReference)) ||
              (Array.isArray(values[2]) && values[2].includes(r.code)),
          ),
        };
      else if (sql.includes("FROM bop_permission.permission_grant"))
        result = {
          rows: tables.grants.filter(
            (g) => Array.isArray(values[1]) && values[1].includes(g.roleReference),
          ),
        };
      else if (sql.includes("FROM bop_permission.permission_override"))
        result = {
          rows: tables.overrides
            .filter((o) => o.actorReference === values[1])
            .slice(0, 1)
            .map((o) => ({ reference: o.reference })),
        };
      else if (sql.startsWith("INSERT INTO bop_permission.policy_state")) {
        tables.state.push({
          brandReference: values[0],
          snapshotReference: values[1],
          version: "1",
          updatedAt: values[2],
          precise: true,
        });
        result = { rows: [{ reference: values[1] }] };
      } else if (sql.startsWith("UPDATE bop_permission.policy_state")) {
        const row = tables.state.find(
          (r) =>
            r.brandReference === values[0] &&
            r.snapshotReference === values[4] &&
            r.version === String(values[5]),
        );
        if (row)
          Object.assign(row, {
            snapshotReference: values[1],
            version: String(values[2]),
            updatedAt: values[3],
          });
        result = { rows: row ? [{ reference: values[1] }] : [] };
      } else if (sql.startsWith("INSERT INTO bop_permission.role(")) {
        tables.roles.push({
          roleReference: values[0],
          brandReference: values[1],
          storeReference: null,
          code: values[2],
          lifecycle: "Active",
          effectiveFrom: values[3],
          effectiveUntil: values[4],
          version: "1",
          createdAt: values[5],
          updatedAt: values[5],
          precise: true,
        });
        result = { rows: [{ reference: values[0] }] };
      } else if (sql.startsWith("INSERT INTO bop_permission.permission_grant(")) {
        tables.grants.push({
          grantReference: values[0],
          roleReference: values[1],
          permissionReference: values[2],
          brandReference: values[3],
          storeReference: null,
          lifecycle: "Active",
          effectiveFrom: values[4],
          effectiveUntil: values[5],
          version: "1",
          createdAt: values[6],
          updatedAt: values[6],
          precise: true,
        });
        result = { rows: [{ reference: values[0] }] };
      } else if (sql.startsWith("INSERT INTO bop_permission.role_assignment(")) {
        tables.assignments.push({
          assignmentReference: values[0],
          roleReference: values[1],
          membershipReference: values[2],
          storeAssignmentReference: null,
          actorReference: values[3],
          brandReference: values[4],
          storeReference: null,
          lifecycle: "Active",
          effectiveFrom: values[5],
          effectiveUntil: values[6],
          version: "1",
          createdAt: values[7],
          updatedAt: values[7],
          precise: true,
        });
        result = { rows: [{ reference: values[0] }] };
      } else throw new Error("Unexpected controlled SQL");
      return control.response(sql, result);
    },
  };
  const options: ApprovedWorkforcePolicyStoreOptions = {
    transaction: tx,
    clock: { now: () => control.time },
    originalObservedAt: ORIGIN,
    originalValidUntil: DEADLINE,
    auditReference: f.uuid("61"),
    authority: {
      async hold(actual, request) {
        expect(actual).toBe(tx);
        if (!control.allowed) throw new Error("Controlled authority withdrawn");
        const preparing = request.request.profile === "PrepareApprovedWorkforcePolicyV1";
        return control.authority({
          requestDigest: request.requestDigest,
          approval: request.request.approval,
          brand,
          pendingMembership: member,
          operator: createIdentityActor({
            ...f.actor,
            actorReference: preparing ? input.approval.operatorReference : f.ACTOR,
            verificationLevel: "RecentMfa",
            authenticatedAt: ORIGIN,
            recentMfaAt: ORIGIN,
          }),
          relationship: {
            profile: "CurrentWorkforceRelationshipQualificationV1",
            environmentReference: input.approval.environmentReference,
            actorReference: f.ACTOR,
            brandReference: f.BRAND,
            workforceRelationshipReference: f.WORKFORCE,
            relationshipEvidenceReference: input.approval.relationshipEvidenceReference,
            issuerReference: f.uuid("62"),
            revision: 2,
            relationshipEffectiveFrom: f.FROM,
            relationshipEffectiveUntil: f.UNTIL,
            verifiedAt: f.FROM,
            observedAt: request.observedAt,
            validUntil: request.validUntil,
          },
          observedAt: request.observedAt,
          validUntil: request.validUntil,
        });
      },
    },
    async appendAudit(actual, record) {
      expect(actual).toBe(tx);
      audit.push(record);
      if (control.auditFailure) throw new Error("Controlled Audit failure");
      // Controlled append boundary returns an actual owning chain shape/hash;
      // isolated PostgreSQL acceptance separately proves the writer transaction.
      const content = auditChainContent(record),
        sequence = audit.length,
        recordedAt = ORIGIN;
      let previousHash: string | null = null;
      for (let index = 0; index < audit.length - 1; index++) {
        previousHash = computeAuditRecordHash({
          content: auditChainContent(required(audit[index])),
          sequence: index + 1,
          previousHash,
          recordedAt,
        });
      }
      return Object.freeze({
        version: AUDIT_CHAIN_VERSION,
        content,
        sequence,
        previousHash,
        recordedAt,
        recordHash: computeAuditRecordHash({ content, sequence, previousHash, recordedAt }),
      });
    },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
  };
  const run = async <T>(work: () => Promise<T>) => {
    const saved = structuredClone(tables),
      oldAudit = audit.length;
    guards.length = 0;
    finals.length = 0;
    try {
      const result = await work();
      await control.beforeGuards();
      for (const guard of guards) await guard();
      control.beforeFinal();
      for (const final of finals) final();
      return result;
    } catch (error) {
      for (const key of Object.keys(saved) as (keyof typeof tables)[]) tables[key] = saved[key];
      audit.length = oldAudit;
      throw error;
    }
  };
  const create = () => createPostgresApprovedWorkforcePolicyStore(options);
  const holdRequest = () => ({
    profile: "HoldApprovedWorkforcePolicyV1",
    approval: input.approval,
    policy: input.policy,
  });
  const seed = () => {
    const spec = required(input.policy.roles[0]),
      g = required(spec.grants[0]);
    tables.state.push({
      brandReference: f.BRAND,
      snapshotReference: f.SNAPSHOT,
      version: "4",
      updatedAt: f.FROM,
      precise: true,
    });
    tables.roles.push({
      roleReference: spec.roleReference,
      brandReference: f.BRAND,
      storeReference: null,
      code: spec.roleCode,
      lifecycle: "Active",
      effectiveFrom: spec.effectiveFrom,
      effectiveUntil: spec.effectiveUntil,
      version: "3",
      createdAt: f.FROM,
      updatedAt: f.FROM,
      precise: true,
    });
    tables.grants.push({
      grantReference: g.grantReference,
      roleReference: spec.roleReference,
      permissionReference: g.permissionReference,
      brandReference: f.BRAND,
      storeReference: null,
      lifecycle: "Active",
      effectiveFrom: g.effectiveFrom,
      effectiveUntil: g.effectiveUntil,
      version: "2",
      createdAt: f.FROM,
      updatedAt: f.FROM,
      precise: true,
    });
  };
  return {
    input,
    options,
    tx,
    tables,
    calls,
    guards,
    finals,
    audit,
    control,
    member,
    run,
    create,
    holdRequest,
    seed,
  };
}

describe("approved Workforce policy owning persistence", () => {
  it("prepares actual parsed policy rows, keeps Pending ineffective and seals only at real host callbacks", async () => {
    const f = fixture(),
      source = f.create();
    const result = await f.run(() => source.prepareApproved(f.input));
    expect(result.contentDigest).toBe(f.input.approval.approvedPolicyDigest);
    expect(result.policyVersion).toBe(1);
    expect(f.tables.roles).toHaveLength(1);
    expect(f.tables.grants).toHaveLength(1);
    expect(f.tables.assignments).toHaveLength(1);
    expect(f.audit).toHaveLength(1);
    expect(f.audit[0]).toMatchObject({
      actor: { reference: f.input.approval.operatorReference },
      actionCode: "APPROVED_WORKFORCE_POLICY_PREPARED",
      occurredAt: ORIGIN,
    });
    expect(() =>
      resolveActiveMembership([f.member], f.member.actorReference, f.member.brandReference, ORIGIN),
    ).toThrow();
    const identities = f.calls.filter((c) => c.sql.includes("pg_current_xact_id"));
    expect(identities.length).toBeGreaterThanOrEqual(3);
    f.control.time = "2026-07-29T00:00:00.000Z";
    source.assertFinalized();
  });
  it("CAS advances existing policy, reuses exact different-period roles/grants, preserves unrelated content", async () => {
    const f = fixture();
    f.seed();
    const unrelated = {
      ...required(f.tables.roles[0]),
      roleReference: "018f4f8a-9c2d-7a11-8d01-000000000099",
      code: "other_role",
    };
    f.tables.roles.push(unrelated);
    const beforeRole = structuredClone(f.tables.roles),
      beforeGrant = structuredClone(f.tables.grants);
    const input = parsePrepareApprovedWorkforcePolicy({
      ...f.input,
      expectedPolicy: {
        snapshotReference: required(f.tables.state[0]).snapshotReference,
        version: 4,
      },
    });
    const source = f.create();
    const result = await f.run(() => source.prepareApproved(input));
    expect(result.policyVersion).toBe(5);
    expect(f.tables.roles).toEqual(beforeRole);
    expect(f.tables.grants).toEqual(beforeGrant);
    expect(f.calls.some((c) => c.sql.startsWith("UPDATE bop_permission.policy_state"))).toBe(true);
    expect(f.calls.some((c) => c.sql.startsWith("INSERT INTO bop_permission.role("))).toBe(false);
    source.assertFinalized();
  });
  it("does not turn missing preparation into a successful approval proof", async () => {
    const f = fixture();
    await expect(f.run(() => f.create().holdApproved(f.holdRequest()))).rejects.toThrow();
    expect(f.calls.some((c) => /^(INSERT|UPDATE)/u.test(c.sql))).toBe(false);
    expect(f.audit).toHaveLength(0);
  });
  it("holds and re-holds exact prepared rows for actual target MFA without writes or lease renewal", async () => {
    const f = fixture(),
      writer = f.create();
    await f.run(() => writer.prepareApproved(f.input));
    writer.assertFinalized();
    const source = f.create();
    const oldAudit = f.audit.length;
    const result = await f.run(async () => {
      const first = await source.holdApproved(f.holdRequest());
      f.control.time = "2026-07-28T12:30:01.000Z";
      expect(await source.holdApproved(f.holdRequest())).toEqual(first);
      return first;
    });
    expect(result).toEqual({
      approvedPolicyDigest: f.input.approval.approvedPolicyDigest,
      contentDigest: f.input.approval.approvedPolicyDigest,
      policySnapshotReference: f.input.policySnapshotReference,
      policyVersion: 1,
      observedAt: ORIGIN,
      validUntil: DEADLINE,
    });
    expect(f.audit).toHaveLength(oldAudit);
    source.assertFinalized();
  });
  it("shortens the original lease to the actual independently approved role boundary", async () => {
    const original = command(),
      role = required(original.policy.roles[0]);
    const policy = parseApprovedWorkforcePolicyPlan({
      ...original.policy,
      roles: [{ ...role, effectiveUntil: "2026-07-28T12:30:02.000Z" }],
    });
    const input = parsePrepareApprovedWorkforcePolicy({
      ...original,
      policy,
      approval: {
        ...original.approval,
        approvedPolicyDigest: hashApprovedWorkforcePolicyPlan(policy),
      },
    });
    const f = fixture(input),
      source = f.create();
    const result = await f.run(() => source.prepareApproved(input));
    expect(result.validUntil).toBe("2026-07-28T12:30:02.000Z");
    source.assertFinalized();
  });
  it.each([
    "definition",
    "extraGrant",
    "rolePeriod",
    "assignmentPeriod",
    "extraAssignment",
    "override",
    "policyHead",
  ] as const)("rejects current %s drift during held activation", async (kind) => {
    const f = fixture();
    await f.run(() => f.create().prepareApproved(f.input));
    const source = f.create();
    f.control.beforeGuards = async () => {
      if (kind === "definition") required(f.tables.definitions[0]).lifecycle = "Retired";
      if (kind === "extraGrant")
        f.tables.grants.push({
          ...required(f.tables.grants[0]),
          grantReference: f.input.operationReference,
        });
      if (kind === "rolePeriod")
        required(f.tables.roles[0]).effectiveUntil = f.input.policy.effectiveUntil;
      if (kind === "assignmentPeriod") required(f.tables.assignments[0]).effectiveFrom = ORIGIN;
      if (kind === "extraAssignment")
        f.tables.assignments.push({
          ...required(f.tables.assignments[0]),
          assignmentReference: f.input.operationReference,
        });
      if (kind === "override")
        f.tables.overrides.push({
          reference: f.input.operationReference,
          actorReference: f.input.policy.actorReference,
        });
      if (kind === "policyHead") required(f.tables.state[0]).version = "2";
    };
    await expect(f.run(() => source.holdApproved(f.holdRequest()))).rejects.toThrow();
    expect(() => source.assertFinalized()).toThrow();
  });
  it.each([
    "permissionMissing",
    "permissionMismatch",
    "staleCAS",
    "roleMismatch",
    "residualAssignment",
  ] as const)("refuses %s rather than repairing or overwriting", async (kind) => {
    const f = fixture();
    let input: PrepareApprovedWorkforcePolicy = f.input;
    if (kind === "permissionMissing") f.tables.definitions = [];
    if (kind === "permissionMismatch")
      required(f.tables.definitions[0]).action = "publishing.review.approve";
    if (kind === "staleCAS" || kind === "roleMismatch") {
      f.seed();
      input = parsePrepareApprovedWorkforcePolicy({
        ...f.input,
        expectedPolicy: {
          snapshotReference: required(f.tables.state[0]).snapshotReference,
          version: kind === "staleCAS" ? 3 : 4,
        },
      });
    }
    if (kind === "roleMismatch") required(f.tables.roles[0]).code = "different_role";
    if (kind === "residualAssignment")
      f.tables.assignments.push({
        unexpected: true,
        actorReference: f.input.policy.actorReference,
      });
    const before = structuredClone(f.tables);
    await expect(f.run(() => f.create().prepareApproved(input))).rejects.toThrow();
    expect(f.tables).toEqual(before);
    expect(f.audit).toHaveLength(0);
  });
  it.each([
    "requestDigest",
    "approval",
    "brand",
    "member",
    "operator",
    "mfa",
    "relationship",
    "deadline",
  ] as const)("rejects actual authority %s mismatch before writes", async (kind) => {
    const f = fixture();
    f.control.authority = (packet) => {
      if (kind === "requestDigest") return { ...packet, requestDigest: `sha256:${"0".repeat(64)}` };
      if (kind === "approval")
        return {
          ...packet,
          approval: { ...packet.approval, planDigest: `sha256:${"0".repeat(64)}` },
        };
      if (kind === "brand")
        return { ...packet, brand: createBrand({ ...packet.brand, lifecycle: "Suspended" }) };
      if (kind === "member")
        return {
          ...packet,
          pendingMembership: { ...packet.pendingMembership, lifecycle: "Active" },
        };
      if (kind === "operator")
        return {
          ...packet,
          operator: createIdentityActor({
            ...packet.operator,
            actorReference: f.input.approval.approvedByReference,
          }),
        };
      if (kind === "mfa")
        return {
          ...packet,
          operator: createIdentityActor({
            ...packet.operator,
            verificationLevel: "SingleFactor",
            recentMfaAt: null,
          }),
        };
      if (kind === "relationship")
        return { ...packet, relationship: { ...packet.relationship, revision: 3 } };
      return { ...packet, validUntil: "2026-07-28T12:30:06.000Z" };
    };
    await expect(f.run(() => f.create().prepareApproved(f.input))).rejects.toThrow();
    expect(f.tables.state).toHaveLength(0);
    expect(f.audit).toHaveLength(0);
  });
  it.each(["withdraw", "clock", "audit", "queryReplacement", "lateSql"] as const)(
    "rolls back preparation and Audit on %s",
    async (kind) => {
      const f = fixture();
      if (kind === "audit") f.control.auditFailure = true;
      f.control.beforeGuards = async () => {
        if (kind === "withdraw") f.control.allowed = false;
        if (kind === "clock") f.control.time = DEADLINE;
        if (kind === "queryReplacement") f.tx.query = async () => ({ rows: [] });
        if (kind === "lateSql")
          f.control.beforeQuery = async (sql) => {
            if (sql.includes("FROM bop_permission.role "))
              throw new Error("Controlled database failure");
          };
      };
      await expect(f.run(() => f.create().prepareApproved(f.input))).rejects.toThrow();
      expect(f.tables.state).toHaveLength(0);
      expect(f.audit).toHaveLength(0);
    },
  );
  it("rechecks the original deadline in the synchronous final seal", async () => {
    const f = fixture();
    f.control.beforeFinal = () => {
      f.control.time = DEADLINE;
    };
    await expect(f.run(() => f.create().prepareApproved(f.input))).rejects.toThrow();
    expect(f.tables.state).toHaveLength(0);
    expect(f.audit).toHaveLength(0);
  });
  it("permits repeat holds after the async guard while retaining the same final deadline", async () => {
    const f = fixture();
    await f.run(() => f.create().prepareApproved(f.input));
    const source = f.create();
    await source.holdApproved(f.holdRequest());
    // The earlier source is already finalized; invoke only this holder's actual
    // newly registered callbacks, as a composing host may do before later guards.
    await required(f.guards.at(-1))();
    expect((await source.holdApproved(f.holdRequest())).validUntil).toBe(DEADLINE);
    required(f.finals.at(-1))();
    source.assertFinalized();
  });
  it("refuses autocommit before mutation", async () => {
    const f = fixture();
    f.control.autocommit = true;
    await expect(f.run(() => f.create().prepareApproved(f.input))).rejects.toThrow();
    expect(f.calls.some((c) => /^(INSERT|UPDATE)/u.test(c.sql))).toBe(false);
    expect(f.audit).toHaveLength(0);
  });
  it("poisons caught invalid preflight, second preparation and early final assertions", async () => {
    for (const kind of ["invalid", "repeat", "assert"] as const) {
      const f = fixture(),
        source = f.create();
      await expect(
        f.run(async () => {
          if (kind === "assert") {
            expect(() => source.assertFinalized()).toThrow();
            await expect(source.prepareApproved(f.input)).rejects.toThrow();
          } else if (kind === "invalid")
            await expect(source.prepareApproved({ ...f.input, policy: {} })).rejects.toThrow();
          else {
            await source.prepareApproved(f.input);
            await expect(source.prepareApproved(f.input)).rejects.toThrow();
          }
        }),
      ).rejects.toThrow();
      expect(f.tables.state).toHaveLength(0);
      expect(f.audit).toHaveLength(0);
    }
  });
  it("poisons concurrent reentry even if the caller catches the second failure", async () => {
    const f = fixture(),
      source = f.create();
    let entered = false;
    f.control.beforeQuery = async (sql) => {
      if (!entered && sql.includes("pg_current_xact_id")) {
        entered = true;
        await expect(source.prepareApproved(f.input)).rejects.toThrow();
      }
    };
    await expect(f.run(() => source.prepareApproved(f.input))).rejects.toThrow();
    expect(f.tables.state).toHaveLength(0);
  });
  it("rejects malformed/overbounded/precision-lost rows without invoking row accessors", async () => {
    for (const kind of ["hole", "getter", "overflow", "precision"] as const) {
      const f = fixture();
      let getter = false;
      f.control.response = (sql, result) => {
        if (!sql.includes("FROM bop_permission.permission_definition")) return result;
        if (kind === "hole") return { rows: Array(1) };
        if (kind === "getter")
          return {
            rows: [
              Object.defineProperty({}, "permissionReference", {
                enumerable: true,
                get() {
                  getter = true;
                  return f.input.operationReference;
                },
              }),
            ],
          };
        if (kind === "overflow")
          return { rows: Array.from({ length: 7 }, () => required(f.tables.definitions[0])) };
        return { rows: [{ ...required(f.tables.definitions[0]), precise: false }] };
      };
      await expect(f.run(() => f.create().prepareApproved(f.input))).rejects.toThrow();
      expect(getter).toBe(false);
      expect(f.audit).toHaveLength(0);
    }
  });
});
