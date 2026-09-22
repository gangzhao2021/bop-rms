import { createHash } from "node:crypto";
import { parseOrderCapacityLink } from "@rms/ordering";
import {
  createGuestSession,
  GuestSessionService,
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  assertCurrentDiningGuestTableContext,
  createDiningCheckoutService,
  createDiningCheckoutClockService,
  type DiningCheckoutClockOptions,
  DiningCheckoutServiceError,
  parseDiningReference,
  parseDiningCheckoutCommitment,
  type DiningCheckoutServiceOptions,
} from "@rms/dining";
import {
  createCustomerDiningSessionBinding,
  type CustomerDiningBindingCompositionOptions,
} from "./customer-dining-binding-composition.js";

export interface CustomerDiningCheckoutCompositionOptions {
  readonly scope: CustomerDiningBindingCompositionOptions["scope"];
  readonly session: CustomerDiningBindingCompositionOptions["session"];
  readonly contexts: CustomerDiningBindingCompositionOptions["contexts"];
  readonly dining: Pick<
    DiningCheckoutServiceOptions,
    "current" | "repository" | "audit" | "hashIntent"
  >;
  readonly now: () => unknown;
  readonly clock?: Pick<DiningCheckoutClockOptions, "repository" | "ordering" | "audit">;
}
const unavailable = (): never => {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
};
/** Internal server submission composition; no public route or caller-supplied identity scope. */
export function createCustomerDiningCheckoutComposition(
  options: CustomerDiningCheckoutCompositionOptions,
) {
  const scopeRaw = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: String(parseDiningReference(scopeRaw.brandReference)),
    storeReference: String(parseDiningReference(scopeRaw.storeReference)),
  });
  const now = () => parseCanonicalInstant(options.now());
  const identity = createCustomerDiningCheckoutIdentity(options, scope, now);
  async function tableContext(session: GuestSession) {
    const at = now();
    const input = {
      brandReference: session.brandReference,
      storeReference: session.storeReference,
      publicStoreReference: session.publicStoreReference,
      publicTableReference: session.publicTableReference,
      channel: session.channel,
      qrRevocationVersion: session.qrRevocationVersion,
      observedAt: at,
    };
    const context = assertCurrentDiningGuestTableContext(
      input,
      await options.contexts.resolve({ session, observedAt: at, purpose: "DiningAdmission" }),
    );
    assertCurrentDiningGuestTableContext({ ...input, observedAt: now() }, context);
    return context;
  }
  async function prepare(value: unknown, purpose: "History" | "Ordering" | "Clock" | "Payment") {
    try {
      const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential", "intent"]);
      const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
      const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
      const intent = Object.freeze(
        readClosedRecord(raw.intent, [
          "commitmentReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "submissionReference",
          "orderReference",
          "orderBatchReference",
          "paymentOperationReference",
          "sourceValidUntil",
        ]),
      );
      const authenticate = async () => {
        const session = createGuestSession(
          await identity.authorize({
            sessionCredential,
            csrfCredential,
            observedAt: now(),
          }),
        );
        if (
          session.brandReference !== scope.brandReference ||
          session.storeReference !== scope.storeReference ||
          session.channel !== "DineIn" ||
          session.diningState !== "DiningBound" ||
          session.diningSessionReference === null ||
          session.diningParticipantReference === null
        )
          return unavailable();
        return session;
      };
      const first = await authenticate();
      const ownerOptions: DiningCheckoutServiceOptions = {
        scope,
        now,
        ...options.dining,
        authorization: {
          authorize: async (request) => {
            const current = await authenticate();
            if (
              JSON.stringify(current) !== JSON.stringify(first) ||
              String(request.command.guestSessionReference) !== String(current.sessionReference) ||
              String(request.command.diningSessionReference) !==
                String(current.diningSessionReference) ||
              String(request.command.participantReference) !==
                String(current.diningParticipantReference)
            )
              return null;
            const context = await tableContext(current);
            const deadline = Math.min(
              Date.parse(current.idleExpiresAt),
              Date.parse(current.absoluteExpiresAt),
              current.closureExpiresAt === null
                ? Number.POSITIVE_INFINITY
                : Date.parse(current.closureExpiresAt),
            );
            return {
              guestSessionReference: current.sessionReference,
              brandReference: current.brandReference,
              storeReference: current.storeReference,
              diningSessionReference: current.diningSessionReference ?? unavailable(),
              participantReference: current.diningParticipantReference ?? unavailable(),
              tableReference: String(parseDiningReference(context.tableReference)),
              identityVersion: current.version,
              expiresAt: new Date(deadline).toISOString(),
              observedAt: request.observedAt,
            };
          },
        },
      };
      const command = {
        ...intent,
        guestSessionReference: first.sessionReference,
        diningSessionReference: first.diningSessionReference,
        participantReference: first.diningParticipantReference,
      };
      if (purpose === "Clock") {
        if (options.clock === undefined) return unavailable();
        return await createDiningCheckoutClockService({
          ...ownerOptions,
          ...options.clock,
          authorization: {
            authorize: (request) =>
              ownerOptions.authorization.authorize({
                ...request,
                action: "PrepareDiningCheckout",
              }),
          },
        }).seal(command);
      }
      const owner = createDiningCheckoutService(ownerOptions);
      if (purpose === "Payment") return await owner.authorizePayment(command);
      return await (purpose === "Ordering"
        ? owner.prepareForOrdering(command)
        : owner.prepare(command));
    } catch (error) {
      if (error instanceof DiningCheckoutServiceError) throw error;
      return unavailable();
    }
  }
  return Object.freeze({
    prepare: (value: unknown) => prepare(value, "History"),
    sealClock: (value: unknown) => prepare(value, "Clock"),
    authorizePayment: (value: unknown) => prepare(value, "Payment"),
    async prepareForOrdering(value: unknown) {
      const result = await prepare(value, "Ordering");
      const link = diningOrderCapacityLinkFromHistory(result.record);
      return Object.freeze({ ...result, link });
    },
  });
}

