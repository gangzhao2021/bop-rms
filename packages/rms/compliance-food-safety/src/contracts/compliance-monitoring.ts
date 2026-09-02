import { createComplianceRelatedScope, type ComplianceRelatedScope } from "./compliance-case.js";
import {
  findingSeverities,
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceCode,
  type ComplianceReference,
  type ComplianceScope,
  type FindingSeverity,
} from "./compliance-dashboard.js";

export const temperatureMethods = ["Manual", "Sensor", "Imported"] as const;
export type TemperatureMethod = (typeof temperatureMethods)[number];
export const temperatureThresholdResults = [
  "WithinRange",
  "BelowRange",
  "AboveRange",
  "Missing",
  "Unverified",
  "DeviceFault",
] as const;
export type TemperatureThresholdResult = (typeof temperatureThresholdResults)[number];
export const excursionStatuses = [
  "Open",
  "Contained",
  "DispositionPending",
  "Resolved",
  "Cancelled",
] as const;
export type TemperatureExcursionStatus = (typeof excursionStatuses)[number];
export const cleaningStatuses = [
  "Scheduled",
  "InProgress",
  "Completed",
  "CannotComplete",
  "Missed",
  "VerificationFailed",
  "Verified",
  "Cancelled",
] as const;
export type CleaningStatus = (typeof cleaningStatuses)[number];
export const cleaningVerificationResults = [
  "Pending",
  "Passed",
  "Failed",
  "UnableToVerify",
] as const;
export type CleaningVerificationResult = (typeof cleaningVerificationResults)[number];
export const chemicalResults = [
  "NotRequired",
  "WithinRequirement",
  "OutsideRequirement",
  "Unverified",
] as const;
export type ChemicalResult = (typeof chemicalResults)[number];

export interface TemperatureReadingRecord {
  readonly readingReference: ComplianceReference;
  readonly correctionOfReadingReference: ComplianceReference | null;
  readonly scope: ComplianceScope;
  readonly sequence: number;
  readonly policyVersionReference: ComplianceReference;
  readonly targetScope: ComplianceRelatedScope;
  readonly measurementTypeCode: ComplianceCode;
  readonly value: string | null;
  readonly unitCode: ComplianceCode;
  readonly measuredAt: string;
  readonly capturedAt: string;
  readonly method: TemperatureMethod;
  readonly operatorReference: ComplianceReference;
  readonly deviceReference: ComplianceReference | null;
  readonly thresholdResult: TemperatureThresholdResult;
  readonly calibrationReference: ComplianceReference | null;
  readonly recordedAt: string;
}
export interface TemperatureExcursionRecord {
  readonly excursionReference: ComplianceReference;
  readonly revisionReference: ComplianceReference;
  readonly priorRevisionReference: ComplianceReference | null;
  readonly scope: ComplianceScope;
  readonly recordVersion: number;
  readonly policyVersionReference: ComplianceReference;
  readonly readingReference: ComplianceReference;
  readonly caseReference: ComplianceReference | null;
  readonly severity: FindingSeverity;
  readonly status: TemperatureExcursionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minimumDeviation: string;
  readonly maximumDeviation: string;
  readonly deviationUnitCode: ComplianceCode;
  readonly affectedScope: ComplianceRelatedScope;
  readonly detectionSourceCode: ComplianceCode;
  readonly containmentReference: ComplianceReference | null;
  readonly dispositionReference: ComplianceReference | null;
  readonly rootCauseCode: ComplianceCode | null;
  readonly resolutionCode: ComplianceCode | null;
  readonly recordedAt: string;
  readonly actorReference: ComplianceReference;
}
export interface CleaningRecord {
  readonly cleaningReference: ComplianceReference;
  readonly revisionReference: ComplianceReference;
  readonly priorRevisionReference: ComplianceReference | null;
  readonly scope: ComplianceScope;
  readonly recordVersion: number;
  readonly scheduleReference: ComplianceReference;
  readonly taskReference: ComplianceReference;
  readonly policyVersionReference: ComplianceReference;
  readonly procedureVersionReference: ComplianceReference;
  readonly targetScope: ComplianceRelatedScope;
  readonly assigneeReference: ComplianceReference;
  readonly dueAt: string;
  readonly dueTimezone: string;
  readonly severity: FindingSeverity;
  readonly status: CleaningStatus;
  readonly performedByReference: ComplianceReference | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly methodCode: ComplianceCode;
  readonly chemicalCode: ComplianceCode | null;
  readonly concentration: string | null;
  readonly concentrationUnitCode: ComplianceCode | null;
  readonly chemicalResult: ChemicalResult;
  readonly evidenceReferences: readonly ComplianceReference[];
  readonly exceptionCode: ComplianceCode | null;
  readonly independentVerificationRequired: boolean;
  readonly verificationResult: CleaningVerificationResult;
  readonly verifierReference: ComplianceReference | null;
  readonly verifiedAt: string | null;
  readonly safetyReviewReference: ComplianceReference | null;
  readonly recordedAt: string;
  readonly actorReference: ComplianceReference;
}

