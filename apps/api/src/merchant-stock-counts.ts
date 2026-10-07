import { listStoreMembers, type MemberDirectoryTransaction } from "@bop/membership";
import {
  createPostgresStockCountPorts,
  executeStockCountCommand,
  listStockCounts,
  loadStockCount,
  openStockCountAt,
  StockCountError,
  StockCountStaleError,
  stockLotLabels,
  type LedgerTransaction,
  type StockCountAction,
  type StockCountAggregate,
} from "@rms/inventory";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { merchantStockCatalog } from "./merchant-stock-catalog.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-INV-STOCK-COUNT: INV-COUNT-LIST / INV-COUNT-WORKBENCH for the selected Store over the
 * Stock Count service. Reading needs inventory.count.read; starting a count for a Storage Location needs
 * inventory.count.manage; counting (blind), refreshing moved lines and submitting need
 * inventory.count.execute and are done by the assignee; explaining variances, approving and posting
 * or sending back need inventory.count.approve and are never done by the submitter.
 */
export class MerchantStockCountError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "AlreadyOpen"
      | "StockChanged"
      | "Incomplete"
      | "NotIndependent"
      | "State"
      | "LineInvalid"
      | "Invalid",
    readonly lineReferences: readonly string[] = [],
  ) {
    super(code);
    this.name = "MerchantStockCountError";
  }
}
const fail = (code: MerchantStockCountError["code"], lines: readonly string[] = []): never => {
  throw new MerchantStockCountError(code, lines);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
const decimal = /^(?:0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/u;
export const stockCountVarianceReasons = [
  "PREVIOUS_COUNT_ERROR",
  "UNRECORDED_WASTE",
  "UNRECORDED_RECEIPT",
  "RECIPE_USAGE_DIFFERENCE",
  "DAMAGED_OR_SPOILED",
  "THEFT_OR_LOSS",
  "MISPLACED_STOCK",
  "UNEXPLAINED",
] as const;

export type StockCountCommandBody =
  | {
      readonly action: "Create";
      readonly operationReference: string;
      readonly locationReference: string;
      readonly countType: "Full" | "Cycle" | "Spot";
      readonly assigneeReference: string;
    }
  | {
      readonly action: "Start" | "Submit" | "Refresh";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
    }
  | {
      readonly action: "SaveLine";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
      readonly lineReference: string;
      readonly countedQuantity: string;
    }
  | {
      readonly action: "ExplainVariance";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
      readonly lineReference: string;
      readonly varianceReasonCode: string;
    }
  | {
      readonly action: "ApproveAndPost";
      readonly operationReference: string;
      readonly postOperationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
    }
  | {
      readonly action: "SendBack" | "Cancel";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
    };
export function parseStockCountCommandBody(value: unknown): StockCountCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  const base = () => ({
    operationReference: ref(r.operationReference),
    countReference: ref(r.countReference),
    expectedVersion: version(r.expectedVersion),
  });
  switch (r.action) {
    case "Create":
      if (
        keys !== "action,assigneeReference,countType,locationReference,operationReference" ||
        !["Full", "Cycle", "Spot"].includes(r.countType as string)
      )
        return fail("Invalid");
      return {
        action: "Create",
        operationReference: ref(r.operationReference),
        locationReference: ref(r.locationReference),
        countType: r.countType as "Full" | "Cycle" | "Spot",
        assigneeReference: ref(r.assigneeReference),
      };
    case "Start":
    case "Submit":
    case "Refresh":
    case "SendBack":
    case "Cancel":
      if (keys !== "action,countReference,expectedVersion,operationReference")
        return fail("Invalid");
      return { action: r.action, ...base() };
    case "SaveLine":
      if (
        keys !==
          "action,countReference,countedQuantity,expectedVersion,lineReference,operationReference" ||
        typeof r.countedQuantity !== "string" ||
        !decimal.test(r.countedQuantity)
      )
        return fail("Invalid");
      return {
        action: "SaveLine",
        ...base(),
        lineReference: ref(r.lineReference),
        countedQuantity: r.countedQuantity,
      };
    case "ExplainVariance":
      if (
        keys !==
          "action,countReference,expectedVersion,lineReference,operationReference,varianceReasonCode" ||
        !(stockCountVarianceReasons as readonly unknown[]).includes(r.varianceReasonCode)
      )
        return fail("Invalid");
      return {
        action: "ExplainVariance",
        ...base(),
        lineReference: ref(r.lineReference),
        varianceReasonCode: r.varianceReasonCode as string,
      };
    case "ApproveAndPost":
      if (
        keys !== "action,countReference,expectedVersion,operationReference,postOperationReference"
      )
        return fail("Invalid");
      return {
        action: "ApproveAndPost",
        ...base(),
        postOperationReference: ref(r.postOperationReference),
      };
    default:
      return fail("Invalid");
  }
}

const serviceErrors: Record<StockCountError["code"], MerchantStockCountError["code"]> = {
  STOCK_COUNT_INVALID: "Invalid",
  STOCK_COUNT_PERMISSION_DENIED: "PermissionDenied",
  STOCK_COUNT_NOT_FOUND: "NotFound",
  STOCK_COUNT_CONFLICT: "Conflict",
  STOCK_COUNT_STATE_CONFLICT: "State",
  STOCK_COUNT_INCOMPLETE: "Incomplete",
  STOCK_COUNT_SEGREGATION_REQUIRED: "NotIndependent",
  STOCK_COUNT_IDEMPOTENCY_CONFLICT: "Conflict",
  STOCK_COUNT_DEPENDENCY_UNAVAILABLE: "Conflict",
};
const permissionOf: Record<StockCountAction, string> = {
  Create: "inventory.count.manage",
  Assign: "inventory.count.manage",
  Cancel: "inventory.count.manage",
  Start: "inventory.count.execute",
  SaveLine: "inventory.count.execute",
  Submit: "inventory.count.execute",
  Refresh: "inventory.count.execute",
  Approve: "inventory.count.approve",
  Reject: "inventory.count.approve",
  ExplainVariance: "inventory.count.approve",
  Post: "inventory.count.approve",
};

/**
 * Blind counting: expected quantities stay hidden from the counter until submission, whatever their
 * role; other approvers may see them meanwhile.
 */
export function redactStockCount(
  count: StockCountAggregate,
  mayViewExpected: boolean,
  viewer: string,
) {
  const submitted = ["Submitted", "Approved", "Posted"].includes(count.status);
  const reveal =
    submitted ||
    count.expectedQuantityVisibility === "Visible" ||
    (mayViewExpected && count.assigneeReference !== viewer);
  return {
    ...count,
    lines: count.lines.map((line) => ({
      ...line,
      expectedQuantity: reveal ? line.expectedQuantity : null,
      variance: reveal ? line.variance : null,
      balanceVersion: undefined,
    })),
  };
}

export function createMerchantStockCounts(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  locale: string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, "inventory.count.read", sessionReference);
    if (!(await scope.allowed())) fail("PermissionDenied");
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    return {
      owner: {
        tenantReference: String(scope.selected.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.store.storeReference),
      },
      actor: String(scope.actorReference),
      may,
    };
  }
  const ledger = (tx: Tx) => tx as unknown as LedgerTransaction;
  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    countReference: string | null;
    before: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const permissions = {
          mayCreate: await scope.may("inventory.count.manage"),
          mayCount: await scope.may("inventory.count.execute"),
          mayApprove: await scope.may("inventory.count.approve"),
        };
        const catalog = await merchantStockCatalog(tx, scope.owner, options.locale);
        const members = await listStoreMembers(
          tx as unknown as MemberDirectoryTransaction,
          scope.owner,
        );
        const staff = members
          .filter((member) => member.membershipLifecycle === "Active")
          .map((member) => ({
            actorReference: member.actorReference,
            label:
              member.actorReference === scope.actor
                ? "You"
                : (member.displayName ?? "Staff " + member.actorReference.slice(-4)),
          }));
        const base = {
          sourceAsOf: options.persistence.now(),
          viewer: scope.actor,
          permissions,
          varianceReasons: stockCountVarianceReasons,
          items: catalog.items,
          locations: catalog.locations,
          staff,
        };
        if (input.countReference !== null) {
          const count = await loadStockCount(ledger(tx), scope.owner, input.countReference);
          if (count === null) return fail("NotFound");
          const lots = await stockLotLabels(
            ledger(tx),
            scope.owner,
            count.lines.flatMap((line) => (line.lotReference ? [line.lotReference] : [])),
          );
          return {
            screenId: "INV-COUNT-WORKBENCH" as const,
            ...base,
            count: redactStockCount(count, permissions.mayApprove, scope.actor),
            lots: Object.fromEntries(lots),
          };
        }
        const page = await listStockCounts(ledger(tx), scope.owner, {
          before: input.before,
          limit: 30,
        });
        return { screenId: "INV-COUNT-LIST" as const, ...base, ...page };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseStockCountCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const at = options.persistence.now();
        const mayViewExpected = await scope.may("inventory.count.approve");
        const ports = createPostgresStockCountPorts(ledger(tx), scope.owner, {
          nextReference: () => options.references.next(),
          authorization: {
            authorize: async ({ action, permission }) =>
              permission === permissionOf[action as StockCountAction] &&
              (await scope.may(permissionOf[action as StockCountAction]))
                ? { authorized: true, mayViewExpected }
                : null,
          },
          audit: async ({ command, before, after }) => ({
            auditId: options.references.next(),
            brandId: scope.owner.brandReference,
            storeId: scope.owner.storeReference,
            actor: { type: "User", reference: command.actorReference },
            actionCode: "INVENTORY_COUNT_" + command.action.toUpperCase(),
            targetType: "StockCount",
            targetId: (after ?? before)?.countReference ?? command.operationReference,
            afterSummary: {
              status: after?.status ?? "Posted",
              version: (after ?? before)?.aggregateVersion ?? 0,
            },
            reasonCode: "STOCK_COUNT",
            correlationId: command.operationReference,
            occurredAt: command.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_STANDARD",
            retentionPolicyVersion: 1,
          }),
        });
        const run = (
          action: StockCountAction,
          operationReference: string,
          payload: Record<string, unknown>,
        ) =>
          executeStockCountCommand(
            {
              tenantReference: scope.owner.tenantReference,
              brandReference: scope.owner.brandReference,
              actorReference: scope.actor,
              purpose: "StockCountManagement",
              permission: action === "Post" ? "inventory.count.approve" : permissionOf[action],
              operationReference,
              occurredAt: at,
              action,
              payload,
            },
            ports,
          );
        try {
          switch (body.action) {
            case "Create": {
              // One open count per Storage Location.
              if (
                (await openStockCountAt(ledger(tx), scope.owner, body.locationReference)) !== null
              )
                return fail("AlreadyOpen");
              const created = await run("Create", body.operationReference, {
                stockScope: { scopeType: "Location", scopeReference: body.locationReference },
                countType: body.countType,
                expectedQuantityVisibility: "BlindUntilSubmit",
                movementControl: "SnapshotOnly",
                approvalPolicy: "Segregated",
                assigneeReference: body.assigneeReference,
                dueAt: null,
              });
              return { status: created.outcome, countReference: created.count.countReference };
            }
            case "SaveLine": {
              const count =
                (await loadStockCount(ledger(tx), scope.owner, body.countReference)) ??
                fail("NotFound");
              const line =
                count.lines.find((item) => item.lineReference === body.lineReference) ??
                fail("LineInvalid", [body.lineReference]);
              const item = (await merchantStockCatalog(tx, scope.owner, options.locale)).items.find(
                (candidate) => candidate.itemReference === line.itemReference,
              );
              const fraction = body.countedQuantity.split(".")[1] ?? "";
              if (item && fraction.length > item.ledgerPrecision)
                return fail("LineInvalid", [body.lineReference]);
              const saved = await run("SaveLine", body.operationReference, {
                countReference: body.countReference,
                expectedVersion: body.expectedVersion,
                lineReference: body.lineReference,
                countedQuantity: body.countedQuantity,
                unitCode: line.unitCode,
                varianceReasonCode: null,
              });
              return { status: saved.outcome, version: saved.count.aggregateVersion };
            }
            case "ExplainVariance": {
              const saved = await run("ExplainVariance", body.operationReference, {
                countReference: body.countReference,
                expectedVersion: body.expectedVersion,
                lineReference: body.lineReference,
                varianceReasonCode: body.varianceReasonCode,
              });
              return { status: saved.outcome, version: saved.count.aggregateVersion };
            }
            case "ApproveAndPost": {
              const approved = await run("Approve", body.operationReference, {
                countReference: body.countReference,
                expectedVersion: body.expectedVersion,
                reasonCode: "VARIANCE_APPROVED",
              });
              const posted = await run("Post", body.postOperationReference, {
                countReference: body.countReference,
                expectedVersion: approved.count.aggregateVersion,
              });
              return {
                status: posted.outcome,
                version: posted.count.aggregateVersion,
                movements: posted.movements.length,
              };
            }
            default: {
              const action: StockCountAction =
                body.action === "SendBack"
                  ? "Reject"
                  : body.action === "Cancel"
                    ? "Cancel"
                    : body.action;
              const saved = await run(action, body.operationReference, {
                countReference: body.countReference,
                expectedVersion: body.expectedVersion,
                ...(action === "Reject"
                  ? { reasonCode: "RECOUNT_REQUIRED" }
                  : action === "Cancel"
                    ? { reasonCode: "COUNT_CANCELLED" }
                    : {}),
              });
              return { status: saved.outcome, version: saved.count.aggregateVersion };
            }
          }
        } catch (error) {
          if (error instanceof StockCountStaleError)
            return fail("StockChanged", error.lineReferences);
          if (error instanceof StockCountError) return fail(serviceErrors[error.code]);
          throw error;
        }
      }),
    );
  };
  return { query, command };
}
