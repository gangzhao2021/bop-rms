import {
  DiningSessionError,
  parseDiningGuestContextEvidence,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
} from "../domain/dining-session.js";
import { consumeDiningIdentityAdmission } from "../domain/dining-admission.js";
import {
  closedAdmissionData,
  parseDiningAdmissionConsumptionRecord,
  parseDiningAdmissionSnapshot,
  sameAdmissionData,
} from "./dining-admission-record.js";
import { captureSessionData, sessionDependency } from "./dining-session-snapshot.js";
import type {
  DiningAdmissionConsumptionPorts,
  DiningAdmissionConsumptionResult,
} from "./ports/dining-admission-ports.js";

function unavailable(): never {
  throw new DiningSessionError("DINING_SESSION_UNAVAILABLE");
}
function conflict(): never {
  throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
}
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return sessionDependency();
  }
}
async function dependency<T>(work: () => Promise<T>, writer = false): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      writer &&
      error instanceof DiningSessionError &&
      (error.code === "DINING_SESSION_VERSION_CONFLICT" ||
        error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT")
    )
      throw new DiningSessionError(error.code);
    return sessionDependency();
  }
}
/** Internal current-Guest authority plus owner protocol. Identity evidence requires separate composition. */
export function createDiningAdmissionConsumptionService(ports: DiningAdmissionConsumptionPorts) {
  let brandReference;
  let storeReference;
  try {
    const scope = closedAdmissionData(ports.scope, ["brandReference", "storeReference"]);
    brandReference = parseDiningReference(scope.brandReference);
    storeReference = parseDiningReference(scope.storeReference);
  } catch {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
  return Object.freeze({
    async consume(input: unknown): Promise<DiningAdmissionConsumptionResult> {
      let guestSessionReference;
      let admissionReference;
      let operationReference;
      let requestedAt;
      try {
        const raw = closedAdmissionData(input, [
          "guestSessionReference",
          "admissionReference",
          "operationReference",
          "requestedAt",
        ]);
        guestSessionReference = parseDiningReference(raw.guestSessionReference);
        admissionReference = parseDiningReference(raw.admissionReference);
        operationReference = parseDiningReference(raw.operationReference);
        requestedAt = parseDiningInstant(raw.requestedAt);
      } catch {
        throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
      }
      let guest;
      try {
        guest = parseDiningGuestContextEvidence(
          captureSessionData(
            await ports.guests.resolve({ guestSessionReference, observedAt: requestedAt }),
          ),
        );
      } catch {
        return unavailable();
      }
      if (
        guest.guestSessionReference !== guestSessionReference ||
        guest.channel !== "DineIn" ||
        guest.diningState !== "ContextOnly" ||
        guest.storeReference !== storeReference ||
        guest.tableReference === null ||
        guest.observedAt !== requestedAt
      )
        return unavailable();
      const source = await dependency(() =>
        ports.store.readCurrent({ admissionReference, observedAt: requestedAt }),
      );
      if (source === null) return unavailable();
      const snapshot = parseDiningAdmissionSnapshot(source);
      if (
        snapshot.session.brandReference !== brandReference ||
        snapshot.session.storeReference !== storeReference ||
        snapshot.admission.admissionReference !== admissionReference
      )
        return sessionDependency();
      if (
        snapshot.joinedGuestSessionReference !== guestSessionReference ||
        snapshot.session.tableReference !== guest.tableReference
      )
        return unavailable();
      const joinHash = checked(() =>
        parseDiningHash(
          ports.credentials.hashOperationIntent(
            `Join:${guestSessionReference}:${snapshot.join.capability.capabilityReference}`,
          ),
        ),
      );
      if (
        checked(() => ports.credentials.equals(joinHash, snapshot.join.operationIntentHash)) !==
        true
      )
        return sessionDependency();
      // Reevaluate the original Active admission against current facts even during recovery.
      const consumed = consumeDiningIdentityAdmission({
        admission: snapshot.join.admission,
        session: snapshot.session,
        participant: snapshot.participant,
        table: snapshot.table,
        expectedAdmissionVersion: 1,
        expectedSessionVersion: snapshot.session.version,
        observedAt: requestedAt,
      });
      const operationIntentHash = checked(() =>
        parseDiningHash(
          ports.credentials.hashOperationIntent(
            `ConsumeDiningAdmission:${guestSessionReference}:${admissionReference}`,
          ),
        ),
      );
      const proposed = parseDiningAdmissionConsumptionRecord({
        operationReference,
        operationIntentHash,
        guestSessionReference,
        admission: consumed,
      });
      const validate = (value: unknown) => {
        const record = parseDiningAdmissionConsumptionRecord(value);
        if (
          record.operationReference !== operationReference ||
          record.guestSessionReference !== guestSessionReference ||
          record.admission.admissionReference !== admissionReference ||
          checked(() =>
            ports.credentials.equals(record.operationIntentHash, operationIntentHash),
          ) !== true
        )
          return conflict();
        if (
          !sameAdmissionData({ ...record.admission, consumedAt: requestedAt }, consumed) ||
          record.admission.consumedAt === null ||
          record.admission.consumedAt > requestedAt ||
          (snapshot.admission.status === "Consumed" &&
            !sameAdmissionData(snapshot.admission, record.admission))
        )
          return sessionDependency();
        return record;
      };
      const prior = await dependency(() => ports.store.resolveOperation(operationReference));
      if (prior !== null)
        return Object.freeze({ status: "AlreadyApplied", record: validate(prior) });
      if (snapshot.admission.status !== "Active") return unavailable();
      const receipt = closedAdmissionData(
        await dependency(
          () => ports.store.consume(Object.freeze({ snapshot, record: proposed })),
          true,
        ),
        ["status", "record"],
      );
      if (receipt.status !== "Applied" && receipt.status !== "AlreadyApplied")
        return sessionDependency();
      const record = validate(receipt.record);
      if (receipt.status === "Applied" && !sameAdmissionData(record, proposed))
        return sessionDependency();
      return Object.freeze({
        status: receipt.status === "Applied" ? "Consumed" : "AlreadyApplied",
        record,
      });
    },
  });
}
