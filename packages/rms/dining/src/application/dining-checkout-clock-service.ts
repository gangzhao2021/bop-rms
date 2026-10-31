import { type AppendAuditRecordInput } from "@bop/audit";
import { parseDiningInstant, type DiningInstant } from "../domain/dining-session.js";
import {
  parseDiningCheckoutCommitment,
  sealDiningCheckoutCommitment,
  type DiningCheckoutCommitment,
} from "../domain/dining-checkout-commitment.js";
import {
  createDiningCheckoutService,
  DiningCheckoutServiceError,
  type DiningCheckoutPrepareCommand,
  type DiningCheckoutGuestAuthority,
  type DiningCheckoutServiceOptions,
} from "./dining-checkout-service.js";
import { captureSessionData } from "./dining-session-snapshot.js";
import {
  createDiningGuestBindingQuery,
  type DiningGuestBindingReadSnapshot,
} from "./dining-guest-binding-query.js";

export interface DiningCheckoutClockOptions {
  readonly scope: DiningCheckoutServiceOptions["scope"];
  readonly now: () => string;
  readonly hashIntent: DiningCheckoutServiceOptions["hashIntent"];
  readonly current: DiningCheckoutServiceOptions["current"];
  readonly authorization: {
    authorize(input: {
      readonly action: "SealDiningCheckout";
      readonly command: DiningCheckoutPrepareCommand;
      readonly observedAt: DiningInstant;
    }): Promise<DiningCheckoutGuestAuthority | null>;
  };
  readonly repository: {
    load: DiningCheckoutServiceOptions["repository"]["load"];
    append(input: {
      readonly record: DiningCheckoutCommitment;
      readonly expectedVersion: 1;
      readonly audit: AppendAuditRecordInput;
    }): Promise<
      Readonly<{
        status: "Created" | "Existing";
        record: DiningCheckoutCommitment;
        version: number;
      }>
    >;
  };
  readonly ordering: {
    /** Exact public linkage plus server observation after positive commit recovery; no guessed commit time. */
    resolve(input: {
      readonly record: DiningCheckoutCommitment;
      readonly observedAt: DiningInstant;
    }): Promise<unknown>;
  };
  readonly audit: DiningCheckoutServiceOptions["audit"];
}
const fail = (
  code: DiningCheckoutServiceError["code"] = "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new DiningCheckoutServiceError(code);
};

/** Seals immutable clock history. Payment still requires current final eligibility. */
export function createDiningCheckoutClockService(options: DiningCheckoutClockOptions) {
  return Object.freeze({
    async seal(value: unknown) {
      try {
        const input = captureSessionData(value);
        let last: DiningInstant | undefined;
        let fingerprint: string | undefined;
        const now = () => {
          const at = parseDiningInstant(options.now());
          if (last !== undefined && at < last) return fail();
          last = at;
          return at;
        };
        const historyService = createDiningCheckoutService({
          scope: options.scope,
          now,
          hashIntent: options.hashIntent,
          current: options.current,
          authorization: {
            async authorize(request) {
              const raw = await options.authorization.authorize({
                ...request,
                action: "SealDiningCheckout",
              });
              if (raw === null) return null;
              const captured = captureSessionData(raw);
              const authority = { ...captured, observedAt: null };
              const current = JSON.stringify(authority);
              if (fingerprint !== undefined && fingerprint !== current)
                return fail("DINING_CHECKOUT_PERMISSION_DENIED");
              fingerprint = current;
              return captured;
            },
          },
          repository: {
            load: async (reference) => {
              const record = await options.repository.load(reference);
              if (record === null) return fail();
              return record;
            },
            append: async () => fail(), // Sealing can never create a missing preparation.
          },
          audit: { create: async () => fail() },
        });
        const history = async () => (await historyService.prepare(input)).record;
        const sealed = (record: DiningCheckoutCommitment) => {
          if (
            record.paymentRequestedAt !== null &&
            record.orderingLinkedAt !== null &&
            record.capacityExpiresAt !== null
          )
            return Object.freeze({ status: "Existing" as const, record });
          if (record.state !== "Prepared") return fail("DINING_CHECKOUT_SOURCE_EXPIRED");
          return null;
        };
        const original = await history();
        const prior = sealed(original);
        if (prior !== null) return prior;
        const acknowledgement = captureSessionData(
          await options.ordering.resolve({ record: original, observedAt: now() }),
        );
        // The permanent request time is selected only after positive Ordering acknowledgement.
        const requestedAt = now();
        let snapshot: DiningGuestBindingReadSnapshot | undefined;
        const query = createDiningGuestBindingQuery({
          scope: options.scope,
          now,
          repository: {
            readCurrent: async (request) => {
              const current = await options.current.readCurrent(request);
              if (current === null) return null;
              snapshot = captureSessionData(current);
              return snapshot;
            },
          },
        });
        const binding = await query.resolve({
          purpose: "GuestSessionBinding",
          diningSessionReference: original.diningSessionReference,
          participantReference: original.participantReference,
          tableReference: original.tableReference,
        });
        if (binding === null || snapshot === undefined)
          return fail("DINING_CHECKOUT_PERMISSION_DENIED");
        const candidate = sealDiningCheckoutCommitment(
          original,
          {
            session: snapshot.session,
            participant: snapshot.participant,
          },
          acknowledgement,
          requestedAt,
          now(),
        );
        const audit = captureSessionData(
          await options.audit.create({ record: candidate, observedAt: now() }),
        );
        const beforeWrite = await history();
        const won = sealed(beforeWrite);
        if (won !== null) return won;
        if (now() >= original.preparationValidUntil) return fail("DINING_CHECKOUT_SOURCE_EXPIRED");
        try {
          const saved = captureSessionData(
            await options.repository.append({
              record: candidate,
              expectedVersion: 1,
              audit,
            }),
          );
          const record = parseDiningCheckoutCommitment(saved.record);
          if (
            (saved.status !== "Created" && saved.status !== "Existing") ||
            saved.version !== 2 ||
            JSON.stringify(record) !== JSON.stringify(candidate)
          )
            return fail();
          const afterWrite = await history();
          const recovered = sealed(afterWrite);
          if (recovered === null) return fail();
          return Object.freeze({ status: saved.status, record: recovered.record });
        } catch (error) {
          // A durable winning seal is the only successful recovery of a failed/unknown append.
          const recovered = sealed(await history());
          if (recovered !== null) return recovered;
          throw error;
        }
      } catch (error) {
        if (error instanceof DiningCheckoutServiceError) throw error;
        return fail();
      }
    },
  });
}
