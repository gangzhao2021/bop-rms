import { parseOrderCapacityLink } from "@rms/ordering";
import { createHash } from "node:crypto";
import {
  GuestSessionService,
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  createAsapCapacityService,
  createAsapCapacityClockService,
  type AsapCapacityClockOptions,
  parseAsapCapacityCommitment,
  parseScheduledCapacitySlot,
  parseFulfillmentReference,
  parseFulfillmentDigest,
  AsapCapacityError,
  type AsapCapacityCommitment,
  type AsapCapacityServiceOptions,
} from "@rms/fulfillment";

export interface CustomerPickupCheckoutOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "credentials" | "store">;
  readonly capacity: Pick<AsapCapacityServiceOptions, "repository" | "audit">;
  readonly sources: {
    /** Required owner composition: exact current Cart/Quote/Guest and capacity units/slot evidence. */
    resolve(
      input: Readonly<{
        guestSessionReference: string;
        cartReference: string;
        cartVersion: number;
        quoteReference: string;
        submissionReference: string;
        observedAt: string;
      }>,
    ): Promise<unknown>;
  };
  readonly references: {
    generate(
      purpose: "CapacityAllocation" | "Order" | "OrderBatch" | "Fulfillment" | "PaymentOperation",
    ): string;
  };
  readonly now: () => string;
  readonly clock?: Pick<AsapCapacityClockOptions, "ordering">;
}
function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}
function integer(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) return unavailable();
  return value as number;
}
/** Internal composition only. No public route or provider invocation is enabled here. */
export function createCustomerPickupCheckoutComposition(options: CustomerPickupCheckoutOptions) {
  const rawScope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: parseFulfillmentReference(rawScope.brandReference),
    storeReference: parseFulfillmentReference(rawScope.storeReference),
  });
  const now = () => parseCanonicalInstant(options.now());
  const identity = new GuestSessionService({
    ...options.session,
    now,
    admission: { consume: async () => null },
  });
  async function execute(value: unknown, mode: "Prepare" | "Ordering" | "Clock" | "Payment") {
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
      ]);
      const intent = Object.freeze({
        submissionReference: parseFulfillmentReference(intentRaw.submissionReference),
        cartReference: parseFulfillmentReference(intentRaw.cartReference),
        cartVersion: integer(intentRaw.cartVersion),
        quoteReference: parseFulfillmentReference(intentRaw.quoteReference),
      });
      let firstIdentity: string | undefined;
      async function authenticate() {
        const guest = await identity.authorize({ ...credentials, observedAt: now() });
        if (
          String(guest.brandReference) !== scope.brandReference ||
          String(guest.storeReference) !== scope.storeReference ||
          guest.channel !== "Pickup" ||
          guest.diningState !== "ContextOnly"
        )
          return unavailable();
        const fingerprint = JSON.stringify(guest);
        if (firstIdentity !== undefined && firstIdentity !== fingerprint) return unavailable();
        firstIdentity = fingerprint;
        return guest;
      }
      const first = await authenticate();
      const guestReference = parseFulfillmentReference(first.sessionReference);
      async function source(observedAt: string) {
        const raw = readClosedRecord(
          await options.sources.resolve({
            ...intent,
            guestSessionReference: guestReference,
            observedAt,
          }),
          [
            "slot",
            "capacityLimit",
            "occupiedUnits",
            "units",
            "unitsRuleVersion",
            "unitsInputDigest",
            "observedAt",
            "validUntil",
          ],
        );
        const slot = parseScheduledCapacitySlot(raw.slot);
        const snapshot = Object.freeze({
          slot,
          capacityLimit: integer(raw.capacityLimit, 0),
          occupiedUnits: integer(raw.occupiedUnits, 0),
          units: integer(raw.units),
          unitsRuleVersion: integer(raw.unitsRuleVersion),
          unitsInputDigest: parseFulfillmentDigest(raw.unitsInputDigest),
          observedAt: parseCanonicalInstant(raw.observedAt),
          validUntil: parseCanonicalInstant(raw.validUntil),
        });
        if (
          slot.brandReference !== scope.brandReference ||
          slot.storeReference !== scope.storeReference ||
          slot.fulfillmentType !== "Pickup" ||
          snapshot.observedAt !== observedAt ||
          snapshot.validUntil <= now()
        )
          return unavailable();
        return snapshot;
      }
      const ownerOptions: AsapCapacityServiceOptions = {
        ...options.capacity,
        scope,
        now,
        current: {
          resolve: async (record, observedAt) => {
            const resolved = await source(observedAt);
            if (
              JSON.stringify(resolved.slot) !== JSON.stringify(record.slot) ||
              resolved.units !== record.units ||
              resolved.unitsRuleVersion !== record.unitsRuleVersion ||
              resolved.unitsInputDigest !== record.unitsInputDigest
            )
              return unavailable();
            return {
              slot: resolved.slot,
              capacityLimit: resolved.capacityLimit,
              occupiedUnits: resolved.occupiedUnits,
              observedAt: resolved.observedAt,
            };
          },
        },
        authorization: {
          authorize: async (request) => {
            const guest = await authenticate();
            if (request.record.guestSessionReference !== guestReference) return null;
            let deadline = Math.min(
              Date.parse(guest.idleExpiresAt),
              Date.parse(guest.absoluteExpiresAt),
              guest.closureExpiresAt === null ? Infinity : Date.parse(guest.closureExpiresAt),
            );
            if (
              request.action === "PrepareAsapCapacity" ||
              request.action === "UseAsapCapacityForOrdering"
            ) {
              const resolved = await source(request.observedAt);
              if (
                JSON.stringify(resolved.slot) !== JSON.stringify(request.record.slot) ||
                resolved.units !== request.record.units ||
                resolved.unitsRuleVersion !== request.record.unitsRuleVersion ||
                resolved.unitsInputDigest !== request.record.unitsInputDigest ||
                Date.parse(resolved.validUntil) < Date.parse(request.record.preparationValidUntil)
              )
                return null;
              await authenticate();
              deadline = Math.min(deadline, Date.parse(resolved.validUntil));
            }
            return {
              guestSessionReference: guestReference,
              ...scope,
              identityVersion: guest.version,
              observedAt: request.observedAt,
              validUntil: new Date(deadline).toISOString(),
            };
          },
        },
      };
      const owner = createAsapCapacityService(ownerOptions);
      const matches = (value: unknown) => {
        const record = parseAsapCapacityCommitment(value);
        if (
          record.slot.brandReference !== scope.brandReference ||
          record.slot.storeReference !== scope.storeReference ||
          record.guestSessionReference !== guestReference ||
          record.submissionReference !== intent.submissionReference ||
          record.cartReference !== intent.cartReference ||
          record.cartVersion !== intent.cartVersion ||
          record.quoteReference !== intent.quoteReference
        )
          return unavailable();
        return parseAsapCapacityCommitment({
          ...record,
          state: "Prepared",
          version: 1,
          orderingLinkedAt: null,
          paymentRequestedAt: null,
          capacityExpiresAt: null,
          terminalAt: null,
        });
      };
      const run = (record: AsapCapacityCommitment) => {
        if (mode === "Clock") {
          if (options.clock === undefined) return unavailable();
          return createAsapCapacityClockService({ ...ownerOptions, ...options.clock }).seal(record);
        }
        if (mode === "Payment") return owner.authorizePayment(record);
        return mode === "Ordering" ? owner.prepareForOrdering(record) : owner.prepare(record);
      };
      async function recover() {
        await authenticate();
        const original = await options.capacity.repository.loadSubmission(
          intent.submissionReference,
        );
        await authenticate();
        return original === null ? null : run(matches(original));
      }
      const original = await recover();
      if (original !== null) return original;
      if (mode === "Clock" || mode === "Payment") return unavailable();
      const preparedAt = now();
      const facts = await source(preparedAt);
      await authenticate();
      const generate = (
        purpose: Parameters<CustomerPickupCheckoutOptions["references"]["generate"]>[0],
      ) => parseFulfillmentReference(options.references.generate(purpose));
      const preparationValidUntil = new Date(
        Math.min(
          Date.parse(facts.validUntil),
          Date.parse(first.idleExpiresAt),
          Date.parse(first.absoluteExpiresAt),
          first.closureExpiresAt === null ? Infinity : Date.parse(first.closureExpiresAt),
        ),
      ).toISOString();
      const base = {
        ...intent,
        guestSessionReference: guestReference,
        slot: facts.slot,
        units: facts.units,
        unitsRuleVersion: facts.unitsRuleVersion,
        unitsInputDigest: facts.unitsInputDigest,
        allocationReference: generate("CapacityAllocation"),
        orderReference: generate("Order"),
        orderBatchReference: generate("OrderBatch"),
        fulfillmentReference: generate("Fulfillment"),
        paymentOperationReference: generate("PaymentOperation"),
        preparedAt,
        preparationValidUntil,
      };
      const record = parseAsapCapacityCommitment({
        ...base,
        intentDigest:
          "sha256:" +
          createHash("sha256")
            .update("AsapCheckoutPrepared:v1:" + JSON.stringify(base))
            .digest("hex"),
        state: "Prepared",
        version: 1,
        orderingLinkedAt: null,
        paymentRequestedAt: null,
        capacityExpiresAt: null,
        terminalAt: null,
      });
      try {
        return await run(record);
      } catch (error) {
        const recovered = await recover();
        if (recovered !== null) return recovered;
        throw error;
      }
    } catch (error) {
      if (error instanceof AsapCapacityError) throw error;
      return unavailable();
    }
  }
  return Object.freeze({
    prepare: (value: unknown) => execute(value, "Prepare"),
    prepareForOrdering: (value: unknown) => execute(value, "Ordering"),
    sealClock: (value: unknown) => execute(value, "Clock"),
    authorizePayment: (value: unknown) => execute(value, "Payment"),
  });
}

/** Original history mapping only. Fresh Order creation requires current owner authorization. */
export function pickupOrderCapacityLinkFromHistory(value: unknown) {
  const history = parseAsapCapacityCommitment(value);
  const record = parseAsapCapacityCommitment({
    ...history,
    state: "Prepared",
    version: 1,
    orderingLinkedAt: null,
    paymentRequestedAt: null,
    capacityExpiresAt: null,
    terminalAt: null,
  });
  return parseOrderCapacityLink({
    owner: "Fulfillment",
    commitmentReference: record.allocationReference,
    commitmentVersion: 1,
    ownerContextReference: record.slot.slotReference,
    ownerIntentDigest: record.intentDigest,
    ownerSnapshotDigest:
      "sha256:" +
      createHash("sha256")
        .update("AsapCapacityPrepared:v1:" + JSON.stringify(record))
        .digest("hex"),
    brandReference: record.slot.brandReference,
    storeReference: record.slot.storeReference,
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
}
