import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresUnmatchedCaptureRefundStore,
  UnmatchedCaptureRefundError,
  type RefundPaymentRequest,
  type UnmatchedCaptureRefundState,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Reading follows the exceptions workbench; each step needs its own refund authority. */
export const unmatchedCaptureRefundPermissions = Object.freeze({
  read: "operations.order-exception.manage",
  request: "payment.refund.request",
  approve: "payment.refund.approve",
} as const);

/** The Provider's confirmed refund, as the Provider adapter returns it. */
export interface UnmatchedCaptureRefundObservation {
  readonly kind: "RefundObservation";
  readonly context: { readonly operationReference: string };
  readonly providerRefundReference: string;
  readonly providerIntentReference: string;
  readonly amount: { readonly amountMinor: bigint; readonly currencyCode: string };
  readonly status: string;
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

const invalid = (): never => {
  throw new UnmatchedCaptureRefundError("UNMATCHED_REFUND_INPUT_INVALID");
};
const reference = (value: unknown) => {
  try {
    return String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  } catch {
    return invalid();
  }
};

/** What staff see: amounts and dates, never Provider references or actor identities. */
function view(state: UnmatchedCaptureRefundState, actorReference: string) {
  return Object.freeze({
    exceptionReference: state.reconciliationExceptionReference,
    status: state.status,
    amountMinor: state.amountMinor,
    currencyCode: state.currencyCode,
    capturedAt: state.capturedAt,
    requestedAt: state.request?.requestedAt ?? null,
    requestedByYou: state.request?.requestedByActorReference === actorReference,
    approvedAt: state.approval?.approvedAt ?? null,
    refundedAt: state.outcome?.recordedAt ?? null,
  });
}

/**
 * WP-2423 P6: refund in full a charge the payment Provider captured that matches no payment or
 * Order of this Store. A manager requests it; a different person with refund-approve authority
 * approves it, which fixes the Provider idempotency key and sends it; the Provider-confirmed refund
 * closes the reconciliation exception. A lost Provider response is recovered by approving again:
 * the same fixed key returns the same refund.
 */
export function createMerchantUnmatchedCaptureRefund(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
  refundPayment(request: RefundPaymentRequest): Promise<UnmatchedCaptureRefundObservation>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const inScope = async <T>(
    input: { sessionCookie: unknown; csrf: unknown },
    permission: string,
    access: "Read" | "Request" | "Approve" | "Record",
    work: (
      store: ReturnType<typeof createPostgresUnmatchedCaptureRefundStore>,
      tx: ConsumerTransaction,
      actorReference: string,
    ) => Promise<T>,
  ) => {
    const session = await options.authentication.authorize(input);
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        permission,
        session.sessionReference,
      );
      if (!(await scope.allowed()))
        throw new UnmatchedCaptureRefundError("UNMATCHED_REFUND_PERMISSION_DENIED");
      const tx = transaction as unknown as ConsumerTransaction;
      const actorReference = String(scope.actorReference);
      const store = createPostgresUnmatchedCaptureRefundStore({
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.store.storeReference),
        authorize: async (t, step, actor) =>
          t === tx &&
          // Every step reads the current state first; reading is part of each step's authority.
          (step === access || step === "Read") &&
          (actor === null || actor === actorReference) &&
          (await scope.allowed()),
      });
      return work(store, tx, actorReference);
    });
  };
  const exceptionOf = (command: unknown, keys: readonly string[]) => {
    let raw: Readonly<Record<string, unknown>>;
    try {
      raw = readClosedRecord(command, keys);
    } catch {
      return invalid();
    }
    return raw;
  };
  const found = (state: UnmatchedCaptureRefundState | null) =>
    state ?? fail("UNMATCHED_REFUND_NOT_FOUND");
  const fail = (code: UnmatchedCaptureRefundError["code"]): never => {
    throw new UnmatchedCaptureRefundError(code);
  };

  return Object.freeze({
    async read(input: { sessionCookie: unknown; csrf: unknown; query: unknown }) {
      const exceptionReference = reference(
        exceptionOf(input.query, ["exceptionReference"]).exceptionReference,
      );
      return inScope(
        input,
        unmatchedCaptureRefundPermissions.read,
        "Read",
        async (store, tx, me) => {
          const state = await store.read(tx, exceptionReference);
          return state === null
            ? Object.freeze({ status: "NotApplicable" as const })
            : view(state, me);
        },
      );
    },
    async request(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const raw = exceptionOf(input.command, ["exceptionReference", "idempotencyReference"]);
      const exceptionReference = reference(raw.exceptionReference),
        idempotencyReference = reference(raw.idempotencyReference);
      return inScope(
        input,
        unmatchedCaptureRefundPermissions.request,
        "Request",
        async (store, tx, me) =>
          view(
            found(
              await store.request(tx, {
                exceptionReference,
                actorReference: me,
                refundReference: options.nextReference(),
                idempotencyReference,
                auditReference: options.nextReference(),
                requestedAt: options.persistence.now(),
              }),
            ),
            me,
          ),
      );
    },
    /** Approve (once) and send to the Provider; repeating it resends the same fixed request. */
    async approve(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const raw = exceptionOf(input.command, ["exceptionReference", "idempotencyReference"]);
      const exceptionReference = reference(raw.exceptionReference),
        idempotencyReference = reference(raw.idempotencyReference);
      const approved = await inScope(
        input,
        unmatchedCaptureRefundPermissions.approve,
        "Approve",
        async (store, tx, me) => {
          const current = found(await store.read(tx, exceptionReference));
          if (current.status === "Refunded") return { state: current, request: null, me };
          const state =
            current.status === "Approved"
              ? current
              : found(
                  await store.approve(tx, {
                    exceptionReference,
                    actorReference: me,
                    operationReference: options.nextReference(),
                    idempotencyReference,
                    auditReference: options.nextReference(),
                    approvedAt: options.persistence.now(),
                  }),
                );
          return { state, request: store.providerRequest(state), me };
        },
      );
      if (approved.request === null) return view(approved.state, approved.me);
      let observation: UnmatchedCaptureRefundObservation;
      try {
        observation = await options.refundPayment(approved.request);
      } catch {
        // The approval stands with its fixed key; approving again recovers the Provider result.
        return Object.freeze({ ...view(approved.state, approved.me), providerResult: "Unknown" });
      }
      const request = approved.request;
      if (
        observation.kind !== "RefundObservation" ||
        observation.context.operationReference !== request.context.operationReference ||
        observation.amount.currencyCode !== "CAD"
      )
        return fail("UNMATCHED_REFUND_UNAVAILABLE");
      return inScope(
        input,
        unmatchedCaptureRefundPermissions.approve,
        "Record",
        async (store, tx, me) =>
          view(
            found(
              await store.recordOutcome(tx, {
                exceptionReference,
                observation: {
                  providerRefundReference: observation.providerRefundReference,
                  providerIntentReference: observation.providerIntentReference,
                  amountMinor: observation.amount.amountMinor,
                  status: observation.status,
                  observedAt: observation.observedAt,
                  evidenceDigest: observation.evidenceDigest,
                  idempotencyKey: request.idempotencyKey,
                },
                auditReference: options.nextReference(),
                recordedAt: options.persistence.now(),
              }),
            ),
            me,
          ),
      );
    },
  });
}
