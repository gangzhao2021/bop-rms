import type { ConsumerTransaction } from "@bop/eventing";
import {
  KitchenWorkLifecycleError,
  kitchenWorkLifecycleProjectionName,
  type KitchenWorkLifecycleResult,
} from "../contracts/kitchen-work-lifecycle.js";
import type {
  KitchenWorkStepKind,
  KitchenWorkStepLine,
  KitchenWorkStepLineResult,
  KitchenWorkStepRefusal,
} from "../contracts/kitchen-work-step.js";
import {
  listKitchenComboDishes,
  recordKitchenComboPartDone,
  type KitchenComboDish,
} from "../infrastructure/persistence/kitchen-combo-part-store.js";
import { listClosedKitchenTickets } from "../infrastructure/persistence/kitchen-stale-ticket-store.js";
import {
  createPostgresKitchenWorkLifecycleStore,
  loadKitchenWorkStepHistory,
  lockKitchenWorkStepTicket,
  readKitchenWorkStepTickets,
} from "../infrastructure/persistence/kitchen-work-lifecycle-store.js";
import { createKitchenWorkLifecycleService } from "./kitchen-work-lifecycle-service.js";
import type {
  KitchenWorkLifecycleEffect,
  KitchenWorkLifecyclePorts,
} from "./ports/kitchen-work-lifecycle-ports.js";

function invalid(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_INPUT_INVALID");
}

const databaseCode = (error: unknown) =>
  error !== null && typeof error === "object"
    ? (Object.getOwnPropertyDescriptor(error, "code")?.value as unknown)
    : undefined;

export type KitchenWorkStepPorts = Pick<
  KitchenWorkLifecyclePorts,
  "admission" | "expo" | "references" | "digests" | "tenantContext" | "idempotency"
> & {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly now: () => string;
  /** The authorized run's guard; a step never re-resolves the caller while it holds locks. */
  readonly guard: (transaction?: unknown) => Promise<boolean>;
  /**
   * Whether the Order still stands behind this ticket as issued. Takes the Order's fence and row
   * lock, which stay held to the end of the transaction: repository lock order is Ordering, then
   * Kitchen (kitchen-work-lifecycle-store.ts). False: the Order moved on.
   */
  readonly validateTicketSource: (
    transaction: ConsumerTransaction,
    ticketReference: string,
  ) => Promise<boolean>;
  /** The Catalog's combo record for these options: which dish (product) each one stands for. */
  readonly comboChoices: (
    transaction: ConsumerTransaction,
    optionReferences: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
};

const earlier = (left: string, right: string) => Date.parse(left) < Date.parse(right);

/**
 * DEC-KITCHEN-ONE-TAP: one chunk of a tap in the caller's transaction, in lock order: read each
 * ticket's Order without a lock, take the Ordering fence, then the ticket's row lock, sample the
 * time, and run the lines. Each line follows current state and writes ordinary lifecycle facts
 * (Accept, Start, Complete, each with its actor, audit and event) under one correlation, so a retry
 * of the same body records nothing twice. A line the Start admission blocks is rolled back alone.
 */
export async function runKitchenWorkStepChunk(
  ports: KitchenWorkStepPorts,
  input: KitchenWorkStepChunk,
): Promise<KitchenWorkStepChunkResult> {
  try {
    return await runChunk(ports, input);
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    // A database failure keeps its SQLSTATE: the transaction runner reads a conflict as "rerun".
    const code = databaseCode(error);
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) throw error;
    // Anything else is "busy, try again", never a refusal of the cook's permission.
    throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  }
}

interface KitchenWorkStepChunk {
  readonly transaction: ConsumerTransaction;
  readonly step: KitchenWorkStepKind;
  readonly correlationReference: string;
  /** Every ticket of the whole tap: a tap is one card, so they must share one Order. */
  readonly tapTickets: readonly string[];
  /** One ticket's lines. */
  readonly lines: readonly KitchenWorkStepLine[];
}
interface KitchenWorkStepChunkResult {
  readonly occurredAt: string;
  readonly lines: readonly KitchenWorkStepLineResult[];
}

