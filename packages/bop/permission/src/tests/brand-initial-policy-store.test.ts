import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  appendAuditRecordInTransaction,
  computeAuditRecordHash,
  type AuditChainRecordV1,
} from "@bop/audit";
import { createIdentityActor, parseCurrentWorkforceAccount } from "@bop/identity";
import { createInitialBrandMembership } from "@bop/membership";
import { createBrand } from "@bop/tenant";
import {
  parseBrandInitialPolicyRequest,
  hashBrandInitialPolicyRequest,
} from "../contracts/brand-initial-policy.js";
import {
  createPostgresBrandInitialPolicyStore,
  type BrandInitialPolicyStoreOptions,
  type BrandInitialPolicyTransaction,
} from "../infrastructure/persistence/brand-initial-policy-store.js";
import * as f from "./current-policy.fixture.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing controlled fixture value");
  return value;
}

function request() {
  return parseBrandInitialPolicyRequest({
    profile: "BrandInitialPolicyV1",
    operationReference: f.uuid("51"),
    brandReference: f.BRAND,
    planDigest: `sha256:${"1".repeat(64)}`,
    approvalEvidenceReference: f.uuid("52"),
    operatorReference: f.uuid("53"),
    approvedByReference: f.uuid("54"),
    policySnapshotReference: f.SNAPSHOT,
    auditReference: f.uuid("55"),
    occurredAt: f.AT,
    recipients: [
      {
        actorReference: f.ACTOR,
        membershipReference: f.MEMBERSHIP,
        roleReference: f.BRAND_ROLE,
        roleCode: "initial_brand_admin",
        assignmentReference: f.BRAND_ASSIGNMENT,
        effectiveFrom: f.AT,
        effectiveUntil: f.UNTIL,
        grants: [
          {
            grantReference: f.BRAND_GRANT,
            permissionReference: f.PERMISSION,
            action: "organization.manage",
          },
          {
            grantReference: f.uuid("61"),
            permissionReference: f.uuid("62"),
            action: "publishing.review.submit",
          },
        ],
      },
    ],
  });
}
// Controlled SQL transport only. Domain constructors and the real public Audit
// append/hash implementation run unchanged; actual PG atomicity is a native gate.
function fixture(command = request()) {
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    audit: AuditChainRecordV1[] = [];
  const tables: Record<
    "state" | "roles" | "assignments" | "grants" | "overrides",
    Record<string, unknown>[]
  > = {
    state: [],
    roles: [],
    assignments: [],
    grants: [],
    overrides: [],
  };
  const definitions = [
    { permissionReference: f.PERMISSION, action: "organization.manage" },
    { permissionReference: f.uuid("62"), action: "publishing.review.submit" },
  ]
    .map((r) => ({
      ...r,
      lifecycle: "Active",
      version: "1",
      createdAt: f.FROM,
      updatedAt: f.FROM,
      precise: true,
    }))
    .sort((a, b) => a.permissionReference.localeCompare(b.permissionReference));
  const control = {
    time: String(f.AT),
    isolation: "read committed",
    auditFailure: false,
    approvalValid: true,
    beforeQuery: async (_sql: string) => {
      void _sql;
    },
    response: (_sql: string, result: unknown): unknown => result,
    beforeGuards: async () => undefined,
    beforeFinal: () => undefined,
    hold: (packet: Awaited<ReturnType<BrandInitialPolicyStoreOptions["authority"]["hold"]>>) =>
      packet,
  };
  let sequence = 1,
    hash: string | null = null,
    clockReads = 0;
  const tx: BrandInitialPolicyTransaction = {
    async query(sql, values) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      await control.beforeQuery(sql);
      let result: unknown;
      if (sql === "SHOW transaction_isolation")
        result = { rows: [{ transaction_isolation: control.isolation }] };
      else if (sql.includes("set_config") || sql.includes("pg_advisory_xact_lock"))
        result = { rows: [] };
      else if (sql.includes("FROM bop_permission.permission_definition"))
        result = { rows: definitions };
      else if (sql.includes("FROM bop_permission.policy_state")) result = { rows: tables.state };
      else if (sql.includes("FROM bop_permission.role_assignment"))
        result = { rows: tables.assignments };
      else if (sql.includes("FROM bop_permission.role ")) result = { rows: tables.roles };
      else if (sql.includes("FROM bop_permission.permission_grant"))
        result = { rows: tables.grants };
      else if (sql.includes("FROM bop_permission.permission_override"))
        result = { rows: tables.overrides };
      else if (sql.startsWith("INSERT INTO bop_permission.policy_state")) {
        tables.state.push({
          brandReference: values[0],
          snapshotReference: values[1],
          version: "1",
          updatedAt: values[2],
          precise: true,
        });
        result = { rows: [{ reference: values[1] }] };
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
        tables.roles.sort((a, b) => String(a.roleReference).localeCompare(String(b.roleReference)));
        result = { rows: [{ reference: values[0] }] };
      } else if (sql.startsWith("INSERT INTO bop_permission.role_assignment")) {
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
        tables.assignments.sort((a, b) =>
          String(a.assignmentReference).localeCompare(String(b.assignmentReference)),
        );
        result = { rows: [{ reference: values[0] }] };
      } else if (sql.startsWith("INSERT INTO bop_permission.permission_grant")) {
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
        tables.grants.sort((a, b) =>
          String(a.grantReference).localeCompare(String(b.grantReference)),
        );
        result = { rows: [{ reference: values[0] }] };
      } else if (sql.startsWith("INSERT INTO platform_audit.audit_chain_head"))
        result = { rows: [] };
      else if (sql.includes("FROM platform_audit.audit_chain_head"))
        result = {
          rows: [{ next_sequence: String(sequence), previous_hash: hash, recorded_at: f.AT }],
        };
      else if (sql.startsWith("INSERT INTO platform_audit.audit_record")) result = { rows: [] };
      else if (sql.startsWith("UPDATE platform_audit.audit_chain_head")) {
        sequence++;
        hash = Buffer.from(values[2] as Uint8Array).toString("hex");
        result = { rows: [{ next_sequence: String(sequence) }] };
      } else throw new Error("Unexpected controlled SQL");
      return control.response(sql, result);
    },
  };
  const brand = createBrand({ ...f.brand, lifecycle: "Draft", createdAt: f.AT, updatedAt: f.AT }),
    recipients = command.recipients.map((r) => {
      const account = parseCurrentWorkforceAccount({
        profile: "CurrentWorkforceAccountV1",
        actorType: "User",
        actorReference: r.actorReference,
        accountKind: "Workforce",
        status: "Active",
        observedAt: f.AT,
        validUntil: new Date(Date.parse(f.AT) + 5000).toISOString(),
      });
      return {
        account,
        membership: createInitialBrandMembership(
          {
            ...f.membership,
            membershipReference: r.membershipReference,
            actorReference: r.actorReference,
            createdAt: f.AT,
            updatedAt: f.AT,
            effectiveFrom: f.AT,
          },
          account,
          f.AT,
        ),
      };
    }),
    operator = createIdentityActor({ ...f.actor, actorReference: command.operatorReference });
  const options: BrandInitialPolicyStoreOptions = {
    transaction: tx,
    clock: {
      now: () => {
        clockReads++;
        return control.time;
      },
    },
    originalObservedAt: f.AT,
    originalValidUntil: new Date(Date.parse(f.AT) + 5000).toISOString(),
    authority: {
      async hold(actual, input) {
        expect(actual).toBe(tx);
        expect(guards).toHaveLength(1);
        expect(finals).toHaveLength(1);
        expect(input.request).toEqual(command);
        expect(input.requestDigest).toBe(hashBrandInitialPolicyRequest(command));
        if (!control.approvalValid) throw new Error("Controlled approval withdrawal");
        return control.hold({
          operationReference: command.operationReference,
          brand,
          planDigest: command.planDigest,
          requestDigest: input.requestDigest,
          approvalEvidenceReference: command.approvalEvidenceReference,
          operator,
          approvedByReference: command.approvedByReference,
          recipients,
          validUntil: input.validUntil,
        });
      },
    },
    appendAudit: async (actual, input) => {
      expect(actual).toBe(tx);
      const record = await appendAuditRecordInTransaction(actual, input);
      audit.push(record);
      if (control.auditFailure) throw new Error("Controlled Audit failure");
      return record;
    },
    registerBeforeCommit: async (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
  };
  const store = createPostgresBrandInitialPolicyStore(options);
  async function commit() {
    const before = structuredClone(tables),
      oldAudit = audit.length,
      oldSequence = sequence,
      oldHash = hash;
    try {
      const result = await store.initialize(command);
      await control.beforeGuards();
      for (const guard of guards) await guard();
      control.beforeFinal();
      for (const final of finals) final();
      return result;
    } catch (error) {
      Object.assign(tables, before);
      audit.length = oldAudit;
      sequence = oldSequence;
      hash = oldHash;
      throw error;
    }
  }
  return {
    command,
    tx,
    options,
    store,
    tables,
    definitions,
    control,
    calls,
    guards,
    finals,
    audit,
    commit,
    clockReads: () => clockReads,
  };
}
describe("initial Brand policy persistence", () => {
  it("initializes actual Draft/Membership v1, explicit grants and real Audit in one borrowed transaction", async () => {
    const x = fixture(),
      result = await x.commit();
    expect(result.state.version).toBe(1);
    expect(result.requestDigest).toBe(hashBrandInitialPolicyRequest(x.command));
    expect(x.tables.roles).toHaveLength(1);
    expect(x.tables.assignments).toHaveLength(1);
    expect(x.tables.grants).toHaveLength(2);
    expect(x.tables.overrides).toEqual([]);
    expect(x.audit).toHaveLength(1);
    const audit = x.audit[0];
    if (!audit) throw new Error("Missing controlled Audit");
    expect(audit.content).toMatchObject({
      actorReference: x.command.operatorReference,
      brandId: f.BRAND,
      storeId: null,
      targetId: f.SNAPSHOT,
      correlationId: x.command.operationReference,
      occurredAt: f.AT,
      afterSummary: {
        requestDigest: result.requestDigest,
        approvedByReference: x.command.approvedByReference,
      },
    });
    expect(audit.recordHash).toBe(
      computeAuditRecordHash({
        content: audit.content,
        sequence: 1,
        previousHash: null,
        recordedAt: f.AT,
      }),
    );
    expect(x.calls.find((call) => call.sql.includes("pg_advisory_xact_lock"))?.values).toEqual([
      "Brand:" + f.BRAND,
    ]);
    expect(
      x.calls.some(
        (call) =>
          call.sql.includes("FROM bop_permission.permission_definition") &&
          call.sql.endsWith("FOR SHARE"),
      ),
    ).toBe(true);
    expect(
      x.calls.filter((call) =>
        call.sql.startsWith("INSERT INTO bop_permission.permission_definition"),
      ),
    ).toEqual([]);
    expect(
      x.calls.filter((call) => /^(UPDATE|DELETE|TRUNCATE) bop_permission/u.test(call.sql)),
    ).toEqual([]);
    const reads = x.clockReads();
    x.control.time = f.LATER;
    x.store.assertFinalized();
    expect(x.clockReads()).toBe(reads);
  });
  it.each(["state", "roles", "assignments", "grants", "overrides"] as const)(
    "refuses existing visible %s without repair",
    async (group) => {
      const x = fixture();
      // A valid current packet is obtained once, then offered as a pre-existing
      // root in a fresh initializer. No caller truth value substitutes for SQL.
      await x.commit();
      const y = fixture();
      y.tables[group] =
        group === "overrides"
          ? [{ overrideReference: f.uuid("80") }]
          : structuredClone(x.tables[group]);
      await expect(y.commit()).rejects.toMatchObject({
        code: "BRAND_INITIAL_POLICY_ALREADY_EXISTS",
      });
      expect(y.calls.some((call) => call.sql.startsWith("INSERT"))).toBe(false);
    },
  );
  it("writes separately approved recipient subsets and accepts a genuine Platform operator only as identity", async () => {
    const original = request(),
      first = original.recipients[0];
    if (!first) throw new Error("Missing controlled recipient");
    const command = parseBrandInitialPolicyRequest({
      ...original,
      recipients: [
        {
          ...first,
          actorReference: f.uuid("91"),
          membershipReference: f.uuid("92"),
          roleReference: f.uuid("93"),
          roleCode: "second_initial_admin",
          assignmentReference: f.uuid("94"),
          grants: [{ ...first.grants[0], grantReference: f.uuid("95") }],
        },
        first,
      ],
    });
    const x = fixture(command);
    x.control.hold = (p) => ({
      ...p,
      operator: createIdentityActor({ ...p.operator, accountKind: "Platform" }),
    });
    const result = await x.commit();
    expect(result.recipients.map((r) => r.grants.length)).toEqual([1, 2]);
    expect(x.tables.assignments).toHaveLength(2);
    expect(x.tables.grants).toHaveLength(3);
    expect(x.audit[0]?.content.actorReference).toBe(command.operatorReference);
  });
  it.each([
    "wrongPlan",
    "wrongRequestDigest",
    "wrongOperation",
    "wrongEvidence",
    "wrongApprover",
    "wrongOperator",
    "ActiveBrand",
    "oldBrand",
    "brandVersion",
    "foreignBrand",
    "oldMember",
    "wrongMember",
    "foreignMember",
    "suspendedMember",
    "targetPlatform",
    "futureAccount",
  ])("rejects actual authority mismatch %s before any insert", async (kind) => {
    const x = fixture();
    x.control.hold = (p) => {
      const member = p.recipients[0];
      if (!member) throw new Error("Missing controlled member");
      switch (kind) {
        case "wrongPlan":
          return { ...p, planDigest: `sha256:${"2".repeat(64)}` };
        case "wrongRequestDigest":
          return { ...p, requestDigest: `sha256:${"2".repeat(64)}` };
        case "wrongOperation":
          return { ...p, operationReference: f.uuid("80") };
        case "wrongEvidence":
          return { ...p, approvalEvidenceReference: f.uuid("80") };
        case "wrongApprover":
          return { ...p, approvedByReference: f.uuid("80") };
        case "wrongOperator":
          return {
            ...p,
            operator: createIdentityActor({ ...p.operator, actorReference: f.uuid("80") }),
          };
        case "ActiveBrand":
          return { ...p, brand: createBrand({ ...p.brand, lifecycle: "Active" }) };
        case "oldBrand":
          return { ...p, brand: createBrand({ ...p.brand, createdAt: f.FROM, updatedAt: f.FROM }) };
        case "brandVersion":
          return { ...p, brand: createBrand({ ...p.brand, version: 2 }) };
        case "foreignBrand":
          return { ...p, brand: createBrand({ ...p.brand, brandReference: f.OTHER_BRAND }) };
        case "oldMember":
          return { ...p, recipients: [{ ...member, membership: f.membership }] };
        case "wrongMember":
          return {
            ...p,
            recipients: [
              {
                ...member,
                membership: createInitialBrandMembership(
                  { ...member.membership, membershipReference: f.uuid("80") },
                  member.account,
                  f.AT,
                ),
              },
            ],
          };
        case "foreignMember":
          return {
            ...p,
            recipients: [
              {
                ...member,
                membership: createInitialBrandMembership(
                  { ...member.membership, brandReference: f.OTHER_BRAND },
                  member.account,
                  f.AT,
                ),
              },
            ],
          };
        case "suspendedMember":
          return {
            ...p,
            recipients: [
              {
                ...member,
                membership: Object.freeze({
                  ...member.membership,
                  lifecycle: "Suspended" as const,
                }),
              },
            ],
          };
        case "targetPlatform":
          return {
            ...p,
            recipients: [
              {
                ...member,
                account: parseCurrentWorkforceAccount({
                  ...member.account,
                  accountKind: "Platform",
                }),
              },
            ],
          };
        default:
          return {
            ...p,
            recipients: [
              {
                ...member,
                account: parseCurrentWorkforceAccount({
                  ...member.account,
                  observedAt: f.LATER,
                  validUntil: new Date(Date.parse(f.LATER) + 5000).toISOString(),
                }),
              },
            ],
          };
      }
    };
    await expect(x.commit()).rejects.toMatchObject({ code: "BRAND_INITIAL_POLICY_UNAVAILABLE" });
    expect(x.calls.some((call) => call.sql.startsWith("INSERT"))).toBe(false);
  });
  it.each([
    "disabled",
    "wrongProfile",
    "wrongActor",
    "authClaim",
    "pastObservation",
    "futureObservation",
    "expired",
    "unbounded",
  ])("refuses actual target account %s before policy writes", async (kind) => {
    const x = fixture();
    x.control.hold = (p) => ({
      ...p,
      recipients: p.recipients.map((r) => {
        const patch =
          kind === "disabled"
            ? { status: "Disabled" }
            : kind === "wrongProfile"
              ? { profile: "IdentityActorV1" }
              : kind === "wrongActor"
                ? { actorReference: f.uuid("80") }
                : kind === "authClaim"
                  ? { authenticatedAt: f.AT }
                  : kind === "pastObservation"
                    ? {
                        observedAt: new Date(Date.parse(f.AT) - 1).toISOString(),
                        validUntil: new Date(Date.parse(f.AT) + 4999).toISOString(),
                      }
                    : kind === "futureObservation"
                      ? { observedAt: new Date(Date.parse(f.AT) + 1).toISOString() }
                      : kind === "expired"
                        ? {
                            observedAt: new Date(Date.parse(f.AT) - 1).toISOString(),
                            validUntil: f.AT,
                          }
                        : { validUntil: new Date(Date.parse(f.AT) + 5001).toISOString() };
        // Malformed dependent response deliberately bypasses its constructor;
        // the consumer must parse it rather than trusting the TypeScript port.
        return Object.defineProperty({ ...r }, "account", { value: { ...r.account, ...patch } });
      }),
    });
    await expect(x.commit()).rejects.toThrow();
    expect(x.calls.some((call) => call.sql.startsWith("INSERT"))).toBe(false);
  });
  it("allows advancing account observations while retaining its immutable identity and original lease", async () => {
    const x = fixture();
    x.control.beforeGuards = async () => {
      x.control.time = new Date(Date.parse(f.AT) + 250).toISOString();
      x.control.hold = (p) => ({
        ...p,
        recipients: p.recipients.map((r) => ({
          ...r,
          account: parseCurrentWorkforceAccount({
            ...r.account,
            observedAt: x.control.time,
            validUntil: new Date(Date.parse(f.AT) + 1000).toISOString(),
          }),
        })),
      });
    };
    await x.commit();
    x.store.assertFinalized();
  });
  it.each(["initial", "withdrawn", "finalExpiry"])(
    "holds target account validity through %s",
    async (kind) => {
      const x = fixture(),
        until = new Date(Date.parse(f.AT) + 1000).toISOString();
      x.control.hold = (p) => ({
        ...p,
        recipients: p.recipients.map((r) => ({
          ...r,
          account: parseCurrentWorkforceAccount({ ...r.account, validUntil: until }),
        })),
      });
      if (kind === "withdrawn")
        x.control.beforeGuards = async () => {
          x.control.hold = (p) => ({
            ...p,
            recipients: p.recipients.map((r) =>
              Object.defineProperty({ ...r }, "account", {
                value: { ...r.account, status: "Disabled" },
              }),
            ),
          });
        };
      if (kind === "finalExpiry")
        x.control.beforeFinal = () => {
          x.control.time = until;
        };
      if (kind === "initial") {
        const result = await x.commit();
        expect(result.validUntil).toBe(until);
        expect(result.recipients[0]?.role.effectiveUntil).toBe(f.UNTIL);
        x.store.assertFinalized();
      } else {
        await expect(x.commit()).rejects.toThrow();
        expect(Object.values(x.tables).every((group) => group.length === 0)).toBe(true);
        expect(x.audit).toEqual([]);
        expect(() => x.store.assertFinalized()).toThrow();
      }
    },
  );
  it.each(["missing", "wrongAction", "retired", "future", "precision", "duplicate"])(
    "rejects %s owning permission definitions",
    async (kind) => {
      const x = fixture(),
        definition = x.definitions[0];
      if (!definition) throw new Error("Missing controlled definition");
      if (kind === "missing") x.definitions.pop();
      if (kind === "wrongAction") definition.action = "catalog.manage";
      if (kind === "retired") definition.lifecycle = "Retired";
      if (kind === "future") definition.updatedAt = f.LATER;
      if (kind === "precision") definition.precise = false;
      if (kind === "duplicate") x.definitions.push({ ...definition });
      await expect(x.commit()).rejects.toThrow();
      expect(x.tables.state).toEqual([]);
    },
  );
  it.each([
    "permission",
    "membership",
    "approval",
    "policy",
    "clock",
    "reverseClock",
    "audit",
    "finalClock",
  ])("rolls back tentative rows on late %s failure", async (kind) => {
    const x = fixture();
    if (kind === "audit") x.control.auditFailure = true;
    if (kind === "finalClock")
      x.control.beforeFinal = () => {
        x.control.time = x.options.originalValidUntil;
      };
    x.control.beforeGuards = async () => {
      if (kind === "permission") required(x.definitions[0]).lifecycle = "Retired";
      if (kind === "membership")
        x.control.hold = (p) => ({
          ...p,
          recipients: p.recipients.map((r) => ({
            ...r,
            membership: Object.defineProperty({ ...r.membership }, "version", { value: 2 }),
          })),
        });
      if (kind === "approval") x.control.approvalValid = false;
      if (kind === "policy") required(x.tables.grants[0]).lifecycle = "Revoked";
      if (kind === "clock") x.control.time = x.options.originalValidUntil;
      if (kind === "reverseClock") x.control.time = f.FROM;
    };
    await expect(x.commit()).rejects.toThrow();
    expect(Object.values(x.tables).every((group) => group.length === 0)).toBe(true);
    expect(x.audit).toEqual([]);
    expect(() => x.store.assertFinalized()).toThrow();
  });
  it("bounds the original lease to actual business expiry and never treats it as a grant period", async () => {
    const x = fixture(),
      until = new Date(Date.parse(f.AT) + 1000).toISOString();
    x.control.hold = (p) => ({ ...p, validUntil: until });
    const result = await x.commit();
    expect(result.validUntil).toBe(until);
    expect(result.recipients[0]?.role.effectiveUntil).toBe(f.UNTIL);
    expect(result.recipients[0]?.role.createdAt).toBe(f.AT);
  });
  it.each([
    "insertReceipt",
    "rowsGetter",
    "sparse",
    "extra",
    "isolation",
    "queryReplacement",
    "authorityReplacement",
    "registration",
  ])("poisons %s source failure", async (kind) => {
    const x = fixture();
    let getterCalled = false;
    if (kind === "isolation") x.control.isolation = "repeatable read";
    if (kind === "registration")
      Object.assign(x.options, {
        registerBeforeCommit: async () => {
          throw new Error("Controlled registration failure");
        },
      });
    if (kind === "authorityReplacement")
      x.control.beforeGuards = async () => {
        x.options.authority.hold = async (...args) => {
          void args;
          throw new Error("Replaced authority");
        };
      };
    if (kind === "queryReplacement")
      x.control.beforeQuery = async (sql) => {
        if (sql.includes("FROM bop_permission.permission_definition"))
          x.tx.query = async () => ({ rows: [] });
      };
    x.control.response = (sql, result) => {
      if (kind === "insertReceipt" && sql.startsWith("INSERT INTO bop_permission.role("))
        return { rows: [{ reference: f.uuid("80") }] };
      if (!sql.includes("FROM bop_permission.permission_definition")) return result;
      if (kind === "rowsGetter")
        return Object.defineProperty({}, "rows", {
          get() {
            getterCalled = true;
            return x.definitions;
          },
        });
      if (kind === "sparse") return { rows: new Array(2) };
      if (kind === "extra") return { rows: x.definitions.map((r) => ({ ...r, allow: true })) };
      return result;
    };
    await expect(x.commit()).rejects.toThrow();
    expect(getterCalled).toBe(false);
    await expect(x.store.initialize(x.command)).rejects.toThrow();
  });
  it("caught reentry after a SQL await still prevents commit", async () => {
    const x = fixture();
    let attempted = false;
    x.control.beforeQuery = async (sql) => {
      if (!attempted && sql.includes("FROM bop_permission.permission_definition")) {
        attempted = true;
        await expect(x.store.initialize(x.command)).rejects.toThrow();
      }
    };
    await expect(x.commit()).rejects.toThrow();
    expect(attempted).toBe(true);
    expect(x.audit).toEqual([]);
  });
  it("never implicitly runs its own commit callbacks or permits another initialize", async () => {
    const x = fixture();
    await x.store.initialize(x.command);
    expect(x.guards).toHaveLength(1);
    expect(x.finals).toHaveLength(1);
    expect(() => x.store.assertFinalized()).toThrow();
    await expect(x.guards[0]?.()).rejects.toThrow();
    await expect(x.store.initialize(x.command)).rejects.toThrow();
  });
  it.each(["wrongOccurredAt", "invalidAction", "extraScope", "expiredClock"])(
    "registers refusal before %s preflight so an outer host cannot commit earlier owner writes",
    async (kind) => {
      const x = fixture();
      const command =
        kind === "wrongOccurredAt"
          ? { ...x.command, occurredAt: f.FROM }
          : kind === "extraScope"
            ? { ...x.command, storeReference: null }
            : kind === "invalidAction"
              ? {
                  ...x.command,
                  recipients: x.command.recipients.map((r) => ({
                    ...r,
                    grants: r.grants.map((g) => ({ ...g, action: "identity.role.change" })),
                  })),
                }
              : x.command;
      if (kind === "expiredClock") x.control.time = x.options.originalValidUntil;
      // Simulates caller catching this failure after Tenant/Membership wrote.
      await expect(x.store.initialize(command)).rejects.toThrow();
      expect(x.guards).toHaveLength(1);
      expect(x.finals).toHaveLength(1);
      const guard = x.guards[0];
      if (!guard) throw new Error("Missing refusal guard");
      await expect(guard()).rejects.toThrow();
      expect(x.calls).toEqual([]);
    },
  );
});
