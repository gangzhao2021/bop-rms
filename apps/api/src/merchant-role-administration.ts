import {
  createPostgresRoleAdministrationPorts,
  planRoleAdministrationChange,
  executeRoleAdministration,
  listRoleAdministration,
  loadRoleAdministration,
  buildRolePermissionSelections,
  RoleAdministrationContractError,
  RoleAdministrationServiceError,
  RoleAdministrationStoreError,
  storePermissionCatalog,
  storePermissionCodes,
  type RoleAdministrationRoleView,
  type RoleAdministrationTransaction,
  type RoleAdministrationVersionRecord,
} from "@bop/permission";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423: Section 88 IAM-ROLE-LIST / IAM-ROLE-EDITOR for the selected Store. Reads need
 * identity.role.read; each command is authorized by the domain service for its exact action.
 * System template roles are read-only except duplicate, deactivate and reactivate.
 */
export const roleAdministrationOperations = [
  "Duplicate",
  "SaveDraft",
  "Submit",
  "Approve",
  "Reject",
  "Activate",
  "Deactivate",
] as const;
type Operation = (typeof roleAdministrationOperations)[number];
const operationAction: Record<Operation, string> = {
  Duplicate: "identity.role.create",
  SaveDraft: "identity.role.change",
  Submit: "identity.role.change",
  Approve: "identity.role.approve",
  Reject: "identity.role.approve",
  Activate: "identity.role.activate",
  Deactivate: "identity.role.deactivate",
};
const lifecycleOperations: Record<string, readonly Operation[]> = {
  Draft: ["SaveDraft", "Submit"],
  InReview: ["Approve", "Reject"],
  Approved: ["Activate"],
  Active: ["Deactivate"],
  Deactivated: ["Activate"],
  Rejected: [],
};
export class MerchantRoleAdministrationError extends Error {
  constructor(
    readonly code:
      "PermissionDenied" | "NotFound" | "Conflict" | "InUse" | "Invalid" | "Unavailable",
  ) {
    super(code);
    this.name = "MerchantRoleAdministrationError";
  }
}
const fail = (code: MerchantRoleAdministrationError["code"]): never => {
  throw new MerchantRoleAdministrationError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
const catalog = new Map(storePermissionCatalog().map((entry) => [entry.code, entry]));

export interface RoleCommandInput {
  readonly operation: Operation;
  readonly roleReference: string;
  readonly expectedVersion: number;
  readonly operationReference: string;
  readonly reasonCode: string;
  readonly draft: {
    readonly code?: string;
    readonly displayName: string;
    readonly description: string;
    readonly actions: readonly string[];
  } | null;
}
export function parseRoleCommandInput(value: unknown): RoleCommandInput {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !==
      "draft,expectedVersion,operation,operationReference,reasonCode,roleReference"
  )
    return fail("Invalid");
  const operation = roleAdministrationOperations.find((item) => item === r.operation);
  if (
    !operation ||
    typeof r.roleReference !== "string" ||
    !uuid.test(r.roleReference) ||
    typeof r.operationReference !== "string" ||
    !uuid.test(r.operationReference) ||
    !Number.isSafeInteger(r.expectedVersion) ||
    (r.expectedVersion as number) < 1 ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(r.reasonCode)
  )
    return fail("Invalid");
  const needsDraft = operation === "Duplicate" || operation === "SaveDraft";
  if ((r.draft === null) === needsDraft) return fail("Invalid");
  let draft: RoleCommandInput["draft"] = null;
  if (r.draft !== null) {
    const d = r.draft as Record<string, unknown>;
    const keys = Object.keys(d ?? {})
      .sort()
      .join(",");
    if (
      typeof d !== "object" ||
      Array.isArray(d) ||
      keys !==
        (operation === "Duplicate"
          ? "actions,code,description,displayName"
          : "actions,description,displayName") ||
      typeof d.displayName !== "string" ||
      !safe.test(d.displayName) ||
      typeof d.description !== "string" ||
      !safe.test(d.description) ||
      !Array.isArray(d.actions) ||
      d.actions.length > 512 ||
      d.actions.some((action) => typeof action !== "string" || !storePermissionCodes.has(action)) ||
      new Set(d.actions).size !== d.actions.length ||
      (operation === "Duplicate" &&
        (typeof d.code !== "string" || !/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/u.test(d.code)))
    )
      return fail("Invalid");
    draft = {
      ...(operation === "Duplicate" ? { code: d.code as string } : {}),
      displayName: d.displayName,
      description: d.description,
      actions: d.actions as string[],
    };
  }
  return {
    operation,
    roleReference: r.roleReference,
    expectedVersion: r.expectedVersion as number,
    operationReference: r.operationReference,
    reasonCode: r.reasonCode,
    draft,
  };
}