async function runChunk(
  ports: KitchenWorkStepPorts,
  input: KitchenWorkStepChunk,
): Promise<KitchenWorkStepChunkResult> {
  const { transaction: tx, step, correlationReference, lines } = input;
  const scope = { brandReference: ports.brandReference, storeReference: ports.storeReference };
  const ticketReference = lines[0]?.ticketReference;
  if (ticketReference === undefined || lines.some((l) => l.ticketReference !== ticketReference))
    return invalid();

  const facts = await readKitchenWorkStepTickets(tx, scope, input.tapTickets);
  if (new Set([...facts.values()].map((ticket) => ticket.orderReference)).size > 1)
    return invalid();
  const refusedAll = (reason: KitchenWorkStepRefusal, occurredAt: string) => ({
    occurredAt,
    lines: Object.freeze(lines.map((line) => refused(line, reason))),
  });
  const ticketFacts = facts.get(ticketReference);
  if (ticketFacts === undefined) return refusedAll("NotFound", ports.now());
  const closedAlready = await listClosedKitchenTickets(tx, scope, [ticketReference]);
  if (closedAlready.size > 0) return refusedAll("Closed", ports.now());

  // Foreign owner reads come before Kitchen locks.
  const choiceOptions = [
    ...new Set(lines.flatMap((line) => [...(ticketFacts.items.get(line.workItemReference) ?? [])])),
  ];
  const productOfOption =
    choiceOptions.length === 0
      ? new Map<string, string>()
      : await ports.comboChoices(tx, choiceOptions);

  // The Order's fence and row lock stay held to the end of the transaction. A source that no longer
  // stands is a refusal staff can act on, never "busy, try again" forever.
  if ((await ports.validateTicketSource(tx, ticketReference)) !== true)
    return refusedAll("OrderChanged", ports.now());

  const locked = await lockKitchenWorkStepTicket(tx, scope, ticketReference);
  if (locked === null) return refusedAll("NotFound", ports.now());
  if ((await listClosedKitchenTickets(tx, scope, [ticketReference])).size > 0)
    return refusedAll("Closed", ports.now());
  if (locked.status !== "Open") return refusedAll("Closed", ports.now());
  // A tap that waited on the lock is recorded no earlier than the fact it waited for.
  const sampled = ports.now();
  const observedAt = earlier(sampled, locked.updatedAt) ? locked.updatedAt : sampled;

  const decodedHistory = new Map<string, KitchenWorkLifecycleEffect[]>();
  const trusted = async (candidate: {
    readonly actorReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  }) =>
    candidate.actorReference === ports.actorReference &&
    candidate.brandReference === ports.brandReference &&
    candidate.storeReference === ports.storeReference &&
    (await ports.guard());
  const lifecycle = createKitchenWorkLifecycleService({
    admission: ports.admission,
    expo: ports.expo,
    references: ports.references,
    digests: ports.digests,
    tenantContext: ports.tenantContext,
    idempotency: ports.idempotency,
    trustedContext: {
      resolveAuthority: async () => ({
        actorReference: ports.actorReference,
        brandReference: ports.brandReference,
        storeReference: ports.storeReference,
        observedAt,
      }),
    },
    correlationContext: { resolve: async () => ({ correlationReference }) },
    authorization: { authorize: trusted },
    transactions: { withTransaction: async (work) => work(tx) },
    clock: { now: () => observedAt },
    repository: createPostgresKitchenWorkLifecycleStore({
      references: ports.references,
      digests: ports.digests,
      ...scope,
      authorize: async (candidateTransaction, candidate) =>
        (candidate.access === "Recover" || (await trusted(candidate.command))) &&
        (await ports.guard(candidateTransaction)),
      // Validated above, before the Kitchen locks, and held to the end of the transaction.
      validateCurrentSource: async () => true,
      decodedHistory,
    }),
  });
  const items = new Map(locked.items.map((item) => [item.workItemReference, { ...item }]));
  let ticketVersion = locked.version;
  const known = await loadKitchenWorkStepHistory(
    tx,
    { references: ports.references, digests: ports.digests, ...scope },
    ticketReference,
  );
  decodedHistory.set(ticketReference, known);

  const results: KitchenWorkStepLineResult[] = [];
  for (const line of lines) {
    const item = items.get(line.workItemReference);
    if (item === undefined || item.orderItemReference !== line.orderItemReference) {
      results.push(refused(line, "NotFound"));
      continue;
    }
    const dishes =
      (
        await listKitchenComboDishes(tx, scope, {
          items: [
            {
              orderItemReference: item.orderItemReference,
              optionReferences: ticketFacts.items.get(item.workItemReference) ?? [],
            },
          ],
          productOfOption,
        })
      ).get(item.orderItemReference) ?? null;
    if (
      line.optionReferences !== null &&
      (dishes === null ||
        line.optionReferences.some(
          (option) => !dishes.some((dish) => dish.optionReference === option),
        ))
    )
      return invalid();
    const refusedLine = (reason: KitchenWorkStepRefusal) =>
      lineResult(line, "Refused", reason, { ticketVersion, item, operations: known, dishes });
    if (item.status === "Cancelled" || item.status === "Held") {
      results.push(refusedLine(item.status));
      continue;
    }
    const before = { ticketVersion, item: { ...item } };
    const recordedBefore = known.length;
    await tx.query("SAVEPOINT kitchen_step_line", []);
    try {
      const record = async (
        action: "AcceptKitchenWorkItem" | "StartKitchenWorkItem" | "CompleteKitchenWorkItem",
        suffix: string,
        extra: { readonly quantityDelta?: number } = {},
      ): Promise<KitchenWorkLifecycleResult> => {
        const result = await lifecycle.execute({
          action,
          idempotencyKey: line.idempotencyKey + ":" + suffix,
          actorReference: ports.actorReference,
          ...scope,
          ticketReference,
          workItemReference: item.workItemReference,
          orderItemReference: item.orderItemReference,
          expectedTicketVersion: ticketVersion,
          expectedWorkItemVersion: item.version,
          correlationReference,
          ...extra,
        });
        ticketVersion = result.ticketVersion;
        item.version = result.workItemVersion;
        item.status = result.workItemStatus;
        item.completedQuantity = result.completedQuantity;
        return result;
      };
      const accepted = known.some(
        (effect) =>
          effect.mutation.workItemReference === item.workItemReference &&
          effect.operation.actionCode === "KITCHEN_WORK_ITEM_ACCEPTED",
      );
      const begin = async () => {
        if (!accepted) await record("AcceptKitchenWorkItem", "accept");
        await record("StartKitchenWorkItem", "start");
      };
      const complete = () =>
        record("CompleteKitchenWorkItem", "finish", {
          quantityDelta: item.requiredQuantity - item.completedQuantity,
        });
      let outcome: KitchenWorkStepLineResult["outcome"];
      let afterDishes = dishes;
      if (step === "Start") {
        if (item.status === "Queued") {
          await begin();
          outcome = "Started";
        } else outcome = "AlreadyStarted";
      } else if (item.status === "Completed") {
        outcome = "AlreadyFinished";
      } else if (dishes === null) {
        if (item.status === "Queued") await begin();
        await complete();
        outcome = "Finished";
      } else {
        // A combo is ready only when its last dish is done, whichever cook tapped it, in this
        // commit; each dish keeps its own who and when.
        const prepared = dishes.filter((dish) => !dish.notPrepared);
        const wanted =
          line.optionReferences === null
            ? prepared.filter((dish) => dish.doneAt === null)
            : prepared.filter(
                (dish) =>
                  dish.doneAt === null && line.optionReferences?.includes(dish.optionReference),
              );
        for (const dish of wanted)
          await recordKitchenComboPartDone(tx, scope, {
            workItemReference: item.workItemReference,
            optionReference: dish.optionReference,
            operationReference: ports.references.next("KitchenWorkLifecycleOperation"),
            actorReference: ports.actorReference,
            doneAt: observedAt,
          });
        afterDishes = dishes.map((dish) =>
          wanted.includes(dish) ? Object.freeze({ ...dish, doneAt: observedAt }) : dish,
        );
        if (item.status === "Queued") await begin();
        if (afterDishes.some((dish) => !dish.notPrepared && dish.doneAt === null))
          outcome = "DishDone";
        else {
          await complete();
          outcome = "Finished";
        }
      }
      await tx.query("RELEASE SAVEPOINT kitchen_step_line", []);
      results.push(
        lineResult(line, outcome, null, {
          ticketVersion,
          item,
          operations: known,
          dishes: afterDishes,
        }),
      );
    } catch (error) {
      if (
        !(error instanceof KitchenWorkLifecycleError) ||
        error.code !== "KITCHEN_WORK_PRECONDITION_FAILED"
      )
        throw error;
      // Blocked before cooking: nothing of this line stays; the rest of the tap commits.
      await tx.query("ROLLBACK TO SAVEPOINT kitchen_step_line", []);
      await tx.query("RELEASE SAVEPOINT kitchen_step_line", []);
      known.length = recordedBefore;
      ticketVersion = before.ticketVersion;
      Object.assign(item, before.item);
      results.push(refusedLine("Blocked"));
    }
  }
  return { occurredAt: observedAt, lines: Object.freeze(results) };
}

