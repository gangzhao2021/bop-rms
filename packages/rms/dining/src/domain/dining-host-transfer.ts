import {
  parseDiningReference,
  parseDiningInstant,
  parseDiningSession,
  parseDiningParticipant,
} from "./dining-session.js";

export class DiningHostTransferError extends Error {
  readonly code = "DINING_HOST_TRANSFER_INVALID";
  constructor() {
    super("dining host transfer is unavailable");
    this.name = "DiningHostTransferError";
  }
}
function invalid(): never {
  throw new DiningHostTransferError();
}
function closed(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
const references = [
  "operationReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "actorReference",
  "targetParticipantReference",
] as const;
export function parseDiningHostTransferCommand(value: unknown) {
  try {
    const raw = closed(value, [
      ...references,
      "actorType",
      "expectedSessionVersion",
      "expectedHostParticipantReference",
      "purposeCode",
      "permissionCode",
      "reasonCode",
      "observedAt",
    ]);
    const refs = Object.fromEntries(
      references.map((key) => [key, parseDiningReference(raw[key])]),
    ) as Readonly<Record<(typeof references)[number], ReturnType<typeof parseDiningReference>>>;
    if (
      (raw.actorType !== "Staff" && raw.actorType !== "Participant") ||
      raw.purposeCode !== "TransferDiningHost" ||
      raw.permissionCode !== "dining.host.transfer" ||
      typeof raw.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
      typeof raw.expectedSessionVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedSessionVersion) ||
      raw.expectedSessionVersion < 1 ||
      raw.expectedSessionVersion >= 2147483647
    )
      return invalid();
    const expectedHostParticipantReference =
      raw.expectedHostParticipantReference === null
        ? null
        : parseDiningReference(raw.expectedHostParticipantReference);
    if (
      refs.targetParticipantReference === expectedHostParticipantReference ||
      (raw.actorType === "Participant" && refs.actorReference !== expectedHostParticipantReference)
    )
      return invalid();
    return Object.freeze({
      ...refs,
      actorType: raw.actorType,
      expectedSessionVersion: raw.expectedSessionVersion,
      expectedHostParticipantReference,
      purposeCode: "TransferDiningHost" as const,
      permissionCode: "dining.host.transfer" as const,
      reasonCode: raw.reasonCode,
      observedAt: parseDiningInstant(raw.observedAt),
    });
  } catch {
    return invalid();
  }
}
/** A candidate is not permission or persistence evidence. The writer must retain
 * current scope, actor, participant and session locks through Audit and commit.
 * Participant callers require current authenticated Host binding; Staff requires
 * the configured employee permission. History keeps the prior actor/Host intact.
 */
export function createDiningHostTransfer(input: {
  command: unknown;
  session: unknown;
  targetParticipant: unknown;
}) {
  try {
    const command = parseDiningHostTransferCommand(input.command),
      previousSession = parseDiningSession(input.session),
      targetParticipant = parseDiningParticipant(input.targetParticipant);
    if (
      previousSession.brandReference !== command.brandReference ||
      previousSession.storeReference !== command.storeReference ||
      previousSession.diningSessionReference !== command.diningSessionReference ||
      previousSession.version !== command.expectedSessionVersion ||
      previousSession.hostParticipantReference !== command.expectedHostParticipantReference ||
      !["Active", "Closing"].includes(previousSession.phase) ||
      previousSession.startedAt > command.observedAt ||
      targetParticipant.participantReference !== command.targetParticipantReference ||
      targetParticipant.diningSessionReference !== previousSession.diningSessionReference ||
      targetParticipant.status !== "Active" ||
      targetParticipant.joinedAt < previousSession.startedAt ||
      targetParticipant.joinedAt > command.observedAt
    )
      return invalid();
    const session = parseDiningSession({
      ...previousSession,
      hostParticipantReference: targetParticipant.participantReference,
      version: previousSession.version + 1,
    });
    return Object.freeze({ command, previousSession, session, targetParticipant });
  } catch {
    return invalid();
  }
}
/** Validate a stored immutable transition, including unchanged phase/table facts. */
export function parseDiningHostTransferRecord(value: unknown) {
  try {
    const raw = closed(value, ["command", "previousSession", "session", "targetParticipant"]);
    const expected = createDiningHostTransfer({
      command: raw.command,
      session: raw.previousSession,
      targetParticipant: raw.targetParticipant,
    });
    const actual = parseDiningSession(raw.session);
    if (JSON.stringify(actual) !== JSON.stringify(expected.session)) return invalid();
    return expected;
  } catch {
    return invalid();
  }
}
export type DiningHostTransferCommand = ReturnType<typeof parseDiningHostTransferCommand>;
export type DiningHostTransferRecord = ReturnType<typeof parseDiningHostTransferRecord>;
