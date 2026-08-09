import { createHash } from "node:crypto";

import type { ConsumerTransaction } from "@bop/eventing";
import {
  createOrderKitchenSourceEvidenceBinding,
  createOrderKitchenSourceLineBinding,
  parseConfirmedOrderKitchenSourceEvidence,
  type ConfirmedOrderKitchenSourceEvidence,
} from "@rms/ordering";
import { describe, expect, it } from "vitest";

import {
  type ConfirmedOrderIntakeReceipt,
  type KitchenPlanningSource,
  type KitchenWorkPlanPorts,
  type KitchenTicketCreationEffect,
  type KitchenTicketCreationPorts,
  type KitchenStableReferencePurpose,
  createKitchenExecutionSnapshotDigestBinding,
  createKitchenPreparationEvidenceSetDigestBinding,
  createKitchenRoutingRuleDigestBinding,
  createKitchenStationRoutingCandidateSetDigestBinding,
  createKitchenTicketCreationService,
  createKitchenTicketIntakeAdapter,
  createKitchenWorkPlanDigestBinding,
  createKitchenWorkPlanService,
  parseConfirmedOrderIntakeReceipt,
  parseKitchenCustomerNote,
  parseKitchenTicket,
  parseKitchenTicketCreationAction,
  parseKitchenTicketCreationResult,
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenPlanningSource,
  parseKitchenTicketReference,
  parseKitchenWorkPlan,
} from "../index.js";

