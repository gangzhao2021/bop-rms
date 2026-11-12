import { createDiningExceptionTaskComposition } from "./dining-exception-task-composition.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  DiningClosingError,
  createDiningClosingService,
  createPostgresDiningClosingStore,
  createPostgresDiningClosingFence,
  parseDiningHash,
  type DiningClosingAuthorityEvidence,
  type DiningClosingAuthorizationPort,
  type DiningSession,
} from "@rms/dining";
import {
  createPostgresStaffOrderCancellationReader,
  listStoreDiningSessionOrders,
} from "@rms/ordering";
import { createPostgresDiningTableSettlementStore } from "@rms/payment";
import { readDiningTableBill } from "./merchant-dining-table-checkout.js";
import {
  createDiningSettledSessionEvidence,
  createDiningSessionClosingEvidence,
} from "./dining-settled-session-evidence.js";
const fail = (): never => {
  throw new Error("DINING_CLOSING_COMMAND_UNAVAILABLE");
};
const changed = (): never => {
  throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
};
/**
 * DEC-DINE-IN-PAY-LATER (rule 3): checkout is cancelled (back to ordering) only while nothing has
 * been paid or written off for the table — a paid table pays once, and its payment never changes.
 */
export class DiningCheckoutAlreadyPaidError extends Error {
  /** S4: "GUEST_PAYING" — a guest is paying the whole table on their phone right now. */
  constructor(
    readonly code:
      | "DINING_CHECKOUT_ALREADY_PAID"
      | "DINING_CHECKOUT_GUEST_PAYING" = "DINING_CHECKOUT_ALREADY_PAID",
  ) {
    super(code);
    this.name = "DiningCheckoutAlreadyPaidError";
  }
}

/**
 * One step of closing a table's Session (Begin, Cancel or Finalize), in the caller's transaction.
 * The staff command and the System's close of a guest-started table run this same path; the caller
 * supplies who acts, how the freed table is released and, for staff, the exception Tasks an unpaid
 * table needs. Without Tasks only the settled path exists, so nothing owed can be closed here.
 */