function refused(
  line: KitchenWorkStepLine,
  reason: KitchenWorkStepRefusal,
): KitchenWorkStepLineResult {
  return Object.freeze({
    workItemReference: line.workItemReference,
    orderItemReference: line.orderItemReference,
    ticketReference: line.ticketReference,
    outcome: "Refused",
    refusedReason: reason,
    ticketVersion: null,
    workItemVersion: null,
    workItemStatus: null,
    completedQuantity: null,
    requiredQuantity: null,
    acceptedAt: null,
    readyAt: null,
    dishesDone: null,
  });
}

function lineResult(
  line: KitchenWorkStepLine,
  outcome: KitchenWorkStepLineResult["outcome"],
  refusedReason: KitchenWorkStepRefusal | null,
  state: {
    readonly ticketVersion: string;
    readonly item: {
      readonly version: string;
      readonly status: string;
      readonly requiredQuantity: number;
      readonly completedQuantity: number;
      readonly workItemReference: string;
      readonly orderItemReference: string;
    };
    readonly operations: readonly KitchenWorkLifecycleEffect[];
    readonly dishes: readonly KitchenComboDish[] | null;
  },
): KitchenWorkStepLineResult {
  const own = state.operations.filter(
    (effect) => effect.mutation.workItemReference === state.item.workItemReference,
  );
  return Object.freeze({
    workItemReference: line.workItemReference,
    orderItemReference: line.orderItemReference,
    ticketReference: line.ticketReference,
    outcome,
    refusedReason,
    ticketVersion: state.ticketVersion,
    workItemVersion: state.item.version,
    workItemStatus: state.item.status as KitchenWorkStepLineResult["workItemStatus"],
    completedQuantity: state.item.completedQuantity,
    requiredQuantity: state.item.requiredQuantity,
    acceptedAt:
      own.find((effect) => effect.operation.actionCode === "KITCHEN_WORK_ITEM_ACCEPTED")?.operation
        .occurredAt ?? null,
    readyAt:
      state.operations.flatMap((effect) =>
        effect.readyResult?.orderItemReference === state.item.orderItemReference
          ? [effect.readyResult.readyAt]
          : [],
      )[0] ?? null,
    dishesDone:
      state.dishes === null
        ? null
        : Object.freeze(
            state.dishes.filter((dish) => dish.doneAt !== null).map((d) => d.optionReference),
          ),
  });
}

/** The reply's fixed head: the board's projection catches up by itself. */
export const kitchenWorkStepReplyHead = Object.freeze({
  projectionName: kitchenWorkLifecycleProjectionName,
  projectionPending: true as const,
});