const invalid = (): never => {
  throw new Error("Compliance monitoring input is invalid");
};
function exact(value: unknown, fields: readonly string[]) {
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
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : invalid();
const positive = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : invalid();
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const decimalPattern = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/u;
const negativeZeroPattern = /^-0(?:\.0+)?$/u;
export const parseMonitoringDecimal = (value: unknown): string =>
  typeof value === "string" && decimalPattern.test(value) && !negativeZeroPattern.test(value)
    ? value
    : invalid();
const timezone = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 64) return invalid();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
  } catch {
    return invalid();
  }
  return value;
};
function references(value: unknown): readonly ComplianceReference[] {
  if (!Array.isArray(value) || value.length > 20) return invalid();
  const parsed = value.map(parseComplianceReference);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return Object.freeze(parsed);
}
function revision(version: number, prior: ComplianceReference | null) {
  if ((version === 1) !== (prior === null)) return invalid();
}

export function createTemperatureReadingRecord(value: unknown): TemperatureReadingRecord {
  const raw = exact(value, [
    "readingReference",
    "correctionOfReadingReference",
    "scope",
    "sequence",
    "policyVersionReference",
    "targetScope",
    "measurementTypeCode",
    "value",
    "unitCode",
    "measuredAt",
    "capturedAt",
    "method",
    "operatorReference",
    "deviceReference",
    "thresholdResult",
    "calibrationReference",
    "recordedAt",
  ]);
  const method = oneOf(raw.method, temperatureMethods);
  const thresholdResult = oneOf(raw.thresholdResult, temperatureThresholdResults);
  const observedValue = nullable(raw.value, parseMonitoringDecimal);
  const deviceReference = nullable(raw.deviceReference, parseComplianceReference);
  const calibrationReference = nullable(raw.calibrationReference, parseComplianceReference);
  if (
    ["Missing", "DeviceFault"].includes(thresholdResult) !== (observedValue === null) ||
    (method === "Sensor" && (deviceReference === null || calibrationReference === null)) ||
    (thresholdResult === "DeviceFault" && deviceReference === null)
  )
    return invalid();
  const measuredAt = parseComplianceInstant(raw.measuredAt);
  const capturedAt = parseComplianceInstant(raw.capturedAt);
  const recordedAt = parseComplianceInstant(raw.recordedAt);
  if (
    Date.parse(capturedAt) < Date.parse(measuredAt) ||
    Date.parse(recordedAt) < Date.parse(capturedAt)
  )
    return invalid();
  return Object.freeze({
    readingReference: parseComplianceReference(raw.readingReference),
    correctionOfReadingReference: nullable(
      raw.correctionOfReadingReference,
      parseComplianceReference,
    ),
    scope: parseComplianceScope(raw.scope),
    sequence: positive(raw.sequence),
    policyVersionReference: parseComplianceReference(raw.policyVersionReference),
    targetScope: createComplianceRelatedScope(raw.targetScope),
    measurementTypeCode: parseComplianceCode(raw.measurementTypeCode),
    value: observedValue,
    unitCode: parseComplianceCode(raw.unitCode),
    measuredAt,
    capturedAt,
    method,
    operatorReference: parseComplianceReference(raw.operatorReference),
    deviceReference,
    thresholdResult,
    calibrationReference,
    recordedAt,
  });
}

