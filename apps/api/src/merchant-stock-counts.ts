import {
  listStoreMembers,
  memberDisplayNames,
  type MemberDirectoryTransaction,
} from "@bop/membership";
import {
  createPostgresStockCountPorts,
  executeStockCountCommand,
  listStockCounts,
  listStoreStockShortages,
  loadStockCount,
  openStockCountAt,
  StockCountError,
  StockCountStaleError,
  stockLotLabels,
  type LedgerTransaction,
  type StockCountAction,
  type StockCountAggregate,
} from "@rms/inventory";
import type { RoleAssignmentTransaction } from "@bop/permission";
import type { ConsumerTransaction } from "@bop/eventing";
import { listStoreOrdersOfSubmissions } from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createStaffLabels } from "./merchant-staff-labels.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
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
      | "Invalid"
      | "Unavailable",
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
  // A failure to read or write the count's sources is not a concurrent change (v15 2026-10-18:
  // a count below what open orders held showed "The count changed meanwhile").
  STOCK_COUNT_DEPENDENCY_UNAVAILABLE: "Unavailable",
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

/**
 * DEC-INV-COUNT-SHORT (2026-10-18): what a manager must act on after a count — items a count found
 * short against open orders (with those orders, by number) and items the kitchen then used beyond
 * the count. Inventory names the accounts and the rounds holding them; Ordering maps the rounds to
 * Orders. Read only, inside the caller's authorized transaction.
 */