export function createMerchantRoleAdministration(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const asRoleTx = (tx: Tx) => tx as unknown as RoleAdministrationTransaction;

  type Scope = Awaited<ReturnType<typeof resolveScope>>;
  type Decision = Awaited<ReturnType<Scope["authorizeAction"]>>;
  const denied = () => fail("PermissionDenied");
  const roleActions = [...new Set(Object.values(operationAction))];
  /**
   * WP-2423: one authorized run. The caller's `identity.role.read` and the further `actions` are
   * decided in full once at the start (one permission packet) and re-checked in full once more
   * before the reply or commit, inside the transaction, so nothing a refused command wrote commits.
   */
  function authorizedRun<T>(
    tx: Tx,
    sessionCookie: unknown,
    expectedSession: string,
    actions: readonly string[],
    recheckActions: readonly string[],
    work: (
      scope: Scope,
      decisions: ReadonlyMap<string, Decision>,
      guard: (transaction?: unknown) => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    return withMerchantTransactionAuthorization(
      {
        transaction: tx,
        resolve: async () => {
          const scope = await resolveScope(
            tx,
            sessionCookie,
            "identity.role.read",
            expectedSession,
          );
          const decisions = await scope.authorizeActions(["identity.role.read", ...actions]);
          if (decisions.get("identity.role.read")?.effect !== "Allow") return denied();
          return { scope, decisions };
        },
        recheck: async ({ scope }) => {
          if (recheckActions.length === 0) return (await scope.allowed()) === true;
          const decisions = await scope.authorizeActions(["identity.role.read", ...recheckActions]);
          return ["identity.role.read", ...recheckActions].every(
            (action) => decisions.get(action)?.effect === "Allow",
          );
        },
        denied,
      },
      (authority) => work(authority.scope.scope, authority.scope.decisions, authority.guard),
    );
  }
  async function view(
    scope: Scope,
    decisions: ReadonlyMap<string, Decision>,
    roles: readonly RoleAdministrationRoleView[],
    screenId: "IAM-ROLE-LIST" | "IAM-ROLE-EDITOR",
  ) {
    const allowed = new Map<string, boolean>();
    for (const action of roleActions)
      allowed.set(action, decisions.get(action)?.effect === "Allow");
    const label = (actor: string | null) =>
      actor === null
        ? null
        : actor === String(scope.actorReference)
          ? "You"
          : "Staff " + actor.slice(-4);
    return {
      screenId,
      sourceAsOf: options.persistence.now(),
      freshness: "Fresh" as const,
      completeness: "Complete" as const,
      mayManage: allowed.get("identity.role.create") === true,
      roles: roles.map(({ record, memberCount, decisions }) => {
        const operations = [
          ...(lifecycleOperations[record.lifecycle] ?? []),
          ...(record.storeReference !== null ? (["Duplicate"] as const) : []),
        ].filter(
          (operation) =>
            record.storeReference !== null &&
            allowed.get(operationAction[operation]) === true &&
            (record.roleType === "Custom" ||
              ["Duplicate", "Activate", "Deactivate"].includes(operation)) &&
            // Independent approval: the submitter never approves their own change.
            !(
              (operation === "Approve" || operation === "Reject") &&
              String(record.submittedByReference) === String(scope.actorReference)
            ) &&
            !(operation === "Deactivate" && memberCount > 0),
        );
        return {
          roleReference: record.roleReference,
          code: record.code,
          name: record.displayName,
          description: record.description,
          scope: record.storeReference === null ? "Brand" : "Store",
          status: record.lifecycle,
          type: record.roleType,
          version: record.version,
          memberCount,
          permissions: record.selections
            .filter((item) => catalog.has(item.action))
            .map((item) => ({
              action: item.action,
              group: item.groupCode,
              highRisk: item.highRisk,
              dependencies: [...item.dependencyActions],
            })),
          submittedBy: label(record.submittedByReference),
          approvedBy: label(record.approvedByReference),
          history: decisions.map(
            (item) =>
              `${item.decision} · version ${item.version} · ${label(item.actorReference)} · ${item.occurredAt}`,
          ),
          operations,
        };
      }),
      catalog:
        screenId === "IAM-ROLE-EDITOR"
          ? storePermissionCatalog().map((entry) => ({
              action: entry.code,
              group: entry.module,
              description: entry.description,
              highRisk: entry.risk === "High",
            }))
          : [],
    };
  }

  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  const list = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current.sessionReference,
          roleActions,
          [],
          async (scope, decisions) => {
            const roles = await listRoleAdministration(
              asRoleTx(tx),
              {
                brandReference: scope.context.brand.brandReference,
                storeReference: scope.store.storeReference,
              },
              options.persistence.now(),
            );
            return view(scope, decisions, roles, "IAM-ROLE-LIST");
          },
        ),
      ),
    );
  };
  const detail = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    roleReference: string;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current.sessionReference,
          roleActions,
          [],
          async (scope, decisions) => {
            try {
              const role = await loadRoleAdministration(
                asRoleTx(tx),
                {
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                },
                input.roleReference,
                options.persistence.now(),
              );
              return view(scope, decisions, [role], "IAM-ROLE-EDITOR");
            } catch (error) {
              if (error instanceof RoleAdministrationStoreError) return fail("NotFound");
              throw error;
            }
          },
        ),
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const command = parseRoleCommandInput(input.body);
    const action = operationAction[command.operation];
    const current0 = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current0.sessionReference,
          [action],
          [action],
          async (scope, decisions, guard) => {
            const ownerScope = {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.store.storeReference,
            };
            let current: RoleAdministrationVersionRecord;
            try {
              current = (
                await loadRoleAdministration(
                  asRoleTx(tx),
                  ownerScope,
                  command.roleReference,
                  options.persistence.now(),
                )
              ).record;
            } catch (error) {
              if (error instanceof RoleAdministrationStoreError) return fail("NotFound");
              throw error;
            }
            if (current.storeReference === null) fail("PermissionDenied");
            if (current.version !== command.expectedVersion) fail("Conflict");
            const ports = createPostgresRoleAdministrationPorts({
              transaction: asRoleTx(tx),
              scope: ownerScope,
              operation: command.operation,
              operationReference: command.operationReference,
              actorReference: scope.actorReference,
              authorization: {
                // The decision taken at the start of this run (no query); the run re-checks it in
                // full before the commit.
                authorize: async (request) => {
                  if (!(await guard(tx)) || String(request.action) !== action)
                    return fail("PermissionDenied");
                  return decisions.get(action) ?? fail("PermissionDenied");
                },
              },
              clock: { now: () => options.persistence.now() },
              nextReference: () => options.references.next(),
            });
            const policyVersion = await ports.policy.currentVersion(current.brandReference);
            const now = options.persistence.now();
            const selections = (actions: readonly string[]) =>
              buildRolePermissionSelections(asRoleTx(tx), actions).catch(() => fail("Conflict"));
            let next: RoleAdministrationVersionRecord;
            try {
              next = planRoleAdministrationChange({
                operation: command.operation,
                current,
                actorReference: scope.actorReference,
                policyVersion,
                changedAt: now,
                reasonCode: command.reasonCode,
                nextReference: () => options.references.next(),
                draft:
                  command.draft === null
                    ? null
                    : {
                        ...(command.draft.code === undefined ? {} : { code: command.draft.code }),
                        displayName: command.draft.displayName,
                        description: command.draft.description,
                        selections: await selections(command.draft.actions),
                      },
              });
            } catch {
              return fail("Invalid");
            }
            try {
              const result = await executeRoleAdministration(
                {
                  tenantContext: scope.context,
                  operation: command.operation,
                  expectedVersion: command.expectedVersion as never,
                  idempotencyKey: command.operationReference,
                  current,
                  next,
                  auditId: options.references.next() as never,
                  correlationId: command.operationReference as never,
                  sourceChannel: "MERCHANT_WEB",
                },
                ports,
              );
              return {
                roleReference: result.roleReference,
                version: result.version,
                status: result.lifecycle,
              };
            } catch (error) {
              if (error instanceof RoleAdministrationServiceError)
                return fail(
                  error.code === "ROLE_ADMIN_PERMISSION_DENIED"
                    ? "PermissionDenied"
                    : error.code === "ROLE_ADMIN_ROLE_IN_USE"
                      ? "InUse"
                      : error.code === "ROLE_ADMIN_MUTATION_INVALID"
                        ? "Invalid"
                        : "Conflict",
                );
              if (error instanceof RoleAdministrationContractError) return fail("Invalid");
              throw error;
            }
          },
        ),
      ),
    );
  };
  return { list, detail, command };
}