export async function runDiningSessionClosing(input: {
  readonly transaction: ConsumerTransaction;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly command: {
    readonly action: "Begin" | "Cancel" | "Finalize";
    readonly diningSessionReference: string;
    readonly operationReference: string;
    readonly expectedSessionVersion: number;
  };
  readonly observedAt: string;
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  /** Who cancels checkout (staff): the split that ends with it is recorded under their name. */
  readonly actorReference?: string;
  guard(): Promise<boolean>;
  newReference(): string;
  authority(
    request: Parameters<DiningClosingAuthorizationPort["authorize"]>[0],
    reason: string,
  ): Promise<DiningClosingAuthorityEvidence | null>;
  /** The reason recorded on the audits; absent: guests left, or finished, from the Order's facts. */
  closingReason?(): Promise<string>;
  /** After Finalize commits (and on its replay): release the table. */
  release(session: DiningSession, sessionVersion: number): Promise<void>;
  readonly tasks?: {
    readonly policy: unknown;
    readonly actorReference: string;
    authorizeTask: Parameters<typeof createDiningExceptionTaskComposition>[0]["authorizeTask"];
  };
}) {
  const { command, scope, observedAt } = input;
  const guard = input.guard;
  const tx = input.transaction;
  const hashes = {
    hashIntent: (value: string) =>
      parseDiningHash(createHash("sha256").update(value).digest("hex")),
    equals: (a: string, b: string) => a === b,
  };
  const runner = { run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(tx) };
  const store = createPostgresDiningClosingStore(runner, scope, hashes);
  const fence = createPostgresDiningClosingFence({ scope, authorize: guard });
  const session = await fence(tx, {
    diningSessionReference: command.diningSessionReference,
    observedAt,
  });
  const prior = await store.readReceipt(command.operationReference, guard);
  if (prior) {
    if (
      prior.record.action !== command.action ||
      prior.record.session.diningSessionReference !== command.diningSessionReference ||
      prior.expectedVersion !== command.expectedSessionVersion ||
      prior.occurredAt > observedAt ||
      prior.record.session.version > session.version
    )
      return fail();
    if (command.action === "Finalize") await input.release(session, prior.record.session.version);
    return Object.freeze({
      status: "AlreadyApplied" as const,
      phase: prior.record.session.phase,
      sessionVersion: prior.record.session.version,
    });
  }
  if (session.version !== command.expectedSessionVersion) return changed();
  // Cancel is reversible only once proven here: nothing paid or written off for the table.
  let reversible = false;
  if (command.action === "Cancel") {
    // Back to ordering only while the table has paid nothing and was not written off.
    const order = (
      await listStoreDiningSessionOrders(
        tx,
        { brandReference: scope.brandReference, storeReference: scope.storeReference },
        [String(command.diningSessionReference)],
      )
    ).get(String(command.diningSessionReference));
    if (order !== undefined) {
      const payments = createPostgresDiningTableSettlementStore({
        scope: { ...scope, tenantReference: String(scope.tenantReference) },
        authorize: async (_tx, value) => value.orderReference === order && (await guard()),
      });
      if (
        (await payments.listByOrders(tx, [order])).length > 0 ||
        (await payments.listWriteOffsByOrders(tx, [order])).length > 0
      )
        throw new DiningCheckoutAlreadyPaidError();
      if (
        (await payments.listOnlinePaymentsByOrders(tx, [order])).some(
          (attempt) => attempt.outcome === null,
        )
      )
        throw new DiningCheckoutAlreadyPaidError("DINING_CHECKOUT_GUEST_PAYING");
    }
    reversible = true;
  }
  const authorizeAndFence = async () => {
    const again = await fence(tx, {
      diningSessionReference: command.diningSessionReference,
      observedAt,
    });
    return (
      again.version === session.version &&
      again.tableAssignmentVersion === session.tableAssignmentVersion
    );
  };
  const evidence = (
    input.tasks === undefined
      ? createDiningSettledSessionEvidence
      : createDiningSessionClosingEvidence
  )({
    ...scope,
    diningScope: scope,
    paymentScope: {
      ...scope,
      providerAccountReference: input.providerAccountReference,
      environment: input.environment,
    },
    authorize: guard,
    authorizeKitchen: guard,
    authorizeDining: guard,
    authorizeAndFence,
    // WP-2423 item 2: an Order whose every round was cancelled is closed with the table too.
    includeCancelled: true,
  });
  let resolvedEvidence: Awaited<ReturnType<typeof evidence.load>> | null = null;
  // DEC-TABLE-CLOSE-GUESTS-LEFT: a table whose rounds were closed out because the guests left
  // is recorded as closed for that reason, not as guests who finished. Ordering owner reads.
  let closingReason: Promise<string> | null = null;
  const reasonFor = () =>
    (closingReason ??=
      input.closingReason?.() ??
      (async () => {
        const owner = {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        };
        const order = (
          await listStoreDiningSessionOrders(tx, owner, [String(command.diningSessionReference)])
        ).get(String(command.diningSessionReference));
        if (order === undefined) return "CUSTOMER_FINISHED";
        const cancellations = await createPostgresStaffOrderCancellationReader(owner).listByOrders(
          tx,
          [order],
        );
        return cancellations.some((record) => record.reasonCode === "GUEST_LEFT")
          ? "GUEST_LEFT"
          : "CUSTOMER_FINISHED";
      })());
  const service = createDiningClosingService({
    store,
    hashes,
    authorization: {
      authorize: async (request) => {
        if (
          !(await guard()) ||
          request.session.diningSessionReference !== command.diningSessionReference
        )
          return null;
        return input.authority(request, await reasonFor());
      },
    },
    closureEvidence: {
      resolve: async (query) => {
        resolvedEvidence = await evidence.load(
          tx,
          {
            diningSessionReference: query.diningSessionReference,
            observedAt: query.observedAt,
          },
          session.version,
        );
        return resolvedEvidence;
      },
    },
    reversibility: {
      evaluate: async () => (reversible && (await guard()) ? "Reversible" : "Unavailable"),
    },
    tasks: {
      ensure: async (taskInput) => {
        if (!resolvedEvidence || input.tasks === undefined) return fail();
        return createDiningExceptionTaskComposition({
          transaction: tx,
          scope,
          actorReference: input.tasks.actorReference,
          correlationReference: command.operationReference,
          observedAt,
          evidence: resolvedEvidence,
          policy: input.tasks.policy,
          hashes,
          newReference: input.newReference,
          authorizeAndFence: async () => (await guard()) && (await authorizeAndFence()),
          authorizeTask: input.tasks.authorizeTask,
        }).ensure(taskInput);
      },
    },
  });
  const request = {
    diningSessionReference: command.diningSessionReference,
    operationReference: command.operationReference,
    expectedSessionVersion: command.expectedSessionVersion,
    requestedAt: observedAt,
  };
  const endSplit = async () => {
    // v15 batch 9: a split belongs to the checkout it was made in. Back to ordering, the guests
    // may order more or have a dish comped, so the next checkout starts from the whole bill and
    // staff split it again if the guests want: the table's plan is "pay whole" again (a new,
    // attributed plan version; the split stays on record). Never "the bill changed, split it
    // again" with old parts and "to go" at the start of a new checkout.
    const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
    const order = (
      await listStoreDiningSessionOrders(tx, owner, [String(command.diningSessionReference)])
    ).get(String(command.diningSessionReference));
    if (order === undefined) return;
    const payments = createPostgresDiningTableSettlementStore({
      scope: { ...scope, tenantReference: String(scope.tenantReference) },
      authorize: async (_tx, value) => value.orderReference === order && (await guard()),
    });
    const [plan] = await payments.listSplitPlans(tx, [order]);
    if (plan === undefined || plan.mode === "Whole") return;
    if (input.actorReference === undefined) return fail();
    const bill = await readDiningTableBill(tx, scope, {
      diningSessionReference: String(command.diningSessionReference),
      observedAt,
      authorize: guard,
    });
    const billMinor = bill.rounds.reduce((sum, round) => sum + BigInt(round.totalMinor), 0n);
    // A bill with nothing owed has no split to pay (checkout of it takes no payment).
    if (billMinor <= 0n) return;
    await payments.recordSplitPlan(tx, {
      splitPlanReference: input.newReference(),
      operationReference: input.newReference(),
      intentDigest:
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              "CHECKOUT_CANCELLED",
              command.operationReference,
              plan.splitPlanReference,
            ]),
          )
          .digest("hex"),
      diningSessionReference: String(command.diningSessionReference),
      orderReference: order,
      split: { mode: "Whole", billMinor },
      recordedAt: observedAt,
      actorReference: input.actorReference,
      auditReference: input.newReference(),
      correlationReference: command.operationReference,
      reasonCode: "CHECKOUT_CANCELLED",
    });
  };
  const result = await (command.action === "Begin"
    ? service.begin(request)
    : command.action === "Cancel"
      ? service.cancel(request)
      : service.finalize(request));
  if (command.action === "Cancel" && result.status === "Applied") await endSplit();
  if (command.action === "Finalize") await input.release(session, result.session.version);
  return Object.freeze({
    status: result.status,
    phase: result.session.phase,
    sessionVersion: result.session.version,
  });
}