export interface StockShortageView {
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotCode: string | null;
  readonly unitCode: string;
  readonly onHand: string;
  readonly reserved: string;
  readonly shortQuantity: string;
  readonly usedBeyondCount: string;
  readonly orders: readonly {
    readonly orderReference: string;
    readonly orderNumber: string;
    readonly orderType: "Pickup" | "DineIn";
    readonly businessDate: string;
    readonly quantity: string;
    /** Ordering recorded the Order as ended although it still holds stock. */
    readonly ended: boolean;
  }[];
}
export async function readStockShortages(
  tx: LedgerTransaction,
  owner: { tenantReference: string; brandReference: string; storeReference: string },
): Promise<readonly StockShortageView[]> {
  const shortages = await listStoreStockShortages(tx, owner);
  if (shortages.length === 0) return [];
  const submissions = [
    ...new Set(shortages.flatMap((entry) => entry.holding.map((h) => h.submissionReference))),
  ].slice(0, 500);
  const orders = new Map(
    (
      await listStoreOrdersOfSubmissions(
        tx as unknown as ConsumerTransaction,
        { brandReference: owner.brandReference, storeReference: owner.storeReference },
        submissions,
      )
    ).map((order) => [order.submissionReference, order]),
  );
  const lots = await stockLotLabels(
    tx,
    owner,
    shortages.flatMap((entry) => (entry.lotReference === null ? [] : [entry.lotReference])),
  );
  return shortages.map((entry) => ({
    itemReference: entry.itemReference,
    locationReference: entry.locationReference,
    lotCode: entry.lotReference === null ? null : (lots.get(entry.lotReference)?.lotCode ?? null),
    unitCode: entry.unitCode,
    onHand: entry.onHand,
    reserved: entry.reserved,
    shortQuantity: entry.shortQuantity,
    usedBeyondCount: entry.usedBeyondCount,
    orders: entry.holding.flatMap((held) => {
      const order = orders.get(held.submissionReference);
      return order === undefined
        ? []
        : [
            {
              orderReference: String(order.orderReference),
              orderNumber: order.orderNumber,
              orderType: order.orderType,
              businessDate: order.businessDate,
              quantity: held.quantity,
              ended: order.ended,
            },
          ];
    }),
  }));
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
  const countActions = [
    "inventory.count.read",
    "inventory.count.manage",
    "inventory.count.execute",
    "inventory.count.approve",
  ] as const;
  /**
   * WP-2423: one authorized run. `inventory.count.read` and every count permission are decided in
   * full once at the start (one permission packet); the read permission and every permission a
   * command used are re-checked in full once more before the reply or commit, inside the
   * transaction. `may` answers from the start decisions while the run is in progress (no query).
   */
  function authorizedRun<T>(
    tx: Tx,
    sessionCookie: unknown,
    sessionReference: string,
    work: (scope: {
      owner: { tenantReference: string; brandReference: string; storeReference: string };
      actor: string;
      /** The start decision (display only; never authorizes a change). */
      allows(action: string): boolean;
      /** Authorizes `action` for an owner command: the start decision, re-checked before commit. */
      may(action: string): Promise<boolean>;
    }) => Promise<T>,
  ): Promise<T> {
    const used = new Set<string>();
    return withMerchantTransactionAuthorization(
      {
        transaction: tx,
        resolve: async () => {
          const scope = await resolveScope(
            tx,
            sessionCookie,
            "inventory.count.read",
            sessionReference,
          );
          const decisions = await scope.authorizeActions(countActions);
          if (decisions.get("inventory.count.read")?.effect !== "Allow")
            return fail("PermissionDenied");
          return { scope, decisions };
        },
        recheck: async ({ scope }) => {
          if (used.size === 0) return (await scope.allowed()) === true;
          const actions = ["inventory.count.read", ...used];
          const decisions = await scope.authorizeActions(actions);
          return actions.every((action) => decisions.get(action)?.effect === "Allow");
        },
        denied: () => fail("PermissionDenied"),
      },
      (authority) => {
        const { scope, decisions } = authority.scope;
        const allows = (action: string) => decisions.get(action)?.effect === "Allow";
        return work({
          owner: {
            tenantReference: String(scope.selected.tenantReference),
            brandReference: String(scope.context.brand.brandReference),
            storeReference: String(scope.store.storeReference),
          },
          actor: String(scope.actorReference),
          allows,
          may: async (action) => {
            if (!(await authority.guard(tx))) return false;
            used.add(action);
            return allows(action);
          },
        });
      },
    );
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
      options.persistence.transactions.run((tx) =>
        authorizedRun(tx, input.sessionCookie, current.sessionReference, async (scope) => {
          const permissions = {
            mayCreate: scope.allows("inventory.count.manage"),
            mayCount: scope.allows("inventory.count.execute"),
            mayApprove: scope.allows("inventory.count.approve"),
          };
          const catalog = await merchantStockCatalog(tx, scope.owner, options.locale);
          const members = await listStoreMembers(
            tx as unknown as MemberDirectoryTransaction,
            scope.owner,
          );
          const names = new Map<string, string | null>(
            members.map((member) => [member.actorReference, member.displayName]),
          );
          // v15 run: staff read a person's name ("You" for themselves), or their role when no
          // name is recorded, never an identifier fragment such as "Staff 0100".
          const label = await createStaffLabels(
            tx as unknown as RoleAssignmentTransaction,
            scope.owner,
            { viewer: scope.actor, at: options.persistence.now(), names },
          );
          const staff = members
            .filter((member) => member.membershipLifecycle === "Active")
            .map((member) => ({
              actorReference: member.actorReference,
              label: label(member.actorReference),
            }));
          // People a count names who are not on the Store's staff list (a Brand Owner, or someone
          // whose Store membership ended) are named from the Brand's member directory.
          const people = async (actors: readonly (string | null)[]) => {
            const named = [
              ...new Set(actors.filter((actor): actor is string => actor !== null)),
            ].filter((actor) => !staff.some((item) => item.actorReference === actor));
            for (const [actor, displayName] of await memberDisplayNames(
              tx as unknown as MemberDirectoryTransaction,
              scope.owner,
              named.filter((actor) => actor !== scope.actor && !names.get(actor)),
            ))
              names.set(actor, displayName);
            return named.map((actor) => ({ actorReference: actor, label: label(actor) }));
          };
          const base = {
            sourceAsOf: options.persistence.now(),
            viewer: scope.actor,
            permissions,
            varianceReasons: stockCountVarianceReasons,
            items: catalog.items,
            locations: catalog.locations,
            staff,
            /** DEC-INV-COUNT-SHORT: items short against open orders or used beyond their count. */
            shortages: await readStockShortages(ledger(tx), scope.owner),
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
              people: await people([count.assigneeReference, count.submittedBy, count.approvedBy]),
              count: redactStockCount(count, permissions.mayApprove, scope.actor),
              lots: Object.fromEntries(lots),
            };
          }
          const page = await listStockCounts(ledger(tx), scope.owner, {
            before: input.before,
            limit: 30,
          });
          return {
            screenId: "INV-COUNT-LIST" as const,
            ...base,
            ...page,
            people: await people(page.counts.map((count) => count.assigneeReference)),
          };
        }),
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseStockCountCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(tx, input.sessionCookie, current.sessionReference, async (scope) => {
          const at = options.persistence.now();
          const mayViewExpected = scope.allows("inventory.count.approve");
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
                const item = (
                  await merchantStockCatalog(tx, scope.owner, options.locale)
                ).items.find((candidate) => candidate.itemReference === line.itemReference);
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
                // DEC-INV-COUNT-SHORT: the posted count may leave items short against open
                // orders; the page then lists them with those orders.
                const shortItems = (await listStoreStockShortages(ledger(tx), scope.owner)).filter(
                  (entry) => entry.shortQuantity !== "0",
                ).length;
                return {
                  status: posted.outcome,
                  version: posted.count.aggregateVersion,
                  movements: posted.movements.length,
                  shortItems,
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
      ),
    );
  };
  return { query, command };
}