export function createCustomerDiningCheckoutIdentity(
  options: CustomerDiningCheckoutCompositionOptions,
  scope: CustomerDiningCheckoutCompositionOptions["scope"],
  now: () => ReturnType<typeof parseCanonicalInstant>,
) {
  return new GuestSessionService({
    ...options.session,
    now,
    admission: { consume: async () => null },
    binding: createCustomerDiningSessionBinding({
      scope,
      binding: options.session.binding,
      repository: options.dining.current,
      contexts: options.contexts,
      now,
    }),
  });
}

export interface CustomerDiningSubmissionPreparationOptions extends CustomerDiningCheckoutCompositionOptions {
  readonly submissions: {
    loadSubmission(reference: string): Promise<unknown>;
  };
  readonly references: {
    generate(purpose: "DiningCommitment" | "Order" | "OrderBatch" | "PaymentOperation"): string;
  };
}

/** Internal server coordinator: the durable Dining commitment owns original operation recovery. */
export function createCustomerDiningSubmissionPreparation(
  options: CustomerDiningSubmissionPreparationOptions,
) {
  const composition = createCustomerDiningCheckoutComposition(options);
  const scopeRaw = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: String(parseDiningReference(scopeRaw.brandReference)),
    storeReference: String(parseDiningReference(scopeRaw.storeReference)),
  });
  const now = () => parseCanonicalInstant(options.now());
  const identity = createCustomerDiningCheckoutIdentity(options, scope, now);
  async function prepare(value: unknown) {
    try {
      const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential", "intent"]);
      const credentials = Object.freeze({
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      });
      const intentRaw = readClosedRecord(raw.intent, [
        "submissionReference",
        "cartReference",
        "cartVersion",
        "quoteReference",
        "sourceValidUntil",
      ]);
      if (!Number.isSafeInteger(intentRaw.cartVersion) || (intentRaw.cartVersion as number) < 1)
        return unavailable();
      const intent = Object.freeze({
        submissionReference: parseDiningReference(intentRaw.submissionReference),
        cartReference: parseDiningReference(intentRaw.cartReference),
        cartVersion: intentRaw.cartVersion as number,
        quoteReference: parseDiningReference(intentRaw.quoteReference),
        sourceValidUntil: parseCanonicalInstant(intentRaw.sourceValidUntil),
      });
      const authenticate = async () => {
        const guest = await identity.authorize({ ...credentials, observedAt: now() });
        if (
          guest.brandReference !== scope.brandReference ||
          guest.storeReference !== scope.storeReference ||
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound"
        )
          return unavailable();
        return guest;
      };
      await authenticate();
      const recover = async () => {
        const stored = await options.submissions.loadSubmission(intent.submissionReference);
        if (stored === null) return null;
        const original = parseDiningCheckoutCommitment(stored);
        if (
          original.submissionReference !== intent.submissionReference ||
          String(original.brandReference) !== scope.brandReference ||
          String(original.storeReference) !== scope.storeReference
        )
          return unavailable();
        // Owner preparation verifies the original Guest/Session/Participant and full intent.
        return composition.prepare({
          ...credentials,
          intent: {
            ...intent,
            commitmentReference: original.commitmentReference,
            orderReference: original.orderReference,
            orderBatchReference: original.orderBatchReference,
            paymentOperationReference: original.paymentOperationReference,
          },
        });
      };
      const original = await recover();
      if (original !== null) return original;
      const generate = (purpose: Parameters<typeof options.references.generate>[0]) =>
        parseDiningReference(options.references.generate(purpose));
      const preparedIntent = Object.freeze({
        ...intent,
        commitmentReference: generate("DiningCommitment"),
        orderReference: generate("Order"),
        orderBatchReference: generate("OrderBatch"),
        paymentOperationReference: generate("PaymentOperation"),
      });
      try {
        return await composition.prepare({ ...credentials, intent: preparedIntent });
      } catch (error) {
        // Unique submission contention or acknowledgement loss may leave the original durable.
        // Never infer absence/success from the failed response or allocate replacement IDs here.
        await authenticate();
        const recovered = await recover();
        if (recovered !== null) return recovered;
        throw error;
      }
    } catch (error) {
      if (error instanceof DiningCheckoutServiceError) throw error;
      return unavailable();
    }
  }
  return Object.freeze({
    prepare,
    async prepareForOrdering(value: unknown) {
      const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential", "intent"]);
      const credentials = Object.freeze({
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      });
      const prepared = await prepare({ ...credentials, intent: raw.intent });
      const original = prepared.record;
      return composition.prepareForOrdering({
        ...credentials,
        intent: {
          submissionReference: original.submissionReference,
          cartReference: original.cartReference,
          cartVersion: original.cartVersion,
          quoteReference: original.quoteReference,
          sourceValidUntil: original.preparationValidUntil,
          commitmentReference: original.commitmentReference,
          orderReference: original.orderReference,
          orderBatchReference: original.orderBatchReference,
          paymentOperationReference: original.paymentOperationReference,
        },
      });
    },
  });
}

