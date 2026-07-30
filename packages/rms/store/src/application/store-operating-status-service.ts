import { createEffectiveConfigurationVersion } from "@bop/effective-period";
import { createPublishingLifecycleRecord, createPublishingReleaseRecord } from "@bop/publishing";
import type { CanonicalInstant } from "@bop/tenant";
import {
  parseGetStoreOperatingStatusRequest,
  parseStoreOperatingConfigurationCandidateShape,
  parseStoreOperatingStatusResolutionEvidence,
  StoreOperatingContractError,
  type GetStoreOperatingStatusResult,
  type StoreLocalDate,
  type StoreLocalTime,
  type StoreOperatingConfigurationCandidate,
  type StoreOperatingStatus,
  type StoreOperatingStatusResolutionEvidence,
} from "../contracts/store-operating-status.js";
import { evaluateStoreOperatingStatus } from "../domain/evaluate-store-operating-status.js";
import type {
  StoreOperatingStatusPorts,
  StoreOperatingTelemetryReason,
} from "./ports/store-operating-status-ports.js";

const invalidRequest = Object.freeze({ status: "InvalidRequest" } as const);
const unavailable = Object.freeze({ status: "StoreUnavailable" } as const);

function record(
  ports: StoreOperatingStatusPorts,
  outcome: "AVAILABLE" | "INVALID_REQUEST" | "STORE_UNAVAILABLE",
  reason: StoreOperatingTelemetryReason,
): void {
  try {
    ports.telemetry.record({ operation: "GetStoreOperatingStatus", outcome, reason });
  } catch {
    // Telemetry must not change public query behavior.
  }
}

function sameScope(
  scope: {
    readonly kind: string;
    readonly brandReference: string;
    readonly storeReference: string | null;
  },
  evidence: StoreOperatingStatusResolutionEvidence,
): boolean {
  return (
    scope.kind === "Store" &&
    scope.brandReference === evidence.brandReference &&
    scope.storeReference === evidence.storeReference
  );
}

function validatePublishing(
  candidate: StoreOperatingConfigurationCandidate,
  evidence: StoreOperatingStatusResolutionEvidence,
  evaluatedAt: CanonicalInstant,
): void {
  const lifecycle = createPublishingLifecycleRecord(candidate.publishingLifecycle);
  const release = createPublishingReleaseRecord(candidate.publishingRelease);
  if (
    lifecycle.state !== "Published" ||
    lifecycle.configurationType !== "STORE_OPERATING_HOURS" ||
    lifecycle.purposeCode !== "CUSTOMER_ENTRY" ||
    !sameScope(lifecycle.scope, evidence) ||
    String(lifecycle.snapshotReference) !== candidate.configurationReference ||
    String(lifecycle.snapshotDigest) !== candidate.contentDigest ||
    release.sourceLifecycleId !== lifecycle.lifecycleId ||
    release.familyReference !== lifecycle.familyReference ||
    release.configurationType !== lifecycle.configurationType ||
    release.purposeCode !== lifecycle.purposeCode ||
    String(release.snapshotReference) !== candidate.configurationReference ||
    String(release.snapshotDigest) !== candidate.contentDigest ||
    !sameScope(release.scope, evidence) ||
    Date.parse(release.createdAt) > Date.parse(evaluatedAt)
  )
    throw new StoreOperatingContractError("STORE_OPERATING_CONFIGURATION_INVALID");
}

function validateEffectivePeriod(
  candidate: StoreOperatingConfigurationCandidate,
  evidence: StoreOperatingStatusResolutionEvidence,
  evaluatedAt: CanonicalInstant,
): StoreOperatingConfigurationCandidate {
  const effectiveVersion = createEffectiveConfigurationVersion(candidate.effectiveVersion);
  if (
    effectiveVersion.configurationType !== "STORE_OPERATING_HOURS" ||
    effectiveVersion.purposeCode !== "CUSTOMER_ENTRY" ||
    !sameScope(effectiveVersion.scope, evidence) ||
    String(effectiveVersion.configurationReference) !== candidate.configurationReference ||
    String(effectiveVersion.snapshotReference) !== candidate.configurationReference ||
    String(effectiveVersion.snapshotDigest) !== candidate.contentDigest ||
    String(effectiveVersion.releaseReference) !== candidate.publishingRelease.releaseId ||
    effectiveVersion.period.timeZone !== candidate.timeZone ||
    Date.parse(effectiveVersion.createdAt) > Date.parse(evaluatedAt)
  )
    throw new StoreOperatingContractError("STORE_OPERATING_CONFIGURATION_INVALID");
  return Object.freeze({ ...candidate, effectiveVersion });
}

