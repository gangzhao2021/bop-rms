import {
  AsapCapacityError,
  parseAsapCapacityCommitment,
  prepareAsapCapacityCommitment,
  assertAsapCapacityPaymentUsable,
  type AsapCapacityCommitment,
} from "../domain/asap-capacity.js";
import {
  parseFulfillmentReference,
  parseFulfillmentInstant,
} from "../domain/pickup-fulfillment.js";

export interface AsapCapacityServiceOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly now: () => string;
  readonly authorization: {
    authorize(
      request: Readonly<{
        action:
          | "AccessAsapCapacityHistory"
          | "PrepareAsapCapacity"
          | "UseAsapCapacityForOrdering"
          | "UseAsapCapacityForPayment";
        record: AsapCapacityCommitment;
        observedAt: string;
      }>,
    ): Promise<unknown>;
  };
  readonly current: {
    /** Exact owner slot/configuration and shared occupancy observation; DB rechecks under its lock. */
    resolve(record: AsapCapacityCommitment, observedAt: string): Promise<unknown>;
  };
  readonly repository: {
    loadSubmission(reference: string): Promise<unknown>;
    append(input: Readonly<{ record: AsapCapacityCommitment; audit: unknown }>): Promise<unknown>;
  };
  readonly audit: { prepare(record: AsapCapacityCommitment): Promise<unknown> };
}
function fail(code: AsapCapacityError["code"] = "ASAP_CAPACITY_UNAVAILABLE"): never {
  throw new AsapCapacityError(code);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  return Object.fromEntries(
    fields.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d?.enumerable || !("value" in d)) return fail();
      return [k, d.value];
    }),
  );
}
function preparedHistory(record: AsapCapacityCommitment) {
  return parseAsapCapacityCommitment({
    ...record,
    state: "Prepared",
    version: 1,
    orderingLinkedAt: null,
    paymentRequestedAt: null,
    capacityExpiresAt: null,
    terminalAt: null,
  });
}
/** Internal owner application boundary. A recovered history record never grants fresh authority. */
export function createAsapCapacityService(options: AsapCapacityServiceOptions) {
  const scope = closed(options.scope, ["brandReference", "storeReference"]);
  const brand = parseFulfillmentReference(scope.brandReference),
    store = parseFulfillmentReference(scope.storeReference);
  const now = () => parseFulfillmentInstant(options.now());
  async function execute(value: unknown, mode: "Prepare" | "Ordering" | "Payment") {
    try {
      const requested = parseAsapCapacityCommitment(value);
      if (
        requested.state !== "Prepared" ||
        requested.slot.brandReference !== brand ||
        requested.slot.storeReference !== store
      )
        return fail("ASAP_CAPACITY_INVALID");
      let fingerprint: string | undefined;
      async function authorize(
        action: Parameters<AsapCapacityServiceOptions["authorization"]["authorize"]>[0]["action"],
      ) {
        const at = now();
        const raw = closed(
          await options.authorization.authorize({ action, record: requested, observedAt: at }),
          [
            "guestSessionReference",
            "brandReference",
            "storeReference",
            "identityVersion",
            "observedAt",
            "validUntil",
          ],
        );
        const guest = parseFulfillmentReference(raw.guestSessionReference);
        const b = parseFulfillmentReference(raw.brandReference),
          s = parseFulfillmentReference(raw.storeReference);
        const observed = parseFulfillmentInstant(raw.observedAt),
          until = parseFulfillmentInstant(raw.validUntil);
        if (
          guest !== requested.guestSessionReference ||
          b !== brand ||
          s !== store ||
          !Number.isSafeInteger(raw.identityVersion) ||
          (raw.identityVersion as number) < 1 ||
          observed !== at ||
          until <= now()
        )
          return fail();
        const current = JSON.stringify([guest, b, s, raw.identityVersion]);
        if (fingerprint !== undefined && current !== fingerprint) return fail();
        fingerprint = current;
      }
      const same = (record: AsapCapacityCommitment) => {
        if (JSON.stringify(preparedHistory(record)) !== JSON.stringify(requested))
          return fail("ASAP_CAPACITY_CONFLICT");
        return record;
      };
      async function recover() {
        await authorize("AccessAsapCapacityHistory");
        const value = await options.repository.loadSubmission(requested.submissionReference);
        await authorize("AccessAsapCapacityHistory");
        return value === null ? null : same(parseAsapCapacityCommitment(value));
      }
      async function usable(record: AsapCapacityCommitment) {
        await authorize("UseAsapCapacityForOrdering");
        if (
          record.state !== "Prepared" ||
          now() < record.preparedAt ||
          now() >= record.preparationValidUntil
        )
          return fail("ASAP_CAPACITY_EXPIRED");
        // Its durable occupancy is already held. Fresh authorization does not reacquire or add units.
        return record;
      }
      async function resultRecord(record: AsapCapacityCommitment) {
        if (mode === "Ordering") return usable(record);
        if (mode === "Payment") {
          await authorize("UseAsapCapacityForPayment");
          const latest = await recover();
          if (latest === null) return fail();
          await authorize("UseAsapCapacityForPayment");
          return assertAsapCapacityPaymentUsable(latest, now());
        }
        return record;
      }
      const prior = await recover();
      if (prior !== null)
        return Object.freeze({
          status: "Existing" as const,
          record: await resultRecord(prior),
        });
      if (mode === "Payment") return fail();
      await authorize("PrepareAsapCapacity");
      if (now() < requested.preparedAt || now() >= requested.preparationValidUntil)
        return fail("ASAP_CAPACITY_EXPIRED");
      const at = now();
      const observation = closed(await options.current.resolve(requested, at), [
        "slot",
        "capacityLimit",
        "occupiedUnits",
        "observedAt",
      ]);
      if (parseFulfillmentInstant(observation.observedAt) !== at) return fail();
      const raw = closed(requested, [
        "allocationReference",
        "guestSessionReference",
        "cartReference",
        "quoteReference",
        "submissionReference",
        "orderReference",
        "orderBatchReference",
        "fulfillmentReference",
        "paymentOperationReference",
        "slot",
        "cartVersion",
        "units",
        "unitsRuleVersion",
        "unitsInputDigest",
        "intentDigest",
        "state",
        "version",
        "preparedAt",
        "preparationValidUntil",
        "orderingLinkedAt",
        "paymentRequestedAt",
        "capacityExpiresAt",
        "terminalAt",
      ]);
      const lifecycleFields = new Set([
        "state",
        "version",
        "orderingLinkedAt",
        "paymentRequestedAt",
        "capacityExpiresAt",
        "terminalAt",
      ]);
      const preparation = Object.fromEntries(
        Object.entries(raw).filter(([key]) => !lifecycleFields.has(key)),
      );
      prepareAsapCapacityCommitment(preparation, observation);
      await authorize("PrepareAsapCapacity");
      const audit = await options.audit.prepare(requested);
      await authorize("PrepareAsapCapacity");
      if (now() >= requested.preparationValidUntil) return fail("ASAP_CAPACITY_EXPIRED");
      let result: unknown;
      try {
        result = await options.repository.append({ record: requested, audit });
      } catch (error) {
        const recovered = await recover();
        if (recovered !== null)
          return Object.freeze({
            status: "Existing" as const,
            record: await resultRecord(recovered),
          });
        throw error;
      }
      const output = closed(result, ["status", "record"]);
      if (output.status !== "Created" && output.status !== "Existing") return fail();
      const saved = same(parseAsapCapacityCommitment(output.record));
      await authorize("AccessAsapCapacityHistory");
      return Object.freeze({
        status: output.status,
        record: await resultRecord(saved),
      });
    } catch (error) {
      if (error instanceof AsapCapacityError) throw error;
      return fail();
    }
  }
  return Object.freeze({
    prepare: (value: unknown) => execute(value, "Prepare"),
    prepareForOrdering: (value: unknown) => execute(value, "Ordering"),
    authorizePayment: (value: unknown) => execute(value, "Payment"),
  });
}