/** History mapping only; fresh submission requires current owner preparation separately. */
export function diningOrderCapacityLinkFromHistory(value: unknown) {
  // The owner parser emits a fixed field order. Digest format/version is independent of
  // the OrderCreated event digest and must be retained by the permanent submission.
  const history = parseDiningCheckoutCommitment(value);
  const record = parseDiningCheckoutCommitment({
    ...history,
    state: "Prepared",
    orderingLinkedAt: null,
    paymentRequestedAt: null,
    capacityExpiresAt: null,
  });
  const digest = createHash("sha256")
    .update("DiningCheckoutPrepared:v1:" + JSON.stringify(record))
    .digest("hex");
  const link = parseOrderCapacityLink({
    owner: "Dining",
    commitmentReference: record.commitmentReference,
    commitmentVersion: 1,
    ownerContextReference: record.diningSessionReference,
    ownerIntentDigest: "sha256:" + record.intentHash,
    ownerSnapshotDigest: "sha256:" + digest,
    brandReference: record.brandReference,
    storeReference: record.storeReference,
    orderReference: record.orderReference,
    orderBatchReference: record.orderBatchReference,
    submissionReference: record.submissionReference,
    cartReference: record.cartReference,
    cartVersion: record.cartVersion,
    quoteReference: record.quoteReference,
    guestSessionReference: record.guestSessionReference,
    paymentOperationReference: record.paymentOperationReference,
    preparedAt: record.preparedAt,
    validUntil: record.preparationValidUntil,
  });
  return link;
}
