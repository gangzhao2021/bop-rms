import {
  AsapCapacityError,
  parseAsapCapacityCommitment,
  sealAsapCapacityCommitment,
  type AsapCapacityCommitment,
} from "../domain/asap-capacity.js";
import { parseFulfillmentInstant } from "../domain/pickup-fulfillment.js";
import {
  createAsapCapacityService,
  type AsapCapacityServiceOptions,
} from "./asap-capacity-service.js";

export interface AsapCapacityClockOptions extends AsapCapacityServiceOptions {
  readonly ordering: {
    /** Positive original Order plus exact saved capacity link, followed by server observation. */
    resolve(
      input: Readonly<{ record: AsapCapacityCommitment; observedAt: string }>,
    ): Promise<unknown>;
  };
}
function fail(): never {
  throw new AsapCapacityError("ASAP_CAPACITY_UNAVAILABLE");
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((k) => typeof k !== "string" || !keys.includes(k)))
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      return [key, d.value];
    }),
  );
}
/** Immutable clock history only; current Payment permission is a separate decision. */
export function createAsapCapacityClockService(options: AsapCapacityClockOptions) {
  return Object.freeze({
    async seal(value: unknown) {
      try {
        const requested = parseAsapCapacityCommitment(value);
        let last: string | undefined;
        let fingerprint: string | undefined;
        const now = () => {
          const at = parseFulfillmentInstant(options.now());
          if (last !== undefined && at < last) return fail();
          last = at;
          return at;
        };
        const owner = createAsapCapacityService({
          ...options,
          now,
          authorization: {
            async authorize(request) {
              const raw = closed(await options.authorization.authorize(request), [
                "guestSessionReference",
                "brandReference",
                "storeReference",
                "identityVersion",
                "observedAt",
                "validUntil",
              ]);
              if (
                typeof raw.guestSessionReference !== "string" ||
                typeof raw.brandReference !== "string" ||
                typeof raw.storeReference !== "string" ||
                !Number.isSafeInteger(raw.identityVersion)
              )
                return fail();
              const current = JSON.stringify([
                raw.guestSessionReference,
                raw.brandReference,
                raw.storeReference,
                raw.identityVersion,
              ]);
              if (fingerprint !== undefined && fingerprint !== current) return fail();
              fingerprint = current;
              return raw;
            },
          },
          repository: {
            loadSubmission: async (ref) => {
              const record = await options.repository.loadSubmission(ref);
              if (record === null) return fail();
              return record;
            },
            append: async () => fail(),
          },
          audit: { prepare: async () => fail() },
        });
        const history = async () => (await owner.prepare(requested)).record;
        const sealed = (record: AsapCapacityCommitment) => {
          if (record.paymentRequestedAt !== null)
            return Object.freeze({ status: "Existing" as const, record });
          if (record.state !== "Prepared") throw new AsapCapacityError("ASAP_CAPACITY_EXPIRED");
          return null;
        };
        const original = await history();
        const prior = sealed(original);
        if (prior !== null) return prior;
        await owner.prepareForOrdering(requested);
        const acknowledgement = await options.ordering.resolve({
          record: original,
          observedAt: now(),
        });
        const requestedAt = now();
        const candidate = sealAsapCapacityCommitment(original, acknowledgement, requestedAt, now());
        const audit = await options.audit.prepare(candidate);
        const won = sealed(await history());
        if (won !== null) return won;
        await owner.prepareForOrdering(requested);
        if (now() >= original.preparationValidUntil)
          throw new AsapCapacityError("ASAP_CAPACITY_EXPIRED");
        try {
          const saved = closed(await options.repository.append({ record: candidate, audit }), [
            "status",
            "record",
          ]);
          if (
            (saved.status !== "Created" && saved.status !== "Existing") ||
            JSON.stringify(parseAsapCapacityCommitment(saved.record)) !== JSON.stringify(candidate)
          )
            return fail();
          const recovered = sealed(await history());
          if (recovered === null) return fail();
          return Object.freeze({ status: saved.status, record: recovered.record });
        } catch (error) {
          const recovered = sealed(await history());
          if (recovered !== null) return recovered;
          throw error;
        }
      } catch (error) {
        if (error instanceof AsapCapacityError) throw error;
        return fail();
      }
    },
  });
}
