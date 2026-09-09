import { parseDiningJoinCapability } from "@bop/public-capability";
import {
  DiningSessionError,
  parseDiningHash,
  parseDiningReference,
  parseDiningSession,
} from "../contracts/dining-session.js";
import type { DiningRegenerationRecord, DiningStartRecord } from "./ports/dining-session-ports.js";

export function staffDependency(): never {
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
}

/** Capture only bounded plain data without invoking dependency accessors. */
export function captureStaffData<T>(value: T): T {
  let count = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++count > 20_000 || depth > 12) return staffDependency();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string" && input.length <= 65_536) return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null) return staffDependency();
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype))
      return staffDependency();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 10_000) return staffDependency();
    const length = array ? Object.getOwnPropertyDescriptor(input, "length")?.value : 0;
    if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1))
      return staffDependency();
    const entries = (array ? Array.from({ length }, (_, index) => String(index)) : keys).map(
      (key) => {
        const field = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== "string" || !field?.enumerable || !("value" in field))
          return staffDependency();
        return [key, copy(field.value, depth + 1)] as const;
      },
    );
    return Object.freeze(array ? entries.map((entry) => entry[1]) : Object.fromEntries(entries));
  };
  try {
    return copy(value, 0) as T;
  } catch {
    return staffDependency();
  }
}

function record(value: unknown, keys: readonly string[]) {
  const captured = captureStaffData(value);
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured) ||
    Object.keys(captured).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(captured, key))
  )
    return staffDependency();
  return captured as Record<string, unknown>;
}

export interface StaffRecordScope {
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly tableReference: string;
  readonly assignmentVersion: number;
  readonly observedAt: string;
}

export function parseStaffStartRecord(
  value: unknown,
  scope: StaffRecordScope & {
    readonly actorReference: string;
  },
): DiningStartRecord {
  try {
    const raw = record(value, [
      "session",
      "capability",
      "operationReference",
      "operationIntentHash",
    ]);
    const session = parseDiningSession(raw.session);
    const capability = parseDiningJoinCapability(raw.capability);
    const operationReference = parseDiningReference(raw.operationReference);
    const operationIntentHash = parseDiningHash(raw.operationIntentHash);
    if (
      operationReference !== scope.operationReference ||
      session.brandReference !== scope.brandReference ||
      session.storeReference !== scope.storeReference ||
      session.tableReference !== scope.tableReference ||
      session.tableAssignmentVersion !== scope.assignmentVersion ||
      session.startedByActorReference !== scope.actorReference ||
      session.phase !== "Active" ||
      session.version !== 1 ||
      session.hostParticipantReference !== null ||
      session.startedAt > scope.observedAt ||
      capability.storeReference !== scope.storeReference ||
      capability.tableReference !== scope.tableReference ||
      capability.assignmentVersion !== scope.assignmentVersion ||
      String(capability.diningSessionReference) !== session.diningSessionReference ||
      capability.status !== "Active" ||
      capability.version !== 1 ||
      capability.generation !== 1 ||
      String(capability.issuedAt) !== session.startedAt
    )
      return staffDependency();
    return Object.freeze({ session, capability, operationReference, operationIntentHash });
  } catch {
    return staffDependency();
  }
}

export function parseStaffRegenerationRecord(
  value: unknown,
  scope: StaffRecordScope & { readonly diningSessionReference: string },
): DiningRegenerationRecord {
  try {
    const raw = record(value, ["capability", "operationReference", "operationIntentHash"]);
    const capability = parseDiningJoinCapability(raw.capability);
    const operationReference = parseDiningReference(raw.operationReference);
    const operationIntentHash = parseDiningHash(raw.operationIntentHash);
    if (
      operationReference !== scope.operationReference ||
      capability.storeReference !== scope.storeReference ||
      capability.tableReference !== scope.tableReference ||
      capability.assignmentVersion !== scope.assignmentVersion ||
      capability.diningSessionReference !== scope.diningSessionReference ||
      capability.status !== "Active" ||
      capability.version !== 1 ||
      capability.generation < 2 ||
      capability.issuedAt > scope.observedAt
    )
      return staffDependency();
    return Object.freeze({ capability, operationReference, operationIntentHash });
  } catch {
    return staffDependency();
  }
}