export function createTemperatureExcursionRecord(value: unknown): TemperatureExcursionRecord {
  const raw = exact(value, [
    "excursionReference",
    "revisionReference",
    "priorRevisionReference",
    "scope",
    "recordVersion",
    "policyVersionReference",
    "readingReference",
    "caseReference",
    "severity",
    "status",
    "startedAt",
    "endedAt",
    "minimumDeviation",
    "maximumDeviation",
    "deviationUnitCode",
    "affectedScope",
    "detectionSourceCode",
    "containmentReference",
    "dispositionReference",
    "rootCauseCode",
    "resolutionCode",
    "recordedAt",
    "actorReference",
  ]);
  const recordVersion = positive(raw.recordVersion);
  const priorRevisionReference = nullable(raw.priorRevisionReference, parseComplianceReference);
  revision(recordVersion, priorRevisionReference);
  const status = oneOf(raw.status, excursionStatuses);
  const endedAt = nullable(raw.endedAt, parseComplianceInstant);
  const containmentReference = nullable(raw.containmentReference, parseComplianceReference);
  const dispositionReference = nullable(raw.dispositionReference, parseComplianceReference);
  const rootCauseCode = nullable(raw.rootCauseCode, parseComplianceCode);
  const resolutionCode = nullable(raw.resolutionCode, parseComplianceCode);
  const startedAt = parseComplianceInstant(raw.startedAt);
  if (
    (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) ||
    (status === "Contained" && containmentReference === null) ||
    (["DispositionPending", "Resolved"].includes(status) && containmentReference === null) ||
    (status === "Resolved") !==
      (endedAt !== null &&
        dispositionReference !== null &&
        rootCauseCode !== null &&
        resolutionCode !== null)
  )
    return invalid();
  return Object.freeze({
    excursionReference: parseComplianceReference(raw.excursionReference),
    revisionReference: parseComplianceReference(raw.revisionReference),
    priorRevisionReference,
    scope: parseComplianceScope(raw.scope),
    recordVersion,
    policyVersionReference: parseComplianceReference(raw.policyVersionReference),
    readingReference: parseComplianceReference(raw.readingReference),
    caseReference: nullable(raw.caseReference, parseComplianceReference),
    severity: oneOf(raw.severity, findingSeverities),
    status,
    startedAt,
    endedAt,
    minimumDeviation: parseMonitoringDecimal(raw.minimumDeviation),
    maximumDeviation: parseMonitoringDecimal(raw.maximumDeviation),
    deviationUnitCode: parseComplianceCode(raw.deviationUnitCode),
    affectedScope: createComplianceRelatedScope(raw.affectedScope),
    detectionSourceCode: parseComplianceCode(raw.detectionSourceCode),
    containmentReference,
    dispositionReference,
    rootCauseCode,
    resolutionCode,
    recordedAt: parseComplianceInstant(raw.recordedAt),
    actorReference: parseComplianceReference(raw.actorReference),
  });
}