function id(value: number): string {
  return `018f1000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("fixture is not canonicalizable");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function resignEffect(
  value: Omit<KitchenTicketCreationEffect, "effectDigest">,
): KitchenTicketCreationEffect {
  return Object.freeze({ ...value, effectDigest: sha256(canonical(value)) });
}

const at = {
  confirmed: "2026-08-08T16:00:00.000Z",
  captured: "2026-08-08T15:59:59.000Z",
  planned: "2026-08-08T16:00:01.000Z",
  created: "2026-08-08T16:00:02.000Z",
  later: "2026-08-08T16:00:03.000Z",
} as const;

function receipt(
  overrides: Partial<Record<keyof ConfirmedOrderIntakeReceipt, unknown>> = {},
): ConfirmedOrderIntakeReceipt {
  return parseConfirmedOrderIntakeReceipt({
    consumerName: "kitchen.confirmed-order:v1",
    consumerVersion: 1,
    sourceEventReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    confirmationReference: id(6),
    sourceAggregateVersion: 3n,
    sourceSnapshotDigest: sha256("order-snapshot"),
    confirmedAt: at.confirmed,
    correlationReference: id(7),
    semanticEventBindingDigest: sha256("semantic-order-confirmed"),
    ...overrides,
  });
}

function sourceFor(
  input: ConfirmedOrderIntakeReceipt,
  overrides: { readonly customerNote?: string | null; readonly quantity?: number } = {},
): ConfirmedOrderKitchenSourceEvidence {
  const draftItem = {
    orderItemReference: id(20),
    orderBatchReference: input.orderBatchReference,
    ordinal: 1,
    quantity: overrides.quantity ?? 2,
    productReference: id(21),
    productVersionReference: id(22),
    skuReference: id(23),
    menuVersionReference: id(24),
    localizedDisplayNames: { "en-CA": "Synthetic noodle bowl", "fr-CA": "Bol synthétique" },
    selectedOptions: [
      {
        optionReference: id(25),
        quantity: 1,
        localizedNames: { "en-CA": "Synthetic scallion", "fr-CA": "Oignon synthétique" },
      },
    ],
    customerNote:
      overrides.customerNote === undefined ? "Synthetic: sauce on side" : overrides.customerNote,
    lineDigest: sha256("placeholder-line"),
  };
  const item = {
    ...draftItem,
    lineDigest: sha256(createOrderKitchenSourceLineBinding(draftItem)),
  };
  const draft = {
    evidenceReference: id(26),
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    orderReference: input.orderReference,
    orderBatchReference: input.orderBatchReference,
    confirmationReference: input.confirmationReference,
    sourceEventReference: input.sourceEventReference,
    sourceAggregateVersion: input.sourceAggregateVersion,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    capturedAt: at.captured,
    evidenceVersion: 1,
    items: [item],
    evidenceDigest: sha256("placeholder-evidence"),
  };
  return parseConfirmedOrderKitchenSourceEvidence({
    ...draft,
    evidenceDigest: sha256(createOrderKitchenSourceEvidenceBinding(draft)),
  });
}

function planningSourceFor(source: ConfirmedOrderKitchenSourceEvidence): KitchenPlanningSource {
  return parseKitchenPlanningSource({
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    orderReference: source.orderReference,
    orderBatchReference: source.orderBatchReference,
    confirmationReference: source.confirmationReference,
    sourceEvidenceReference: source.evidenceReference,
    sourceEvidenceVersion: source.evidenceVersion,
    sourceEvidenceDigest: source.evidenceDigest,
    items: source.items.map((item) => ({
      orderItemReference: item.orderItemReference,
      ordinal: item.ordinal,
      quantity: item.quantity,
      productReference: item.productReference,
      productVersionReference: item.productVersionReference,
      skuReference: item.skuReference,
      menuVersionReference: item.menuVersionReference,
      selectedOptions: item.selectedOptions.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
      })),
      sourceLineDigest: item.lineDigest,
    })),
  });
}

function planFor(source: KitchenPlanningSource, input: ConfirmedOrderIntakeReceipt) {
  const draftItem = {
    orderItemReference: source.items[0]?.orderItemReference,
    splitOrdinal: 1,
    stationRouting: {
      stationReference: id(30),
      routingRuleReference: id(31),
      routingRuleVersion: 2,
      routingRuleDigest: sha256("routing-rule-v2"),
    },
    preparation: {
      preparationReference: id(32),
      preparationVersion: 4,
      preparationDigest: sha256("preparation-v4"),
      instructions: ["Prepare synthetic item", "Plate synthetic item"],
    },
  };
  const draftPlan = parseKitchenWorkPlan({
    planReference: id(33),
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    orderReference: input.orderReference,
    orderBatchReference: input.orderBatchReference,
    confirmationReference: input.confirmationReference,
    sourceEvidenceDigest: source.sourceEvidenceDigest,
    planVersion: 1,
    generatedAt: at.planned,
    items: [draftItem],
    planDigest: sha256("placeholder-plan"),
  });
  return parseKitchenWorkPlan({
    ...draftPlan,
    planDigest: sha256(createKitchenWorkPlanDigestBinding(draftPlan)),
  });
}

type RealPlannerOutcome = "Allow" | "Deny" | "Throw" | "Ambiguous";

interface RealPlannerOptions {
  readonly stationOutcome?: RealPlannerOutcome;
  readonly preparationOutcome?: Exclude<RealPlannerOutcome, "Ambiguous">;
}

function realPlanner(options: RealPlannerOptions = {}) {
  const calls = {
    station: 0,
    stationSourceReads: 0,
    preparation: 0,
    preparationSourceReads: 0,
    reference: 0,
    digest: 0,
    stationRequests: [] as unknown[],
    preparationRequests: [] as unknown[],
  };
  const ports: KitchenWorkPlanPorts = {
    stationRouting: {
      resolve: async (request) => {
        calls.station += 1;
        calls.stationRequests.push(request);
        if (options.stationOutcome === "Deny") return null;
        if (options.stationOutcome === "Throw")
          throw new Error("private Station owner detail must not escape");
        calls.stationSourceReads += 1;
        const candidate = {
          stationReference: id(400),
          stationVersion: 3,
          stationStatus: "Active",
          stationCapabilityReferences: [id(403)],
          routingRuleReference: id(401),
          routingRuleVersion: 5,
          routingRuleStatus: "Active",
          selector: { kind: "AllPreparedItems" },
          targetStationReference: id(400),
          routingRuleDigest: sha256("placeholder-rule"),
        };
        const signedCandidate = {
          ...candidate,
          routingRuleDigest: sha256(
            createKitchenRoutingRuleDigestBinding({
              brandReference: request.brandReference,
              storeReference: request.storeReference,
              effectiveAt: request.effectiveAt,
              candidate,
            }),
          ),
        };
        const candidates =
          options.stationOutcome === "Ambiguous"
            ? [
                signedCandidate,
                {
                  ...signedCandidate,
                  stationReference: id(410),
                  targetStationReference: id(410),
                  routingRuleReference: id(411),
                  routingRuleDigest: sha256(
                    createKitchenRoutingRuleDigestBinding({
                      brandReference: request.brandReference,
                      storeReference: request.storeReference,
                      effectiveAt: request.effectiveAt,
                      candidate: {
                        ...signedCandidate,
                        stationReference: id(410),
                        targetStationReference: id(410),
                        routingRuleReference: id(411),
                        routingRuleDigest: sha256("placeholder-second-rule"),
                      },
                    }),
                  ),
                },
              ]
            : [signedCandidate];
        const draft = {
          evidenceReference: id(402),
          evidenceVersion: 7,
          evidenceDigest: sha256("placeholder-station-evidence"),
          brandReference: request.brandReference,
          storeReference: request.storeReference,
          effectiveAt: request.effectiveAt,
          candidates,
        };
        return {
          ...draft,
          evidenceDigest: sha256(createKitchenStationRoutingCandidateSetDigestBinding(draft)),
        };
      },
    },
    preparations: {
      resolve: async (request) => {
        calls.preparation += 1;
        calls.preparationRequests.push(request);
        if (options.preparationOutcome === "Deny") return null;
        if (options.preparationOutcome === "Throw")
          throw new Error("private Recipe owner detail must not escape");
        calls.preparationSourceReads += 1;
        const draft = {
          evidenceReference: id(404),
          evidenceVersion: 9,
          evidenceDigest: sha256("placeholder-preparation-evidence"),
          brandReference: request.brandReference,
          storeReference: request.storeReference,
          effectiveAt: request.effectiveAt,
          items: request.items.map((item, index) => ({
            orderItemReference: item.orderItemReference,
            ordinal: item.ordinal,
            quantity: item.quantity,
            productReference: item.productReference,
            productVersionReference: item.productVersionReference,
            skuReference: item.skuReference,
            menuVersionReference: item.menuVersionReference,
            selectedOptions: item.selectedOptions,
            sourceLineDigest: item.sourceLineDigest,
            preparationReference: id(420 + index),
            preparationVersion: 11,
            preparationDigest: sha256(`opaque-Recipe-preparation-${index}`),
            instructions: ["Prepare synthetic execution", "Plate synthetic execution"],
            requiredStationCapabilityReferences: [id(403)],
          })),
        };
        return {
          ...draft,
          evidenceDigest: sha256(createKitchenPreparationEvidenceSetDigestBinding(draft)),
        };
      },
    },
    references: {
      derive: () => {
        calls.reference += 1;
        return id(405);
      },
    },
    digests: {
      sha256: (binding) => {
        calls.digest += 1;
        return sha256(binding);
      },
    },
  };
  const service = createKitchenWorkPlanService(ports);
  return { calls, resolve: (value: unknown) => service.resolve(value) };
}

function changeSource(
  source: ConfirmedOrderKitchenSourceEvidence,
  input: {
    readonly evidenceReference?: string;
    readonly capturedAt?: string;
    readonly quantity?: number;
    readonly customerNote?: string | null;
  },
): ConfirmedOrderKitchenSourceEvidence {
  const current = source.items[0];
  if (current === undefined) throw new Error("fixture item missing");
  const changedItem = {
    ...current,
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
    ...(input.customerNote === undefined ? {} : { customerNote: input.customerNote }),
    lineDigest: sha256("placeholder-line"),
  };
  const item = {
    ...changedItem,
    lineDigest: sha256(createOrderKitchenSourceLineBinding(changedItem)),
  };
  const changed = {
    ...source,
    ...(input.evidenceReference === undefined
      ? {}
      : { evidenceReference: input.evidenceReference }),
    ...(input.capturedAt === undefined ? {} : { capturedAt: input.capturedAt }),
    items: [item],
    evidenceDigest: sha256("placeholder-evidence"),
  };
  return parseConfirmedOrderKitchenSourceEvidence({
    ...changed,
    evidenceDigest: sha256(createOrderKitchenSourceEvidenceBinding(changed)),
  });
}

function changePlan(
  plan: ReturnType<typeof planFor>,
  input: {
    readonly planReference?: string;
    readonly generatedAt?: string;
    readonly stationReference?: string;
    readonly routingRuleVersion?: number;
    readonly preparationVersion?: number;
    readonly instructions?: readonly string[];
  },
) {
  const current = plan.items[0];
  if (current === undefined) throw new Error("fixture item missing");
  const changedItem = parseKitchenWorkPlan({
    ...plan,
    items: [
      {
        ...current,
        stationRouting: {
          ...current.stationRouting,
          ...(input.stationReference === undefined
            ? {}
            : { stationReference: input.stationReference }),
          ...(input.routingRuleVersion === undefined
            ? {}
            : { routingRuleVersion: input.routingRuleVersion }),
        },
        preparation: {
          ...current.preparation,
          ...(input.preparationVersion === undefined
            ? {}
            : { preparationVersion: input.preparationVersion }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        },
      },
    ],
  }).items[0];
  if (changedItem === undefined) throw new Error("fixture plan item missing");
  const changed = parseKitchenWorkPlan({
    ...plan,
    ...(input.planReference === undefined ? {} : { planReference: input.planReference }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    items: [changedItem],
  });
  return parseKitchenWorkPlan({
    ...changed,
    planDigest: sha256(createKitchenWorkPlanDigestBinding(changed)),
  });
}

const transaction: ConsumerTransaction = {
  query: async () => ({ rowCount: 0, rows: [] }),
};

interface HarnessOptions {
  readonly hideFirstResolution?: boolean;
  readonly resolveConflict?: boolean;
  readonly resolveStatusFlip?: boolean;
  readonly initialEffect?: KitchenTicketCreationEffect | undefined;
  readonly commitUnknown?: boolean;
  readonly throwOnCommit?: boolean;
  readonly failAudit?: boolean;
  readonly failOutbox?: boolean;
  readonly collideReferences?: boolean;
  readonly collideWithInput?: KitchenStableReferencePurpose;
  readonly now?: string;
  readonly observePlanningSource?: (source: KitchenPlanningSource) => void;
  readonly mutateSource?: (source: ConfirmedOrderKitchenSourceEvidence) => unknown;
  readonly resolvePlan?: (value: {
    readonly receipt: ConfirmedOrderIntakeReceipt;
    readonly source: KitchenPlanningSource;
  }) => Promise<unknown | null>;
  readonly mutatePlan?: (
    plan: ReturnType<typeof planFor>,
    source: KitchenPlanningSource,
  ) => unknown | null;
}

function harness(inputReceipt: ConfirmedOrderIntakeReceipt, options: HarnessOptions = {}) {
  let durable = options.initialEffect;
  let resolutionCalls = 0;
  const calls = { source: 0, plan: 0, clock: 0, resolve: 0, commit: 0 };
  const ports: KitchenTicketCreationPorts = {
    orderingSource: {
      resolve: async () => {
        calls.source += 1;
        const source = sourceFor(inputReceipt);
        return options.mutateSource?.(source) ?? source;
      },
    },
    plans: {
      resolve: async (value) => {
        calls.plan += 1;
        const { source } = value;
        options.observePlanningSource?.(source);
        if (options.resolvePlan !== undefined) return options.resolvePlan(value);
        const plan = planFor(source, inputReceipt);
        const mutated = options.mutatePlan?.(plan, source);
        return mutated === undefined ? plan : mutated;
      },
    },
    clock: {
      now: async () => {
        calls.clock += 1;
        return options.now ?? at.created;
      },
    },
    references: {
      derive: (purpose, identity) => {
        if (options.collideReferences) return id(90);
        if (options.collideWithInput === purpose) return inputReceipt.sourceEventReference;
        const prefix = {
          KitchenTicket: "01",
          KitchenWorkItem: "02",
          KitchenCreationAction: "03",
          KitchenCreationAudit: "04",
          KitchenWorkCreatedEvent: "05",
        }[purpose];
        return `018f2000-${prefix}00-7000-8000-${createHash("sha256")
          .update(`${purpose}:${identity}`)
          .digest("hex")
          .slice(0, 12)}`;
      },
    },
    digests: { sha256 },
    repository: {
      resolveBySemanticKeys: async (identity) => {
        calls.resolve += 1;
        resolutionCalls += 1;
        if (options.resolveStatusFlip) {
          let statusReads = 0;
          return new Proxy(
            { status: "NotFound" as const },
            {
              getOwnPropertyDescriptor: (_target, property) => {
                if (property !== "status") return undefined;
                statusReads += 1;
                return {
                  value: statusReads === 1 ? "NotFound" : "Conflict",
                  enumerable: true,
                  configurable: true,
                  writable: true,
                };
              },
            },
          ) as never;
        }
        if (options.resolveConflict) return { status: "Conflict" as const };
        if (options.hideFirstResolution && resolutionCalls === 1)
          return { status: "NotFound" as const };
        if (durable === undefined) return { status: "NotFound" as const };
        const stored = durable.receipt;
        if (
          stored.brandReference !== identity.brandReference ||
          stored.storeReference !== identity.storeReference
        )
          return { status: "NotFound" as const };
        const eventMatch = stored.sourceEventReference === identity.sourceEventReference;
        const confirmationMatch = stored.confirmationReference === identity.confirmationReference;
        const batchMatch = stored.orderBatchReference === identity.orderBatchReference;
        if (confirmationMatch && batchMatch)
          return { status: "Resolved" as const, effect: durable };
        if (eventMatch || confirmationMatch || batchMatch) return { status: "Conflict" as const };
        return { status: "NotFound" as const };
      },
      commit: async ({ effect }) => {
        calls.commit += 1;
        if (options.failAudit && effect.audit.actionCode === "KITCHEN_TICKET_CREATED")
          throw new Error("synthetic mandatory Audit failure");
        if (options.failOutbox && effect.event.eventType === "KitchenWorkCreated")
          throw new Error("synthetic mandatory Outbox failure");
        if (options.throwOnCommit)
          throw new Error("synthetic lost acknowledgement after competing commit");
        if (durable !== undefined) return { status: "AlreadyCreated" as const, effect: durable };
        durable = effect;
        if (options.commitUnknown) throw new Error("synthetic commit outcome unknown");
        return { status: "Created" as const, effect };
      },
    },
  };
  return {
    calls,
    ports,
    service: createKitchenTicketCreationService(ports),
    adapter: createKitchenTicketIntakeAdapter(ports),
    durable: () => durable,
  };
}

function code(error: unknown): unknown {
  return (error as { readonly code?: unknown }).code;
}

function tamperStableReference(
  effect: KitchenTicketCreationEffect,
  purpose: KitchenStableReferencePurpose,
): KitchenTicketCreationEffect {
  const changedReference = parseKitchenTicketReference(
    id(
      {
        KitchenTicket: 601,
        KitchenWorkItem: 602,
        KitchenCreationAction: 603,
        KitchenCreationAudit: 604,
        KitchenWorkCreatedEvent: 605,
      }[purpose],
    ),
  );
  let ticket = effect.ticket;
  let action = effect.action;
  let audit = effect.audit;
  let event = effect.event;
  if (purpose === "KitchenTicket") {
    ticket = {
      ...ticket,
      ticketReference: changedReference,
      workItems: ticket.workItems.map((item) => ({
        ...item,
        ticketReference: changedReference,
      })),
    };
    action = { ...action, ticketReference: changedReference };
    audit = { ...audit, targetId: changedReference };
    event = {
      ...event,
      aggregateId: changedReference,
      payload: { ...event.payload, kitchenTicketReference: changedReference },
    };
  } else if (purpose === "KitchenWorkItem") {
    ticket = {
      ...ticket,
      workItems: ticket.workItems.map((item, index) =>
        index === 0 ? { ...item, workItemReference: changedReference } : item,
      ),
    };
  } else if (purpose === "KitchenCreationAction") {
    action = { ...action, actionReference: changedReference };
  } else if (purpose === "KitchenCreationAudit") {
    audit = { ...audit, auditId: changedReference };
  } else {
    event = { ...event, eventId: changedReference };
  }
  return resignEffect({ receipt: effect.receipt, ticket, action, audit, event });
}

describe("WP-1401 Kitchen Ticket aggregate", () => {
  it("creates one immutable Open Ticket and one Queued item with exact receipt/source/plan anchors", async () => {
    const input = receipt();
    const test = harness(input);
    const result = await test.service.create({ receipt: input, transaction });
    const effect = test.durable();

    expect(result).toEqual({
      status: "Created",
      receipt: input,
      ticketReference: effect?.ticket.ticketReference,
      workItemCount: 1,
    });
    expect(effect?.ticket).toMatchObject({
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      orderReference: input.orderReference,
      orderBatchReference: input.orderBatchReference,
      confirmationReference: input.confirmationReference,
      sourceEventReference: input.sourceEventReference,
      sourceAggregateVersion: input.sourceAggregateVersion,
      sourceSnapshotDigest: input.sourceSnapshotDigest,
      consumerName: input.consumerName,
      consumerVersion: input.consumerVersion,
      confirmedAt: input.confirmedAt,
      correlationReference: input.correlationReference,
      semanticEventBindingDigest: input.semanticEventBindingDigest,
      aggregateVersion: 1n,
      status: "Open",
      createdAt: at.created,
    });
    expect(effect?.ticket.workItems).toHaveLength(1);
    expect(effect?.ticket.workItems[0]).toMatchObject({
      sourceOrdinal: 1,
      splitOrdinal: 1,
      requiredQuantity: 2,
      completedQuantity: 0,
      status: "Queued",
      customerNote: "Synthetic: sauce on side",
      createdAt: at.created,
    });
    const sourceItem = sourceFor(input).items[0];
    const workItem = effect?.ticket.workItems[0];
    if (sourceItem === undefined || workItem === undefined) throw new Error("effect item missing");
    expect(workItem.executionSnapshotDigest).toBe(
      sha256(
        createKitchenExecutionSnapshotDigestBinding(sourceItem, {
          orderItemReference: workItem.orderItemReference,
          splitOrdinal: workItem.splitOrdinal,
          stationRouting: workItem.stationRouting,
          preparation: workItem.preparation,
        }),
      ),
    );
    expect(Object.isFrozen(effect)).toBe(true);
    expect(Object.isFrozen(effect?.ticket)).toBe(true);
    expect(Object.isFrozen(effect?.ticket.workItems)).toBe(true);
    expect(Object.isFrozen(effect?.ticket.workItems[0]?.preparation.instructions)).toBe(true);
    expect(test.calls).toEqual({ source: 1, plan: 1, clock: 1, resolve: 1, commit: 1 });
  });

  it("composes the real deterministic planner into WP-1401 and replays durably with zero plan dependency", async () => {
    const input = receipt();
    const planner = realPlanner();
    const test = harness(input, { resolvePlan: planner.resolve });
    const result = await test.service.create({ receipt: input, transaction });
    const effect = test.durable();
    const item = effect?.ticket.workItems[0];

    expect(result.status).toBe("Created");
    expect(effect?.ticket).toMatchObject({
      planReference: id(405),
      planVersion: 1,
      planGeneratedAt: input.confirmedAt,
      sourceEvidenceDigest: sourceFor(input).evidenceDigest,
    });
    expect(item?.stationRouting).toEqual({
      stationReference: id(400),
      routingRuleReference: id(401),
      routingRuleVersion: 5,
      routingRuleDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(item?.preparation).toEqual({
      preparationReference: id(420),
      preparationVersion: 11,
      preparationDigest: sha256("opaque-Recipe-preparation-0"),
      instructions: ["Prepare synthetic execution", "Plate synthetic execution"],
    });
    expect(planner.calls).toMatchObject({
      station: 1,
      stationSourceReads: 1,
      preparation: 1,
      preparationSourceReads: 1,
      reference: 1,
      digest: 4,
    });
    expect(JSON.stringify(planner.calls.stationRequests)).not.toMatch(
      /customerNote|localizedDisplayNames|correlationReference|sourceSnapshotDigest/u,
    );
    expect(JSON.stringify(planner.calls.preparationRequests)).not.toMatch(
      /customerNote|localizedDisplayNames|correlationReference|sourceSnapshotDigest/u,
    );

    if (effect === undefined) throw new Error("fixture effect missing");
    const replayPlanner = realPlanner({ stationOutcome: "Throw", preparationOutcome: "Throw" });
    const replay = harness(input, {
      initialEffect: effect,
      resolvePlan: replayPlanner.resolve,
    });
    const replayResult = await replay.service.create({ receipt: input, transaction });
    expect(replayResult.status).toBe("AlreadyCreated");
    expect(replay.durable()).toBe(effect);
    expect(replay.calls).toEqual({ source: 0, plan: 0, clock: 0, resolve: 1, commit: 0 });
    expect(replayPlanner.calls).toEqual({
      station: 0,
      stationSourceReads: 0,
      preparation: 0,
      preparationSourceReads: 0,
      reference: 0,
      digest: 0,
      stationRequests: [],
      preparationRequests: [],
    });
  });

  it("maps real-planner owner denial, owner failure and ambiguity to zero durable WP-1401 effect", async () => {
    const scenarios: readonly {
      readonly name: string;
      readonly options: RealPlannerOptions;
      readonly expected: Partial<ReturnType<typeof realPlanner>["calls"]>;
    }[] = [
      {
        name: "Station deny",
        options: { stationOutcome: "Deny" },
        expected: { station: 1, stationSourceReads: 0, preparation: 0 },
      },
      {
        name: "Recipe deny",
        options: { preparationOutcome: "Deny" },
        expected: {
          station: 1,
          stationSourceReads: 1,
          preparation: 1,
          preparationSourceReads: 0,
        },
      },
      {
        name: "Station throw",
        options: { stationOutcome: "Throw" },
        expected: { station: 1, stationSourceReads: 0, preparation: 0 },
      },
      {
        name: "Recipe throw",
        options: { preparationOutcome: "Throw" },
        expected: {
          station: 1,
          stationSourceReads: 1,
          preparation: 1,
          preparationSourceReads: 0,
        },
      },
      {
        name: "ambiguous routing",
        options: { stationOutcome: "Ambiguous" },
        expected: { station: 1, stationSourceReads: 1, preparation: 0 },
      },
    ];

    for (const scenario of scenarios) {
      const input = receipt();
      const planner = realPlanner(scenario.options);
      const test = harness(input, { resolvePlan: planner.resolve });
      const promise = test.service.create({ receipt: input, transaction });
      await expect(promise, scenario.name).rejects.toSatisfy(
        (error: unknown) =>
          code(error) === "KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE" &&
          (error as Error).message === "kitchen ticket creation is unavailable" &&
          !String(error).includes("private"),
      );
      expect(test.durable(), scenario.name).toBeUndefined();
      expect(test.calls.clock, scenario.name).toBe(0);
      expect(test.calls.commit, scenario.name).toBe(0);
      expect(planner.calls, scenario.name).toMatchObject(scenario.expected);
      expect(planner.calls.reference, scenario.name).toBe(0);
    }
  });

  it("passes only a strict note-free evidence projection to the execution-plan port", async () => {
    const input = receipt();
    let observed: KitchenPlanningSource | undefined;
    const test = harness(input, {
      observePlanningSource: (source) => {
        observed = source;
      },
    });
    await test.service.create({ receipt: input, transaction });
    expect(Reflect.ownKeys(observed ?? {})).toEqual([
      "brandReference",
      "storeReference",
      "orderReference",
      "orderBatchReference",
      "confirmationReference",
      "sourceEvidenceReference",
      "sourceEvidenceVersion",
      "sourceEvidenceDigest",
      "items",
    ]);
    expect(Reflect.ownKeys(observed?.items[0] ?? {})).toEqual([
      "orderItemReference",
      "ordinal",
      "quantity",
      "productReference",
      "productVersionReference",
      "skuReference",
      "menuVersionReference",
      "selectedOptions",
      "sourceLineDigest",
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/note|name|health|allerg|instruction/iu);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.items)).toBe(true);
    expect(Object.isFrozen(observed?.items[0]?.selectedOptions)).toBe(true);

    const withProducerDigest = harness(input, {
      mutatePlan: (plan) => ({
        ...plan,
        items: plan.items.map((item) => ({
          ...item,
          executionSnapshotDigest: sha256("producer-must-not-own-final-digest"),
        })),
      }),
    });
    await expect(
      withProducerDigest.service.create({ receipt: input, transaction }),
    ).rejects.toSatisfy((error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT");
    expect(withProducerDigest.calls.clock).toBe(0);
  });

  it("persists descriptor-safe Audit and minimal causally exact Outbox content with no note narrative", async () => {
    const input = receipt();
    const test = harness(input);
    await test.service.create({ receipt: input, transaction });
    const effect = test.durable();
    if (effect === undefined) throw new Error("fixture effect missing");
    expect(effect.action).toEqual({
      actionReference: effect.action.actionReference,
      actionVersion: 1,
      actionCode: "KITCHEN_TICKET_CREATED",
      purpose: "CREATE_KITCHEN_TICKET",
      reasonCode: "ORDER_CONFIRMED",
      actorType: "System",
      actorReference: null,
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      ticketReference: effect.ticket.ticketReference,
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      sourceEventReference: input.sourceEventReference,
      correlationReference: input.correlationReference,
      workItemCount: 1,
      occurredAt: at.created,
    });
    expect(effect.audit).toEqual({
      auditId: effect.audit.auditId,
      brandId: input.brandReference,
      storeId: input.storeReference,
      actor: { type: "System" },
      actionCode: "KITCHEN_TICKET_CREATED",
      targetType: "KitchenTicket",
      targetId: effect.ticket.ticketReference,
      afterSummary: { status: "Open", workItemCount: 1 },
      reasonCode: "ORDER_CONFIRMED",
      correlationId: input.correlationReference,
      occurredAt: at.created,
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
      retentionPolicyVersion: 1,
    });
    expect(effect.event).toMatchObject({
      eventType: "KitchenWorkCreated",
      schemaVersion: 1,
      producerModule: "@rms/kitchen",
      aggregateType: "KitchenTicket",
      aggregateId: effect.ticket.ticketReference,
      aggregateVersion: 1n,
      correlationId: input.correlationReference,
      causationId: input.sourceEventReference,
      redactionClassification: "indirect_identifier",
      payload: {
        kitchenTicketReference: effect.ticket.ticketReference,
        orderReference: input.orderReference,
        orderBatchReference: input.orderBatchReference,
        confirmationReference: input.confirmationReference,
        workItemCount: 1,
        aggregateVersion: 1,
        createdAt: at.created,
      },
    });
    const publicEvidence = JSON.stringify(
      { audit: effect?.audit, event: effect?.event },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(publicEvidence).not.toMatch(
      /sauce|Synthetic noodle|station|preparation|health|allerg|money|payment|provider/iu,
    );
  });

  it("returns the exact original effect for same-Event replay without source, plan, clock or second commit", async () => {
    const input = receipt();
    const first = harness(input);
    await first.service.create({ receipt: input, transaction });
    const replay = harness(input, { initialEffect: first.durable() });
    const result = await replay.service.create({ receipt: input, transaction });
    expect(result.status).toBe("AlreadyCreated");
    expect(result.receipt).toEqual(input);
    expect(replay.calls).toEqual({ source: 0, plan: 0, clock: 0, resolve: 1, commit: 0 });
  });

  it("returns the original source Event for semantic replay under a new Event ID", async () => {
    const original = receipt();
    const first = harness(original);
    await first.service.create({ receipt: original, transaction });
    const redelivery = receipt({ sourceEventReference: id(99) });
    const replay = harness(redelivery, { initialEffect: first.durable() });
    const result = await replay.service.create({ receipt: redelivery, transaction });
    expect(result.status).toBe("AlreadyCreated");
    expect(result.receipt.sourceEventReference).toBe(original.sourceEventReference);
    expect(replay.calls.source).toBe(0);
  });

  it("adopts only the original complete effect when a different semantic Event loses the commit race", async () => {
    const original = receipt();
    const first = harness(original);
    await first.service.create({ receipt: original, transaction });
    const redelivery = receipt({ sourceEventReference: id(99) });
    const loser = harness(redelivery, {
      initialEffect: first.durable(),
      hideFirstResolution: true,
      now: at.later,
      mutateSource: (source) =>
        changeSource(source, {
          evidenceReference: id(70),
          capturedAt: "2026-08-08T15:59:58.000Z",
        }),
      mutatePlan: (plan) =>
        changePlan(plan, {
          planReference: id(71),
          generatedAt: "2026-08-08T16:00:01.500Z",
        }),
    });
    const result = await loser.service.create({ receipt: redelivery, transaction });
    expect(result.status).toBe("AlreadyCreated");
    expect(result.receipt.sourceEventReference).toBe(original.sourceEventReference);
    expect(loser.calls).toEqual({ source: 1, plan: 1, clock: 1, resolve: 1, commit: 1 });
  });

  it("adopts the original creation time when the same Event loses a concurrent commit race", async () => {
    const input = receipt();
    const first = harness(input);
    await first.service.create({ receipt: input, transaction });
    const loser = harness(input, {
      initialEffect: first.durable(),
      hideFirstResolution: true,
      now: at.later,
    });
    const result = await loser.service.create({ receipt: input, transaction });
    expect(result.status).toBe("AlreadyCreated");
    expect(loser.durable()?.ticket.createdAt).toBe(at.created);
    expect(loser.calls).toEqual({ source: 1, plan: 1, clock: 1, resolve: 1, commit: 1 });
  });

  it("recovers a semantically equivalent different-Event commit-unknown outcome through permanent keys", async () => {
    const original = receipt();
    const first = harness(original);
    await first.service.create({ receipt: original, transaction });
    const redelivery = receipt({ sourceEventReference: id(99) });
    const test = harness(redelivery, {
      initialEffect: first.durable(),
      hideFirstResolution: true,
      throwOnCommit: true,
      now: at.later,
    });
    const result = await test.service.create({ receipt: redelivery, transaction });
    expect(result.status).toBe("AlreadyCreated");
    expect(result.receipt.sourceEventReference).toBe(original.sourceEventReference);
    expect(test.calls.resolve).toBe(2);
  });

  it("rejects concurrent same- or different-Event attempts with changed source or execution content", async () => {
    const original = receipt();
    const first = harness(original);
    await first.service.create({ receipt: original, transaction });
    const redelivery = receipt({ sourceEventReference: id(99) });
    const cases = [
      {
        input: original,
        test: harness(original, {
          initialEffect: first.durable(),
          hideFirstResolution: true,
          mutateSource: (source) => changeSource(source, { quantity: 3 }),
        }),
      },
      {
        input: original,
        test: harness(original, {
          initialEffect: first.durable(),
          hideFirstResolution: true,
          mutateSource: (source) =>
            changeSource(source, { customerNote: "Synthetic:  sauce on side" }),
        }),
      },
      {
        input: original,
        test: harness(original, {
          initialEffect: first.durable(),
          hideFirstResolution: true,
          mutatePlan: (plan) => changePlan(plan, { stationReference: id(72) }),
        }),
      },
      {
        input: redelivery,
        test: harness(redelivery, {
          initialEffect: first.durable(),
          hideFirstResolution: true,
          mutateSource: (source) => changeSource(source, { quantity: 3 }),
        }),
      },
    ];
    for (const scenario of cases) {
      await expect(
        scenario.test.service.create({ receipt: scenario.input, transaction }),
      ).rejects.toSatisfy((error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT");
    }
  });

  it("recovers an exact commit-unknown creation without a second effect", async () => {
    const input = receipt();
    const test = harness(input, { commitUnknown: true });
    const result = await test.service.create({ receipt: input, transaction });
    expect(result.status).toBe("AlreadyCreated");
    expect(test.calls).toEqual({ source: 1, plan: 1, clock: 1, resolve: 2, commit: 1 });
    expect(test.durable()).toBeDefined();
  });

  it("rejects a different-Event race when correlation or immutable snapshot digest changed", async () => {
    const original = receipt();
    const first = harness(original);
    await first.service.create({ receipt: original, transaction });
    for (const changed of [
      receipt({ sourceEventReference: id(99), correlationReference: id(100) }),
      receipt({ sourceEventReference: id(99), sourceSnapshotDigest: sha256("changed") }),
    ]) {
      const test = harness(changed, {
        initialEffect: first.durable(),
        hideFirstResolution: true,
      });
      await expect(test.service.create({ receipt: changed, transaction })).rejects.toSatisfy(
        (error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT",
      );
    }
  });

  it("fails closed before plan/time/mutation for changed Ordering evidence", async () => {
    const input = receipt();
    const test = harness(input, {
      mutateSource: (source) => ({ ...source, storeReference: id(300) }),
    });
    await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT",
    );
    expect(test.calls).toEqual({ source: 1, plan: 0, clock: 0, resolve: 1, commit: 0 });
    expect(test.durable()).toBeUndefined();
  });

  it("fails closed before time/mutation for missing, incomplete or changed plans", async () => {
    const input = receipt();
    const cases = [
      harness(input, { mutatePlan: () => null }),
      harness(input, { mutatePlan: (plan) => ({ ...plan, items: [] }) }),
      harness(input, {
        mutatePlan: (plan) => ({ ...plan, sourceEvidenceDigest: sha256("other-evidence") }),
      }),
    ];
    for (const test of cases) {
      await expect(test.service.create({ receipt: input, transaction })).rejects.toBeInstanceOf(
        Error,
      );
      expect(test.calls.clock).toBe(0);
      expect(test.calls.commit).toBe(0);
      expect(test.durable()).toBeUndefined();
    }
  });

  it("rejects a correctly re-digested plan generated before the confirmed source fact", async () => {
    const input = receipt();
    const test = harness(input, {
      mutatePlan: (plan) => changePlan(plan, { generatedAt: "2026-08-08T15:59:59.500Z" }),
    });
    await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT",
    );
    expect(test.calls.clock).toBe(0);
    expect(test.calls.commit).toBe(0);
  });

  it("maps a split permanent-key repository resolution to conflict before dependencies", async () => {
    const input = receipt();
    const test = harness(input, { resolveConflict: true });
    await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT",
    );
    expect(test.calls).toEqual({ source: 0, plan: 0, clock: 0, resolve: 1, commit: 0 });
  });

  it("rejects a repository response whose status changes between descriptor snapshots", async () => {
    const input = receipt();
    const test = harness(input, { resolveStatusFlip: true });
    await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE",
    );
    expect(test.calls).toEqual({ source: 0, plan: 0, clock: 0, resolve: 1, commit: 0 });
  });

  it("rolls back the complete synthetic effect when mandatory Audit or Outbox persistence fails", async () => {
    for (const test of [
      harness(receipt(), { failAudit: true }),
      harness(receipt(), { failOutbox: true }),
    ]) {
      await expect(test.service.create({ receipt: receipt(), transaction })).rejects.toSatisfy(
        (error: unknown) => code(error) === "KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE",
      );
      expect(test.durable()).toBeUndefined();
      expect(test.calls.resolve).toBe(2);
    }
  });

  it("rejects reference derivation collisions across Ticket, items, action, Audit and Event", async () => {
    const input = receipt();
    const test = harness(input, { collideReferences: true });
    await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE",
    );
    expect(test.calls.commit).toBe(0);
    expect(test.durable()).toBeUndefined();
  });

  it("rejects every generated local reference when it collides with an input reference", async () => {
    const purposes: readonly KitchenStableReferencePurpose[] = [
      "KitchenTicket",
      "KitchenWorkItem",
      "KitchenCreationAction",
      "KitchenCreationAudit",
      "KitchenWorkCreatedEvent",
    ];
    for (const purpose of purposes) {
      const input = receipt();
      const test = harness(input, { collideWithInput: purpose });
      await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
        (error: unknown) => code(error) === "KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE",
      );
      expect(test.calls.commit).toBe(0);
    }
  });

  it("rejects malformed or re-signed arbitrary stable references in stored effects as permanent conflicts", async () => {
    const input = receipt();
    const first = harness(input);
    await first.service.create({ receipt: input, transaction });
    const effect = first.durable();
    if (effect === undefined) throw new Error("fixture effect missing");
    const purposes: readonly KitchenStableReferencePurpose[] = [
      "KitchenTicket",
      "KitchenWorkItem",
      "KitchenCreationAction",
      "KitchenCreationAudit",
      "KitchenWorkCreatedEvent",
    ];
    const malformed = [
      { ...effect, effectDigest: sha256("wrong-effect") },
      {
        ...effect,
        ticket: { ...effect.ticket, extra: true },
      } as unknown as KitchenTicketCreationEffect,
      ...purposes.map((purpose) => tamperStableReference(effect, purpose)),
    ];
    for (const stored of malformed) {
      const test = harness(input, { initialEffect: stored });
      await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
        (error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT",
      );
      expect(test.calls).toEqual({ source: 0, plan: 0, clock: 0, resolve: 1, commit: 0 });
    }
  });

  it("recomputes every stored source, plan and execution digest before adopting a re-signed effect", async () => {
    const input = receipt();
    const first = harness(input);
    await first.service.create({ receipt: input, transaction });
    const effect = first.durable();
    const item = effect?.ticket.workItems[0];
    if (effect === undefined || item === undefined) throw new Error("fixture effect missing");
    const replaceItem = (replacement: typeof item) =>
      resignEffect({
        receipt: effect.receipt,
        ticket: { ...effect.ticket, workItems: [replacement] },
        action: effect.action,
        audit: effect.audit,
        event: effect.event,
      });
    const changed = [
      replaceItem({ ...item, customerNote: "Synthetic: changed note" }),
      replaceItem({
        ...item,
        localizedDisplayNames: { ...item.localizedDisplayNames, "en-CA": "Changed display" },
      }),
      replaceItem({ ...item, requiredQuantity: 3 }),
      replaceItem({
        ...item,
        stationRouting: {
          ...item.stationRouting,
          stationReference: parseKitchenTicketReference(id(710)),
        },
      }),
      replaceItem({
        ...item,
        preparation: {
          ...item.preparation,
          instructions: ["Changed preparation"],
        },
      }),
      replaceItem({
        ...item,
        executionSnapshotDigest: parseKitchenTicketDigest(sha256("changed-execution")),
      }),
      resignEffect({
        receipt: effect.receipt,
        ticket: {
          ...effect.ticket,
          planGeneratedAt: parseKitchenTicketInstant("2026-08-08T15:59:59.500Z"),
        },
        action: effect.action,
        audit: effect.audit,
        event: effect.event,
      }),
      resignEffect({
        receipt: effect.receipt,
        ticket: effect.ticket,
        action: effect.action,
        audit: effect.audit,
        event: {
          ...effect.event,
          occurredAt: parseKitchenTicketInstant(at.later),
          payload: {
            ...effect.event.payload,
            createdAt: parseKitchenTicketInstant(at.later),
          },
        },
      }),
    ];
    for (const stored of changed) {
      const test = harness(input, { initialEffect: stored });
      await expect(test.service.create({ receipt: input, transaction })).rejects.toSatisfy(
        (error: unknown) => code(error) === "KITCHEN_TICKET_CONFLICT",
      );
      expect(test.calls.source).toBe(0);
      expect(test.calls.plan).toBe(0);
      expect(test.calls.clock).toBe(0);
    }
  });

  it("implements the existing WP-1400 intake port and maps its original bounded result", async () => {
    const input = receipt();
    const test = harness(input);
    expect(
      await test.adapter.resolveByIdentity({
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        sourceEventReference: input.sourceEventReference,
        confirmationReference: input.confirmationReference,
        orderBatchReference: input.orderBatchReference,
        transaction,
      }),
    ).toEqual({ status: "NotFound" });
    expect(await test.adapter.accept({ receipt: input, transaction })).toEqual({
      status: "Created",
      receipt: input,
    });
    expect(
      await test.adapter.resolveByIdentity({
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        sourceEventReference: input.sourceEventReference,
        confirmationReference: input.confirmationReference,
        orderBatchReference: input.orderBatchReference,
        transaction,
      }),
    ).toEqual({ status: "Resolved", receipt: input });
  });

  it("strictly rejects getters, symbols, custom prototypes and malformed Unicode without executing accessors", () => {
    const input = receipt();
    const source = sourceFor(input);
    const planningSource = planningSourceFor(source);
    const plan = planFor(planningSource, input);
    let getterCalls = 0;
    const withGetter = { ...plan };
    Object.defineProperty(withGetter, "planReference", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return id(33);
      },
    });
    expect(() => parseKitchenWorkPlan(withGetter)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() => parseKitchenWorkPlan({ ...plan, [Symbol("extra")]: true })).toThrow();
    expect(() => parseKitchenWorkPlan(Object.assign(Object.create(null), plan))).toThrow();
    expect(() =>
      parseKitchenPlanningSource({ ...planningSource, customerNote: "must not cross boundary" }),
    ).toThrow();
    expect(() => parseKitchenCustomerNote("bad\ud800text")).toThrow();
    expect(() =>
      parseKitchenWorkPlan({
        ...plan,
        items: [
          {
            ...plan.items[0],
            preparation: { ...plan.items[0]?.preparation, instructions: ["bad\ud800"] },
          },
        ],
      }),
    ).toThrow();
  });

  it("strictly parses and freezes Ticket, creation action and result without executing accessors", async () => {
    const input = receipt();
    const test = harness(input);
    const result = await test.service.create({ receipt: input, transaction });
    const effect = test.durable();
    if (effect === undefined) throw new Error("fixture effect missing");
    const contracts: readonly {
      readonly value: object;
      readonly parse: (value: unknown) => object;
      readonly nestedFrozen: (parsed: object) => boolean;
    }[] = [
      {
        value: effect.ticket,
        parse: parseKitchenTicket,
        nestedFrozen: (parsed) => {
          const ticket = parsed as typeof effect.ticket;
          return (
            Object.isFrozen(ticket.workItems) &&
            Object.isFrozen(ticket.workItems[0]) &&
            Object.isFrozen(ticket.workItems[0]?.localizedDisplayNames) &&
            Object.isFrozen(ticket.workItems[0]?.selectedOptions) &&
            Object.isFrozen(ticket.workItems[0]?.preparation.instructions)
          );
        },
      },
      {
        value: effect.action,
        parse: parseKitchenTicketCreationAction,
        nestedFrozen: () => true,
      },
      {
        value: result,
        parse: parseKitchenTicketCreationResult,
        nestedFrozen: (parsed) =>
          Object.isFrozen((parsed as ReturnType<typeof parseKitchenTicketCreationResult>).receipt),
      },
    ];

    for (const contract of contracts) {
      const parsed = contract.parse(contract.value);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(contract.nestedFrozen(parsed)).toBe(true);
      expect(() => contract.parse({ ...contract.value, extra: true })).toThrow();
      expect(() => contract.parse({ ...contract.value, [Symbol("extra")]: true })).toThrow();
      expect(() => contract.parse(Object.assign(Object.create(null), contract.value))).toThrow();

      const field = Object.keys(contract.value)[0];
      if (field === undefined) throw new Error("fixture field missing");
      let getterCalls = 0;
      const withGetter = { ...contract.value };
      Object.defineProperty(withGetter, field, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return undefined;
        },
      });
      expect(() => contract.parse(withGetter)).toThrow();
      expect(getterCalls).toBe(0);
    }
  });

  it("normalizes and bounds possible-health Customer notes without treating them as safety approval", () => {
    expect(parseKitchenCustomerNote("  Cafe\u0301\nSynthetic note  ")).toBe("Café\nSynthetic note");
    expect(() => parseKitchenCustomerNote("a\n b\n c\n d\n e")).toThrow();
    expect(() => parseKitchenCustomerNote(`safe\u202eunsafe`)).toThrow();
    expect(() => parseKitchenCustomerNote("safe\t")).toThrow();
    expect(() => parseKitchenCustomerNote("safe\r")).toThrow();
    expect(() => parseKitchenCustomerNote("safe\u2029")).toThrow();
    expect(() => parseKitchenCustomerNote("x".repeat(241))).toThrow();
  });
});