function localFields(
  evaluatedAt: CanonicalInstant,
  timeZone: string,
): Readonly<{
  localDate: StoreLocalDate;
  localTime: StoreLocalTime;
  isoWeekday: number;
}> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(evaluatedAt))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdays: Readonly<Record<string, number>> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const isoWeekday = values.weekday === undefined ? undefined : weekdays[values.weekday];
  if (
    values.year === undefined ||
    values.month === undefined ||
    values.day === undefined ||
    values.hour === undefined ||
    values.minute === undefined ||
    values.second === undefined ||
    isoWeekday === undefined
  )
    throw new StoreOperatingContractError("STORE_OPERATING_CONFIGURATION_INVALID");
  return Object.freeze({
    localDate: `${values.year}-${values.month}-${values.day}` as StoreLocalDate,
    localTime: `${values.hour}:${values.minute}:${values.second}` as StoreLocalTime,
    isoWeekday,
  });
}

function resolveStatus(input: {
  readonly evidence: StoreOperatingStatusResolutionEvidence;
  readonly candidates: unknown;
  readonly evaluatedAt: CanonicalInstant;
}): StoreOperatingStatus | null {
  if (!Array.isArray(input.candidates) || input.candidates.length > 50)
    throw new StoreOperatingContractError("STORE_OPERATING_CONFIGURATION_INVALID");
  const candidates = input.candidates.map((value) => {
    const candidate = parseStoreOperatingConfigurationCandidateShape(value);
    if (
      candidate.brandReference !== input.evidence.brandReference ||
      candidate.storeReference !== input.evidence.storeReference
    )
      throw new StoreOperatingContractError("STORE_OPERATING_CONFIGURATION_INVALID");
    validatePublishing(candidate, input.evidence, input.evaluatedAt);
    return validateEffectivePeriod(candidate, input.evidence, input.evaluatedAt);
  });
  const matches = candidates.filter((candidate) => {
    const from = Date.parse(candidate.effectiveVersion.period.effectiveFrom.instant);
    const until =
      candidate.effectiveVersion.period.effectiveUntil === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(candidate.effectiveVersion.period.effectiveUntil.instant);
    const evaluatedAt = Date.parse(input.evaluatedAt);
    return evaluatedAt >= from && evaluatedAt < until;
  });
  if (matches.length !== 1 || matches[0] === undefined) return null;
  const selected = matches[0];
  const local = localFields(input.evaluatedAt, selected.timeZone);
  const evaluation = evaluateStoreOperatingStatus({
    evaluatedAt: input.evaluatedAt,
    ...local,
    weeklySchedule: selected.weeklySchedule,
    exceptions: selected.exceptions,
    temporaryClosures: selected.temporaryClosures,
  });
  return Object.freeze({
    configurationReference: selected.configurationReference,
    configurationVersion: selected.configurationVersion,
    releaseReference: selected.publishingRelease.releaseId,
    contentDigest: selected.contentDigest,
    evaluatedAt: input.evaluatedAt,
    timeZone: selected.timeZone,
    localDate: local.localDate,
    localTime: local.localTime,
    state: evaluation.state,
    availableServiceModes: evaluation.availableServiceModes,
  });
}

export function createStoreOperatingStatusService(ports: StoreOperatingStatusPorts) {
  return Object.freeze({
    async getStoreOperatingStatus(request: unknown): Promise<GetStoreOperatingStatusResult> {
      let parsed;
      try {
        parsed = parseGetStoreOperatingStatusRequest(request);
      } catch {
        record(ports, "INVALID_REQUEST", "REQUEST_INVALID");
        return invalidRequest;
      }

      try {
        const rawEvidence = await ports.resolution.resolve({
          publicStoreReference: parsed.publicStoreReference,
          evaluatedAt: parsed.evaluatedAt,
          purpose: parsed.purpose,
        });
        if (rawEvidence === null) {
          record(ports, "STORE_UNAVAILABLE", "SCOPE_UNAVAILABLE");
          return unavailable;
        }
        const evidence = parseStoreOperatingStatusResolutionEvidence(rawEvidence);
        if (
          evidence.publicStoreReference !== parsed.publicStoreReference ||
          evidence.brandLifecycle !== "Active" ||
          evidence.storeLifecycle !== "Active" ||
          Date.parse(evidence.validUntil) <= Date.parse(parsed.evaluatedAt)
        ) {
          record(ports, "STORE_UNAVAILABLE", "SCOPE_UNAVAILABLE");
          return unavailable;
        }
        const candidates = await ports.configurations.loadCandidates({
          brandReference: evidence.brandReference,
          storeReference: evidence.storeReference,
        });
        const operatingStatus = resolveStatus({
          evidence,
          candidates,
          evaluatedAt: parsed.evaluatedAt,
        });
        if (operatingStatus === null) {
          record(ports, "STORE_UNAVAILABLE", "CONFIGURATION_UNAVAILABLE");
          return unavailable;
        }
        record(ports, "AVAILABLE", "STATUS_AVAILABLE");
        return Object.freeze({ status: "Available", operatingStatus });
      } catch {
        record(ports, "STORE_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE");
        return unavailable;
      }
    },
  });
}
