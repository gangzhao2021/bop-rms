import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
} from "./publishing.js";
import { validatePlatformPublishingTransition } from "./platform-publishing.js";

export const platformPublishingSourceOperations = [
  "CreateDraft",
  "SubmitReview",
  "Approve",
  "Publish",
  "Archive",
] as const;
const purpose = "PLATFORM_BRAND_TEMPLATE" as const;
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const own = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    own.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    own.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !descriptors[key]?.enumerable ||
        !("value" in descriptors[key]),
    )
  )
    return fail();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}
const same = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const hash = (value: unknown) =>
  parsePublishingDigest(`sha256:${sha256Hex(canonicalizeRfc8785(value))}`);
function sequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return fail();
  return value;
}
export function parsePlatformPublishingSourceScope(value: unknown) {
  const r = closed(value, ["kind", "actorReference", "purposeCode"]);
  if (r.kind !== "Platform" || r.purposeCode !== purpose) return fail();
  return Object.freeze({
    kind: "Platform" as const,
    actorReference: parsePublishingReference(r.actorReference),
    purposeCode: purpose,
  });
}
export type PlatformPublishingSourceScope = ReturnType<typeof parsePlatformPublishingSourceScope>;
function expectedLifecycle(value: unknown) {
  if (value === null) return null;
  const r = closed(value, ["lifecycleReference", "version", "sourceDigest"]);
  return Object.freeze({
    lifecycleReference: parsePublishingReference(r.lifecycleReference),
    version: parsePublishingVersion(r.version),
    sourceDigest: parsePublishingDigest(r.sourceDigest),
  });
}
/** Browser intent only: server Actor, clock, lifecycle and evidence are absent. */
export function parsePlatformPublishingRequest(value: unknown) {
  const r = closed(value, [
    "profile",
    "operation",
    "operationReference",
    "templateReference",
    "templateVersionReference",
    "contentDigest",
    "templateSourceDigest",
    "expectedLifecycle",
    "reviewValidUntil",
    "reasonCode",
  ]);
  if (
    r.profile !== "PlatformPublishingRequestV1" ||
    typeof r.operation !== "string" ||
    !platformPublishingSourceOperations.includes(
      r.operation as (typeof platformPublishingSourceOperations)[number],
    )
  )
    return fail();
  const expected = expectedLifecycle(r.expectedLifecycle),
    until = r.reviewValidUntil === null ? null : parsePublishingInstant(r.reviewValidUntil);
  if (
    (r.operation === "SubmitReview") !== (until !== null) ||
    (r.operation !== "CreateDraft" && expected === null)
  )
    return fail();
  return Object.freeze({
    profile: "PlatformPublishingRequestV1" as const,
    operation: r.operation as (typeof platformPublishingSourceOperations)[number],
    operationReference: parsePublishingReference(r.operationReference),
    templateReference: parsePublishingReference(r.templateReference),
    templateVersionReference: parsePublishingReference(r.templateVersionReference),
    contentDigest: parsePublishingDigest(r.contentDigest),
    templateSourceDigest: parsePublishingDigest(r.templateSourceDigest),
    expectedLifecycle: expected,
    reviewValidUntil: until,
    reasonCode: parsePublishingCode(r.reasonCode),
  });
}
export type PlatformPublishingRequest = ReturnType<typeof parsePlatformPublishingRequest>;
export function parsePlatformPublishingOriginal(value: unknown) {
  const r = closed(value, ["profile", "scope", "request"]);
  if (r.profile !== "PlatformPublishingOriginalV1") return fail();
  return Object.freeze({
    profile: "PlatformPublishingOriginalV1" as const,
    scope: parsePlatformPublishingSourceScope(r.scope),
    request: parsePlatformPublishingRequest(r.request),
  });
}
export type PlatformPublishingOriginal = ReturnType<typeof parsePlatformPublishingOriginal>;
export function platformPublishingIntentDigest(value: unknown) {
  return hash(parsePlatformPublishingOriginal(value));
}
export function parsePlatformPublishingResolve(value: unknown) {
  const r = closed(value, ["profile", "operationReference", "intentDigest"]);
  if (r.profile !== "PlatformPublishingResolveV1") return fail();
  return Object.freeze({
    profile: "PlatformPublishingResolveV1" as const,
    operationReference: parsePublishingReference(r.operationReference),
    intentDigest: parsePublishingDigest(r.intentDigest),
  });
}
export type PlatformPublishingResolve = ReturnType<typeof parsePlatformPublishingResolve>;
const sourceKeys = [
  "profile",
  "sequence",
  "templateSourceDigest",
  "originalCommand",
  "intentDigest",
  "command",
  "auditReference",
] as const;
function sourceBody(value: unknown) {
  const r = closed(value, sourceKeys),
    original = parsePlatformPublishingOriginal(r.originalCommand),
    request = original.request,
    command = validatePlatformPublishingTransition(r.command),
    expected = request.expectedLifecycle,
    digest = parsePublishingDigest(r.intentDigest),
    templateDigest = parsePublishingDigest(r.templateSourceDigest);
  if (
    r.profile !== "PlatformPublishingSourceV1" ||
    digest !== platformPublishingIntentDigest(original) ||
    templateDigest !== request.templateSourceDigest ||
    command.operation !== request.operation ||
    command.operationReference !== request.operationReference ||
    command.currentActorReference !== original.scope.actorReference ||
    command.next.familyReference !== request.templateReference ||
    command.next.snapshotReference !== request.templateVersionReference ||
    command.next.snapshotDigest !== request.contentDigest ||
    (request.operation === "SubmitReview" &&
      command.next.reviewValidUntil !== request.reviewValidUntil)
  )
    return fail();
  if (
    command.current !== null &&
    (!expected ||
      expected.lifecycleReference !== command.current.lifecycleId ||
      expected.version !== command.current.version)
  )
    return fail();
  if (
    command.current === null &&
    (request.operation !== "CreateDraft" ||
      (expected !== null && expected.lifecycleReference === command.next.lifecycleId))
  )
    return fail();
  if (expected === null && sequence(r.sequence) !== 1) return fail();
  return Object.freeze({
    profile: "PlatformPublishingSourceV1" as const,
    sequence: sequence(r.sequence),
    templateSourceDigest: templateDigest,
    originalCommand: original,
    intentDigest: digest,
    command,
    auditReference: parsePublishingReference(r.auditReference),
  });
}
/** Immutable owning result, not proof that a caller has persisted publication. */
export function buildPlatformPublishingSource(value: unknown) {
  const body = sourceBody(value);
  return Object.freeze({ ...body, sourceDigest: hash(body) });
}
export type PlatformPublishingSource = ReturnType<typeof buildPlatformPublishingSource>;
export function parsePlatformPublishingSource(value: unknown): PlatformPublishingSource {
  const r = closed(value, [...sourceKeys, "sourceDigest"]),
    body = sourceBody(Object.fromEntries(sourceKeys.map((key) => [key, r[key]])));
  if (parsePublishingDigest(r.sourceDigest) !== hash(body)) return fail();
  return Object.freeze({ ...body, sourceDigest: parsePublishingDigest(r.sourceDigest) });
}
export function parsePlatformPublishingReceipt(value: unknown) {
  const r = closed(value, [
      "profile",
      "kind",
      "actorReference",
      "purposeCode",
      "operationReference",
      "intentDigest",
      "outcome",
      "originalCommand",
      "source",
      "auditReference",
      "occurredAt",
    ]),
    scope = parsePlatformPublishingSourceScope({
      kind: r.kind,
      actorReference: r.actorReference,
      purposeCode: r.purposeCode,
    }),
    operationReference = parsePublishingReference(r.operationReference),
    intentDigest = parsePublishingDigest(r.intentDigest),
    auditReference = parsePublishingReference(r.auditReference),
    occurredAt = parsePublishingInstant(r.occurredAt);
  if (
    r.profile !== "PlatformPublishingReceiptV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned")
  )
    return fail();
  if (r.outcome === "Abandoned") {
    if (r.originalCommand !== null || r.source !== null) return fail();
    return Object.freeze({
      profile: "PlatformPublishingReceiptV1" as const,
      ...scope,
      operationReference,
      intentDigest,
      outcome: "Abandoned" as const,
      originalCommand: null,
      source: null,
      auditReference,
      occurredAt,
    });
  }
  const original = parsePlatformPublishingOriginal(r.originalCommand),
    source = parsePlatformPublishingSource(r.source);
  if (
    !same(scope, original.scope) ||
    original.request.operationReference !== operationReference ||
    platformPublishingIntentDigest(original) !== intentDigest ||
    !same(original, source.originalCommand) ||
    source.intentDigest !== intentDigest ||
    source.auditReference !== auditReference ||
    source.command.occurredAt !== occurredAt
  )
    return fail();
  return Object.freeze({
    profile: "PlatformPublishingReceiptV1" as const,
    ...scope,
    operationReference,
    intentDigest,
    outcome: "Committed" as const,
    originalCommand: original,
    source,
    auditReference,
    occurredAt,
  });
}
export type PlatformPublishingReceipt = ReturnType<typeof parsePlatformPublishingReceipt>;
function lease(
  r: Record<string, unknown>,
  expectedScope: PlatformPublishingSourceScope,
  now: unknown,
) {
  const scope = parsePlatformPublishingSourceScope(r.scope),
    observedAt = parsePublishingInstant(r.observedAt),
    validUntil = parsePublishingInstant(r.validUntil),
    at = parsePublishingInstant(now);
  if (
    !same(scope, parsePlatformPublishingSourceScope(expectedScope)) ||
    observedAt > at ||
    at >= validUntil ||
    validUntil <= observedAt ||
    Date.parse(validUntil) > Date.parse(observedAt) + 5000
  )
    return fail();
  return { scope, observedAt, validUntil };
}
function familySource(value: unknown, template: string, observedAt: string) {
  if (value === null) return null;
  const source = parsePlatformPublishingSource(value);
  if (source.command.next.familyReference !== template || source.command.occurredAt > observedAt)
    return fail();
  return source;
}
export function parsePlatformPublishingCurrent(
  value: unknown,
  scope: PlatformPublishingSourceScope,
  now: unknown,
) {
  const r = closed(value, [
      "profile",
      "scope",
      "templateReference",
      "lifecycleReference",
      "current",
      "currentRelease",
      "observedAt",
      "validUntil",
    ]),
    bound = lease(r, scope, now),
    templateReference = parsePublishingReference(r.templateReference),
    lifecycleReference =
      r.lifecycleReference === null ? null : parsePublishingReference(r.lifecycleReference),
    current = familySource(r.current, templateReference, bound.observedAt),
    currentRelease = familySource(r.currentRelease, templateReference, bound.observedAt);
  if (
    r.profile !== "PlatformPublishingCurrentV1" ||
    (lifecycleReference !== null &&
      current &&
      current.command.next.lifecycleId !== lifecycleReference) ||
    (lifecycleReference === null && current === null && currentRelease !== null) ||
    (current &&
      currentRelease &&
      current.sequence === currentRelease.sequence &&
      !same(current, currentRelease)) ||
    (currentRelease &&
      (currentRelease.command.operation !== "Publish" ||
        currentRelease.command.next.state !== "Published" ||
        currentRelease.command.release === null ||
        (current &&
          current.command.next.lifecycleId === currentRelease.command.next.lifecycleId &&
          current.command.next.version < currentRelease.command.next.version) ||
        (current?.command.next.state === "Archived" &&
          current.command.next.lifecycleId === currentRelease.command.next.lifecycleId)))
  )
    return fail();
  return Object.freeze({
    profile: "PlatformPublishingCurrentV1" as const,
    ...bound,
    templateReference,
    lifecycleReference,
    current,
    currentRelease,
  });
}
export type PlatformPublishingCurrent = ReturnType<typeof parsePlatformPublishingCurrent>;
export function parsePlatformPublishingExact(
  value: unknown,
  scope: PlatformPublishingSourceScope,
  now: unknown,
) {
  const r = closed(value, [
      "profile",
      "scope",
      "templateReference",
      "sequence",
      "source",
      "observedAt",
      "validUntil",
    ]),
    bound = lease(r, scope, now),
    templateReference = parsePublishingReference(r.templateReference),
    n = sequence(r.sequence),
    source = familySource(r.source, templateReference, bound.observedAt);
  if (r.profile !== "PlatformPublishingExactV1" || (source && source.sequence !== n)) return fail();
  return Object.freeze({
    profile: "PlatformPublishingExactV1" as const,
    ...bound,
    templateReference,
    sequence: n,
    source,
  });
}
export type PlatformPublishingExact = ReturnType<typeof parsePlatformPublishingExact>;
export function parsePlatformPublishingHistory(
  value: unknown,
  scope: PlatformPublishingSourceScope,
  now: unknown,
) {
  const r = closed(value, [
      "profile",
      "scope",
      "templateReference",
      "beforeSequence",
      "items",
      "hasMore",
      "nextBeforeSequence",
      "observedAt",
      "validUntil",
    ]),
    bound = lease(r, scope, now),
    templateReference = parsePublishingReference(r.templateReference),
    before = r.beforeSequence === null ? null : sequence(r.beforeSequence);
  if (
    r.profile !== "PlatformPublishingHistoryV1" ||
    !Array.isArray(r.items) ||
    Object.getPrototypeOf(r.items) !== Array.prototype ||
    r.items.length > 20 ||
    Reflect.ownKeys(r.items).length !== r.items.length + 1 ||
    typeof r.hasMore !== "boolean"
  )
    return fail();
  const items: PlatformPublishingSource[] = [],
    operations = new Set<string>(),
    audits = new Set<string>(),
    versions = new Set<string>();
  let previous = before;
  for (let i = 0; i < r.items.length; i++) {
    const d = Object.getOwnPropertyDescriptor(r.items, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    const source = familySource(d.value, templateReference, bound.observedAt);
    if (!source || (previous !== null && source.sequence >= previous)) return fail();
    const operation = `${source.originalCommand.scope.actorReference}:${source.command.operationReference}`,
      version = `${source.command.next.lifecycleId}:${source.command.next.version}`;
    if (operations.has(operation) || audits.has(source.auditReference) || versions.has(version))
      return fail();
    operations.add(operation);
    audits.add(source.auditReference);
    versions.add(version);
    previous = source.sequence;
    items.push(source);
  }
  const next = r.nextBeforeSequence === null ? null : sequence(r.nextBeforeSequence);
  if (r.hasMore ? items.length !== 20 || next !== previous : next !== null) return fail();
  return Object.freeze({
    profile: "PlatformPublishingHistoryV1" as const,
    ...bound,
    templateReference,
    beforeSequence: before,
    items: Object.freeze(items),
    hasMore: r.hasMore,
    nextBeforeSequence: next,
  });
}
export type PlatformPublishingHistory = ReturnType<typeof parsePlatformPublishingHistory>;
