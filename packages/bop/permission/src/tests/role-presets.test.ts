import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createRoleAdministrationVersion,
  executeRoleAdministration,
  planRoleAdministrationChange,
  RoleAdministrationContractError,
  storeRoleTemplateActions,
  type RoleAdministrationOperation,
  type RoleAdministrationPorts,
  type RoleAdministrationVersionRecord,
  type RolePermissionSelection,
} from "../index.js";

/** WP-2423 role presets (Owner request 2026-11-06): edit, restore, remove and approve alone. */
const id = (n: number) => "018f0000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-11-06T15:00:00.000Z";
const [brand, store, ana, mia] = [2, 3, 4, 5].map(id) as [string, string, string, string];
let sequence = 0x1000;
const next = () => id(++sequence);
const selections = (actions: readonly string[]): RolePermissionSelection[] =>
  actions.map((action, n) => ({
    permissionReference: id(0x500 + n),
    action,
    groupCode: "ordering",
    highRisk: false,
    dependencyActions: [],
  })) as never;
const foh = storeRoleTemplateActions("front-of-house");
function version(overrides: Record<string, unknown> = {}): RoleAdministrationVersionRecord {
  return createRoleAdministrationVersion({
    administrationReference: id(11),
    roleReference: id(12),
    version: 3,
    brandReference: brand,
    storeReference: store,
    code: "front_of_house",
    displayName: "Front of House",
    description: "Orders, tables and payments",
    roleType: "System",
    lifecycle: "Active",
    sourcePolicyVersion: 7,
    selections: selections(foh),
    authoredByReference: id(20),
    submittedByReference: id(20),
    approvedByReference: id(21),
    decisionEvidenceReference: id(22),
    reasonCode: "STORE_ROLES_PROVISIONED",
    changedAt: at,
    approvalMode: "Independent",
    ...overrides,
  });
}
function context(actor: string) {
  const brandFact = createBrand({
    brandReference: brand,
    code: "SYNTH",
    displayName: "Synthetic",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  return createTenantContext(
    {
      actorType: "User",
      accountKind: "Workforce",
      actorReference: actor,
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    brandFact,
    createStore({
      storeReference: store,
      brandReference: brand,
      code: "SYNTH_STORE",
      displayName: "Synthetic Store",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    at,
  );
}
async function run(
  operation: RoleAdministrationOperation,
  current: RoleAdministrationVersionRecord | null,
  options: {
    readonly actor?: string;
    readonly effective?: RoleAdministrationVersionRecord | null;
    readonly actions?: readonly string[];
    readonly members?: number;
    readonly waiting?: number;
    readonly soleOperator?: RoleAdministrationPorts["soleOperator"];
  } = {},
) {
  const actor = options.actor ?? ana;
  const commits: Parameters<RoleAdministrationPorts["unitOfWork"]["commit"]>[0][] = [];
  const planned = planRoleAdministrationChange({
    operation,
    current,
    effective: options.effective ?? null,
    scope: { brandReference: brand, storeReference: store },
    actorReference: actor,
    policyVersion: 7,
    changedAt: at,
    reasonCode: "ROLE_ADMIN_CHANGE",
    nextReference: next,
    draft:
      options.actions === undefined
        ? null
        : {
            ...(operation === "Create" ? { code: "custom_0123456789ab" } : {}),
            displayName: "Front of House",
            description: "Orders, tables and payments",
            selections: selections(options.actions),
          },
  });
  const result = await executeRoleAdministration(
    {
      tenantContext: context(actor),
      operation,
      expectedVersion: current === null ? null : current.version,
      idempotencyKey: "wp2423.role-presets." + operation.toLowerCase(),
      current,
      effective: options.effective ?? null,
      next: planned,
      auditId: next() as never,
      correlationId: next() as never,
      sourceChannel: "MERCHANT_WEB",
    },
    {
      authorization: {
        authorize: async (request) =>
          Object.freeze({
            effect: "Allow",
            action: request.action,
            scopeKind: "Store",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
          }) as never,
      },
      impact: {
        countActiveAssignments: async () => options.members ?? 0,
        countOpenAssignmentChanges: async () => options.waiting ?? 0,
      },
      policy: { currentVersion: async () => 7 },
      ...(options.soleOperator === undefined ? {} : { soleOperator: options.soleOperator }),
      unitOfWork: { commit: async (input) => void commits.push(input) },
    },
  );
  return { result, commits };
}

describe("WP-2423 role presets", () => {
  it("edits a preset as a draft of the same role, which staff do not hold until turned on", async () => {
    const { result } = await run("Revise", version(), {
      effective: version(),
      actions: [...foh, "ordering.order.comp"].sort(),
    });
    expect(result).toMatchObject({
      roleReference: id(12),
      version: 4,
      lifecycle: "Draft",
      roleType: "Custom",
      submittedByReference: null,
      approvedByReference: null,
    });
  });
  it("never edits, removes or restores the Owner preset, and never edits while a change waits", async () => {
    const owner = version({ code: "store_owner", displayName: "Owner" });
    await expect(run("Revise", owner, { effective: owner, actions: foh })).rejects.toMatchObject({
      code: "ROLE_ADMIN_MUTATION_INVALID",
    });
    await expect(run("Deactivate", owner, { effective: owner })).rejects.toMatchObject({
      code: "ROLE_ADMIN_MUTATION_INVALID",
    });
    const draft = version({
      version: 4,
      roleType: "Custom",
      lifecycle: "Draft",
      submittedByReference: null,
      approvedByReference: null,
      decisionEvidenceReference: null,
    });
    await expect(
      run("Revise", draft, { effective: version(), actions: foh }),
    ).rejects.toMatchObject({ code: "ROLE_ADMIN_MUTATION_INVALID" });
  });
  it("refuses to remove a role someone holds or a waiting staff role request would give", async () => {
    await expect(run("Deactivate", version(), { members: 1 })).rejects.toMatchObject({
      code: "ROLE_ADMIN_ROLE_IN_USE",
    });
    await expect(run("Deactivate", version(), { waiting: 1 })).rejects.toMatchObject({
      code: "ROLE_ADMIN_ROLE_IN_USE",
    });
    const { result } = await run("Deactivate", version());
    expect(result).toMatchObject({ lifecycle: "Deactivated", roleType: "System" });
  });
  it("withdraws a waiting change only for its author, and then removes from what staff hold", async () => {
    const draft = version({
      version: 4,
      roleType: "Custom",
      lifecycle: "Draft",
      authoredByReference: ana,
      submittedByReference: null,
      approvedByReference: null,
      decisionEvidenceReference: null,
      selections: selections([...foh, "ordering.order.comp"].sort()),
    });
    await expect(
      run("Withdraw", draft, { actor: mia, effective: version() }),
    ).rejects.toMatchObject({ code: "ROLE_ADMIN_MUTATION_INVALID" });
    const withdrawn = (await run("Withdraw", draft, { effective: version() })).result;
    expect(withdrawn).toMatchObject({ lifecycle: "Withdrawn", version: 5 });
    const removed = (await run("Deactivate", withdrawn, { effective: version() })).result;
    expect(removed).toMatchObject({ lifecycle: "Deactivated", roleType: "System", version: 6 });
    expect(removed.selections.map((item) => item.action)).toEqual([...foh].sort());
  });
  it("approves alone only as sole operator, and the contract keeps the two apart", async () => {
    const review = version({
      version: 5,
      roleType: "Custom",
      lifecycle: "InReview",
      authoredByReference: ana,
      submittedByReference: ana,
      approvedByReference: null,
      decisionEvidenceReference: null,
    });
    await expect(run("ApproveAlone", review, { effective: version() })).rejects.toMatchObject({
      code: "ROLE_ADMIN_PERMISSION_DENIED",
    });
    await expect(
      run("ApproveAlone", review, {
        actor: mia,
        effective: version(),
        soleOperator: { confirm: async () => ({ actorMfaAt: at }) },
      }),
    ).rejects.toThrow(RoleAdministrationContractError);
    await expect(run("Approve", review, { effective: version() })).rejects.toThrow(
      RoleAdministrationContractError,
    );
    const { result, commits } = await run("ApproveAlone", review, {
      effective: version(),
      soleOperator: { confirm: async () => ({ actorMfaAt: at }) },
    });
    expect(result).toMatchObject({
      lifecycle: "Approved",
      approvedByReference: ana,
      submittedByReference: ana,
      approvalMode: "SoleOperator",
    });
    expect(commits[0]?.soleOperator).not.toBeNull();
    expect(() => version({ submittedByReference: ana, approvedByReference: ana })).toThrow(
      RoleAdministrationContractError,
    );
    expect(() => version({ approvalMode: "SoleOperator" })).toThrow(
      RoleAdministrationContractError,
    );
  });
  it("turns an approved version equal to the preset back into the preset, any other stays the Store's", async () => {
    const approved = (actions: readonly string[]) =>
      version({
        version: 7,
        roleType: "Custom",
        lifecycle: "Approved",
        submittedByReference: ana,
        approvedByReference: mia,
        selections: selections(actions),
      });
    expect((await run("Activate", approved(foh))).result.roleType).toBe("System");
    const own = [...foh, "ordering.order.comp"].sort();
    expect((await run("Activate", approved(own))).result.roleType).toBe("Custom");
  });
  it("restores only a Store's own version, and only to the preset's exact content", async () => {
    await expect(
      run("RestoreDefault", version(), { effective: version(), actions: foh }),
    ).rejects.toMatchObject({ code: "ROLE_ADMIN_MUTATION_INVALID" });
    const mine = version({
      roleType: "Custom",
      selections: selections([...foh, "ordering.order.comp"].sort()),
    });
    await expect(
      run("RestoreDefault", mine, { effective: mine, actions: foh.slice(1) }),
    ).rejects.toMatchObject({ code: "ROLE_ADMIN_MUTATION_INVALID" });
    const { result } = await run("RestoreDefault", mine, { effective: mine, actions: foh });
    expect(result).toMatchObject({ lifecycle: "Draft", roleType: "Custom", version: 4 });
  });
  it("creates a blank role as a draft of a new role", async () => {
    const { result } = await run("Create", null, { actions: ["merchant.access"] });
    expect(result).toMatchObject({ version: 1, lifecycle: "Draft", code: "custom_0123456789ab" });
  });
});
