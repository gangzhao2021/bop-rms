import { canonicalizeRfc8785, sha256Hex, type AppendAuditRecordInput } from "@bop/audit";
import { createPostgresWorkflowDefinitionStore } from "@bop/workflow";
import {
  createInventoryReservation,
  createInventoryRecipeLineDemandSource,
  createPostgresInventoryItemStore,
  createPostgresSubmissionStockPlanSource,
  createPostgresSubmissionReservationStore,
  createPostgresSubmissionFinalValidationStore,
  parseInventoryReference,
  parseSubmissionInventoryFinalValidation,
  type InventoryItemTransaction,
  type InventoryReservationSet,
  type SubmissionExpiryCutoff,
  type SubmissionInventoryDemand,
  type StockReservationWrite,
} from "@rms/inventory";
import {
  parseOrderingReference,
  parseOrderingInstant,
  parseCartAggregate,
  parseAdditionalDiningBatchSnapshot,
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
  type OrderSubmissionInventoryFinalizer,
} from "@rms/ordering";
import {
  CustomerInventorySourceError,
  createCustomerSubmissionInventorySource,
} from "./customer-submission-inventory-source.js";
import {
  createCustomerSubmissionFinalInventorySource,
  type CustomerInventoryWorkflowGates,
} from "./customer-submission-inventory-workflow-source.js";

export interface CustomerSubmissionInventoryFinalizerOptions {
  readonly scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
  }>;
  /** Explicit configured site and Workflow adapter codes; no inferred Store defaults. */
  readonly stockSiteReference: string;
  readonly workflow: Readonly<{
    purposeCode: string;
    applicabilityCode: string;
    currentState: string;
    action: string;
    reserveCommandCode: string;
    deferredActionCode: string | null;
    gates: CustomerInventoryWorkflowGates;
  }>;
  readonly authorize: (
    transaction: InventoryItemTransaction,
    input: Readonly<{ submissionReference: string; actorReference: string }>,
  ) => Promise<boolean>;
  readonly resolveExpiryCutoff: SubmissionExpiryCutoff;
  readonly generateReference: (
    purpose:
      | "Demand"
      | "Validation"
      | "Operation"
      | "Audit"
      | "Reservation"
      | "Movement"
      | "ReservationSet",
  ) => string;
  readonly audit: Readonly<
    Pick<
      AppendAuditRecordInput,
      "reasonCode" | "sourceChannel" | "retentionPolicyCode" | "retentionPolicyVersion"
    >
  >;
}
const fail = (): never => {
  throw new CustomerInventorySourceError();
};

/**
 * Invoke only at Ordering's locked, current-authorized write boundary. All owner calls use its
 * transaction, including reservations and Audit; this capability never commits independently.
 * Workflow/resource gates and configured site must come from actual authorized Store sources.
 */
type InitialInput<V extends 1 | 2> = Parameters<
  OrderSubmissionInventoryFinalizer<V>["finalize"]
>[0];
type BatchInventoryInput<V extends 1 | 2> = Omit<InitialInput<V>, "record"> & {
  record: Pick<
    InitialInput<V>["record"],
    "submissionReference" | "guestSessionReference" | "items"
  > & {
    order: Pick<
      InitialInput<V>["record"]["order"],
      "brandReference" | "storeReference" | "orderReference" | "submittedByActorReference"
    >;
  };
};

export function createCustomerSubmissionInventoryFinalizer<V extends 1 | 2>(
  options: CustomerSubmissionInventoryFinalizerOptions,
): OrderSubmissionInventoryFinalizer<V> {
  return createBatchInventoryFinalizer<V>(options);
}

/** Additional submission uses the same real owner workflow/reservation/final
 * validation pipeline, with only actual Batch identity fields. No synthetic
 * initial Order aggregate, number or canonical version is constructed.
 */