export function createCleaningRecord(value: unknown): CleaningRecord {
  const raw = exact(value, [
    "cleaningReference",
    "revisionReference",
    "priorRevisionReference",
    "scope",
    "recordVersion",
    "scheduleReference",
    "taskReference",
    "policyVersionReference",
    "procedureVersionReference",
    "targetScope",
    "assigneeReference",
    "dueAt",
    "dueTimezone",
    "severity",
    "status",
    "performedByReference",
    "startedAt",
    "completedAt",
    "methodCode",
    "chemicalCode",
    "concentration",
    "concentrationUnitCode",
    "chemicalResult",
    "evidenceReferences",
    "exceptionCode",
    "independentVerificationRequired",
    "verificationResult",
    "verifierReference",
    "verifiedAt",
    "safetyReviewReference",
    "recordedAt",
    "actorReference",
  ]);
  const recordVersion = positive(raw.recordVersion);
  const priorRevisionReference = nullable(raw.priorRevisionReference, parseComplianceReference);
  revision(recordVersion, priorRevisionReference);
  const status = oneOf(raw.status, cleaningStatuses);
  const performedByReference = nullable(raw.performedByReference, parseComplianceReference);
  const startedAt = nullable(raw.startedAt, parseComplianceInstant);
  const completedAt = nullable(raw.completedAt, parseComplianceInstant);
  const chemicalCode = nullable(raw.chemicalCode, parseComplianceCode);
  const concentration = nullable(raw.concentration, parseMonitoringDecimal);
  const concentrationUnitCode = nullable(raw.concentrationUnitCode, parseComplianceCode);
  const chemicalResult = oneOf(raw.chemicalResult, chemicalResults);
  const exceptionCode = nullable(raw.exceptionCode, parseComplianceCode);
  if (typeof raw.independentVerificationRequired !== "boolean") return invalid();
  const verificationResult = oneOf(raw.verificationResult, cleaningVerificationResults);
  const verifierReference = nullable(raw.verifierReference, parseComplianceReference);
  const verifiedAt = nullable(raw.verifiedAt, parseComplianceInstant);
  const safetyReviewReference = nullable(raw.safetyReviewReference, parseComplianceReference);
  const complete = ["Completed", "VerificationFailed", "Verified"].includes(status);
  const evidenceReferences = references(raw.evidenceReferences);
  if (
    (status === "Scheduled" &&
      (startedAt !== null || completedAt !== null || performedByReference !== null)) ||
    (status === "InProgress" &&
      (startedAt === null || completedAt !== null || performedByReference === null)) ||
    (complete && (startedAt === null || completedAt === null || performedByReference === null)) ||
    (complete && evidenceReferences.length === 0) ||
    (["CannotComplete", "Missed", "Cancelled"].includes(status) && exceptionCode === null) ||
    (chemicalCode === null) !== (concentration === null || concentrationUnitCode === null) ||
    (chemicalResult === "OutsideRequirement" && safetyReviewReference === null) ||
    (status === "Verified" && verificationResult !== "Passed") ||
    (status === "VerificationFailed" && verificationResult !== "Failed") ||
    (status === "Completed" && !["Pending", "UnableToVerify"].includes(verificationResult)) ||
    (!["Completed", "VerificationFailed", "Verified"].includes(status) &&
      verificationResult !== "Pending") ||
    (verificationResult === "Pending") !== (verifierReference === null && verifiedAt === null) ||
    (verificationResult !== "Pending" && (verifierReference === null || verifiedAt === null)) ||
    (raw.independentVerificationRequired &&
      verifierReference !== null &&
      verifierReference === performedByReference)
  )
    return invalid();
  return Object.freeze({
    cleaningReference: parseComplianceReference(raw.cleaningReference),
    revisionReference: parseComplianceReference(raw.revisionReference),
    priorRevisionReference,
    scope: parseComplianceScope(raw.scope),
    recordVersion,
    scheduleReference: parseComplianceReference(raw.scheduleReference),
    taskReference: parseComplianceReference(raw.taskReference),
    policyVersionReference: parseComplianceReference(raw.policyVersionReference),
    procedureVersionReference: parseComplianceReference(raw.procedureVersionReference),
    targetScope: createComplianceRelatedScope(raw.targetScope),
    assigneeReference: parseComplianceReference(raw.assigneeReference),
    dueAt: parseComplianceInstant(raw.dueAt),
    dueTimezone: timezone(raw.dueTimezone),
    severity: oneOf(raw.severity, findingSeverities),
    status,
    performedByReference,
    startedAt,
    completedAt,
    methodCode: parseComplianceCode(raw.methodCode),
    chemicalCode,
    concentration,
    concentrationUnitCode,
    chemicalResult,
    evidenceReferences,
    exceptionCode,
    independentVerificationRequired: raw.independentVerificationRequired,
    verificationResult,
    verifierReference,
    verifiedAt,
    safetyReviewReference,
    recordedAt: parseComplianceInstant(raw.recordedAt),
    actorReference: parseComplianceReference(raw.actorReference),
  });
}