export function createCustomerAdditionalDiningInventoryFinalizer(
  options: CustomerSubmissionInventoryFinalizerOptions,
) {
  const core = createBatchInventoryFinalizer<1 | 2>(options);
  return Object.freeze({
    async finalize(input: {
      transaction: InitialInput<1 | 2>["transaction"];
      snapshot: unknown;
      cart: unknown;
      checkoutValidationEvidence: unknown;
      observedAt: string;
    }) {
      const snapshot = parseAdditionalDiningBatchSnapshot(input.snapshot);
      const cart = parseCartAggregate(input.cart);
      const evidence = (
        snapshot.snapshotVersion === 2
          ? parseConfiguredCheckoutValidationEvidence
          : parseCheckoutValidationEvidence
      )(input.checkoutValidationEvidence);
      if (
        cart.orderType !== "DineIn" ||
        cart.diningSessionReference !== snapshot.diningSessionReference ||
        cart.cartReference !== snapshot.batch.sourceCartReference ||
        cart.aggregateVersion !== snapshot.batch.sourceCartVersion ||
        evidence.validationReference !== snapshot.batch.checkoutValidationReference ||
        evidence.quoteReference !== snapshot.batch.quoteReference
      )
        return fail();
      return core.finalize({
        transaction: input.transaction,
        cart,
        checkoutValidationEvidence: evidence,
        observedAt: parseOrderingInstant(input.observedAt),
        record: {
          submissionReference: snapshot.batch.submissionReference,
          guestSessionReference: snapshot.guestSessionReference,
          items: snapshot.items,
          order: {
            brandReference: snapshot.brandReference,
            storeReference: snapshot.storeReference,
            orderReference: snapshot.orderReference,
            submittedByActorReference: snapshot.batch.submittedByActorReference,
          },
        },
      });
    },
  });
}
function createBatchInventoryFinalizer<V extends 1 | 2>(
  options: CustomerSubmissionInventoryFinalizerOptions,
) {
  const scope = Object.freeze({
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const site = parseInventoryReference(options.stockSiteReference);
  const configuration = Object.freeze({
    ...options.workflow,
    gates: Object.freeze({ ...options.workflow.gates }),
  });
  const { authorize, generateReference, resolveExpiryCutoff } = options;
  const auditMetadata = Object.freeze({ ...options.audit });
  return Object.freeze({
    async finalize(input: BatchInventoryInput<V>) {
      try {
        const { transaction: tx, cart, observedAt } = input;
        const order = input.record;
        const checkout = input.checkoutValidationEvidence;
        if (
          cart.brandReference !== scope.brandReference ||
          cart.storeReference !== scope.storeReference ||
          order.order.brandReference !== scope.brandReference ||
          order.order.storeReference !== scope.storeReference ||
          checkout.cartReference !== cart.cartReference ||
          checkout.cartVersion !== cart.aggregateVersion ||
          checkout.guestSessionReference !== order.guestSessionReference
        )
          return fail();
        const actor = String(order.order.submittedByActorReference);
        const authorization = Object.freeze({
          submissionReference: String(order.submissionReference),
          actorReference: actor,
        });
        if ((await authorize(tx, authorization)) !== true) return fail();
        const generated = new Set<string>();
        const next = (purpose: Parameters<typeof generateReference>[0]) => {
          const reference = parseInventoryReference(generateReference(purpose));
          if (generated.has(reference)) return fail();
          generated.add(reference);
          return reference;
        };
        const bound = {
          run: async <T>(work: (transaction: InventoryItemTransaction) => Promise<T>) => work(tx),
        };
        const workflow = createPostgresWorkflowDefinitionStore(bound, scope);
        const current = await workflow.resolveCurrent({
          purposeCode: configuration.purposeCode,
          applicabilityCode: configuration.applicabilityCode,
          observedAt,
        });
        const request = Object.freeze({
          ...scope,
          actorReference: actor,
          resourceReference: cart.cartReference,
          resourceVersion: cart.aggregateVersion,
          purposeCode: configuration.purposeCode,
          applicabilityCode: configuration.applicabilityCode,
          expectedVersionReference: current.definition.versionReference,
          currentState: configuration.currentState,
          action: configuration.action,
          observedAt,
        });
        const evaluated = await workflow.evaluatePublishedAction(request, configuration.gates);
        const reserveNow = evaluated.transition.effects.some(
          (effect) =>
            effect.ownerModule === "inventory" &&
            effect.commandCode === configuration.reserveCommandCode,
        );
        const ordering = Object.freeze({
          cart,
          lines: Object.freeze(
            order.items.map((item) =>
              Object.freeze({
                cartItemReference: item.cartItemReference,
                catalog: item.catalog,
                pricing: item.pricing,
              }),
            ),
          ),
        });
        const recipe = await createCustomerSubmissionInventorySource(tx, scope).resolve({
          ...ordering,
          observedAt,
        });
        const demand: SubmissionInventoryDemand = Object.freeze({
          ...scope,
          stockSiteReference: site,
          submissionReference: String(order.submissionReference),
          cartReference: String(cart.cartReference),
          cartVersion: cart.aggregateVersion,
          quoteReference: String(checkout.quoteReference),
          demandReference: next("Demand"),
          workflowReference: evaluated.definition.workflowReference,
          workflowVersion: evaluated.definition.versionNumber,
          reserveTrigger: "OrderSubmission",
          sourceDigest: recipe.sourceDigest,
          contributions: recipe.contributions,
        });
        const demandDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(demand));
        const plan = reserveNow
          ? await createPostgresSubmissionStockPlanSource(bound, scope, {
              resolveExpiryCutoff,
            }).resolve(demand, observedAt)
          : null;
        const requirements =
          plan?.requirements ??
          (
            await createInventoryRecipeLineDemandSource(
              createPostgresInventoryItemStore(bound, {
                tenantReference: scope.tenantReference,
                brandReference: scope.brandReference,
              }),
              scope,
            ).resolve(recipe.contributions, observedAt)
          ).requirements;
        const makeAudit = (
          auditId: string,
          actionCode: string,
          targetType: string,
          targetId: string,
          operation: string,
        ): AppendAuditRecordInput => ({
          ...auditMetadata,
          auditId,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actor },
          actionCode,
          targetType,
          targetId,
          correlationId: operation,
          occurredAt: observedAt,
          dataClassification: "Internal",
        });
        let reservationSet: InventoryReservationSet | null = null;
        if (plan !== null && plan.allocations.length > 0) {
          const setReference = next("ReservationSet");
          const operationReference = next("Operation");
          const writes: StockReservationWrite[] = plan.allocations.map((allocation) => {
            const reservationReference = next("Reservation");
            const operation = next("Operation");
            return Object.freeze({
              operationReference: operation,
              accountReference: allocation.accountReference,
              action: "Reserve" as const,
              expectedLedgerVersion: allocation.expectedLedgerVersion,
              quantity: allocation.quantity,
              movementReference: next("Movement"),
              reservation: createInventoryReservation({
                reservationReference,
                unit: allocation.unit,
                quantity: allocation.quantity,
                occurredAt: observedAt,
                binding: {
                  ...scope,
                  stockSiteReference: site,
                  locationReference: allocation.locationReference,
                  itemReference: allocation.itemReference,
                  lotReference: allocation.lotReference,
                  submissionReference: order.submissionReference,
                  cartReference: cart.cartReference,
                  cartVersion: cart.aggregateVersion,
                  quoteReference: checkout.quoteReference,
                  demandReference: demand.demandReference,
                  demandDigest,
                  cartItemReference: allocation.cartItemReference ?? fail(),
                },
              }),
              audit: makeAudit(
                next("Audit"),
                "INVENTORY_RESERVATION_RESERVE",
                "InventoryReservation",
                reservationReference,
                operation,
              ),
            });
          });
          const result = await createPostgresSubmissionReservationStore(bound, scope, {
            authorize: () => authorize(tx, authorization),
            // Actual Recipe/Workflow locks acquired above remain held by the outer transaction.
            resolveDemand: async () => demand,
            resolveExpiryCutoff,
          }).commit({
            setReference,
            operationReference,
            workflowReference: demand.workflowReference,
            workflowVersion: demand.workflowVersion,
            writes: Object.freeze(writes),
            audit: makeAudit(
              next("Audit"),
              "INVENTORY_RESERVATION_SET",
              "InventoryReservationSet",
              setReference,
              operationReference,
            ),
          });
          reservationSet = result.set;
        }
        const validation = next("Validation");
        const operation = next("Operation");
        const auditReference = next("Audit");
        const finalRecord = parseSubmissionInventoryFinalValidation({
          schemaVersion: 1,
          ...scope,
          validationReference: validation,
          operationReference: operation,
          actorReference: actor,
          auditReference,
          orderReference: order.order.orderReference,
          submissionReference: order.submissionReference,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference: checkout.quoteReference,
          demandReference: demand.demandReference,
          demandDigest,
          workflowReference: evaluated.definition.workflowReference,
          workflowVersionReference: evaluated.definition.versionReference,
          workflowVersion: evaluated.definition.versionNumber,
          transitionReference: evaluated.transition.transitionReference,
          observedAt,
          reservationSet,
          items: requirements.map((item) => ({
            itemReference: item.itemReference,
            currentItemVersion: item.currentItemVersion,
            configurationOperationReferences: item.sources.map(
              (source) => source.sourceVersionReference,
            ),
            unit: item.unit,
            quantity: item.quantity,
            stockTrackingEnabled: item.trackingPolicy.stockTrackingEnabled,
            disposition:
              item.quantity === "0"
                ? "ZeroDemand"
                : !item.trackingPolicy.stockTrackingEnabled
                  ? "NotTracked"
                  : reserveNow
                    ? "Reserved"
                    : "Deferred",
            deferredActionCode:
              item.quantity !== "0" && item.trackingPolicy.stockTrackingEnabled && !reserveNow
                ? configuration.deferredActionCode
                : null,
          })),
        });
        const source = createCustomerSubmissionFinalInventorySource(tx, scope, {
          reserveCommandCode: configuration.reserveCommandCode,
          gates: configuration.gates,
          actionRequest: request,
          ordering,
        });
        await createPostgresSubmissionFinalValidationStore(bound, scope, {
          authorize: (transaction, input) => authorize(transaction, input),
          resolveCurrent: (_transaction, proposal) => source.resolve(proposal),
        }).commit({
          record: finalRecord,
          audit: makeAudit(
            auditReference,
            "INVENTORY_SUBMISSION_FINALIZE",
            "InventoryFinalValidation",
            validation,
            operation,
          ),
        });
      } catch {
        return fail();
      }
    },
  });
}
