export type CommunicationReference = string & { readonly __communicationReference: unique symbol };
export type CommunicationChannel = "Email" | "SMS" | "Push";
export type CommunicationClass = "Operational" | "Marketing";
export type CommunicationTemplateStatus = "Draft" | "InReview" | "Published" | "Archived";
export interface CommunicationTemplateVersion {
  readonly versionReference: CommunicationReference;
  readonly sequence: number;
  readonly purpose: CommunicationClass;
  readonly locale: string;
  readonly channel: CommunicationChannel;
  readonly requiredVariables: readonly string[];
  readonly previewFixtureReference: CommunicationReference;
  readonly previewEscaped: true;
  readonly trackingProhibited: true;
  readonly authoredBy: CommunicationReference;
  readonly approvedBy: CommunicationReference | null;
  readonly status: CommunicationTemplateStatus;
  readonly createdAt: string;
}
export interface CommunicationTemplate {
  readonly templateReference: CommunicationReference;
  readonly brandReference: CommunicationReference;
  readonly templateKey: string;
  readonly displayName: string;
  readonly versions: readonly CommunicationTemplateVersion[];
  readonly aggregateVersion: number;
  readonly updatedAt: string;
}
const fail = (): never => {
  throw new Error("Communication governance input invalid");
};
const reference = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
    ? (v as CommunicationReference)
    : fail();
const instant = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  new Date(Date.parse(v)).toISOString() === v
    ? v
    : fail();
const clean = (v: unknown) =>
  typeof v === "string" && v.trim() === v && /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u.test(v) ? v : fail();
const key = (v: unknown) =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(v) ? v : fail();
const expected = (template: CommunicationTemplate, version: number) => {
  if (!Number.isSafeInteger(version) || version !== template.aggregateVersion) fail();
};
const next = (
  template: CommunicationTemplate,
  versions: readonly CommunicationTemplateVersion[],
  at: string,
): CommunicationTemplate => {
  const occurredAt = instant(at);
  if (template.updatedAt > occurredAt) fail();
  return Object.freeze({
    ...template,
    versions: Object.freeze(versions),
    aggregateVersion: template.aggregateVersion + 1,
    updatedAt: occurredAt,
  });
};
export function createCommunicationTemplate(input: {
  templateReference: unknown;
  brandReference: unknown;
  templateKey: unknown;
  displayName: unknown;
  occurredAt: unknown;
}): CommunicationTemplate {
  return Object.freeze({
    templateReference: reference(input.templateReference),
    brandReference: reference(input.brandReference),
    templateKey: key(input.templateKey),
    displayName: clean(input.displayName),
    versions: Object.freeze([]),
    aggregateVersion: 1,
    updatedAt: instant(input.occurredAt),
  });
}
export function addCommunicationTemplateVersion(
  template: CommunicationTemplate,
  input: {
    expectedVersion: number;
    versionReference: unknown;
    purpose: CommunicationClass;
    locale: unknown;
    channel: CommunicationChannel;
    requiredVariables: readonly unknown[];
    previewFixtureReference: unknown;
    previewEscaped: boolean;
    trackingProhibited: boolean;
    actorReference: unknown;
    occurredAt: unknown;
  },
): CommunicationTemplate {
  expected(template, input.expectedVersion);
  if (
    !["Operational", "Marketing"].includes(input.purpose) ||
    !["Email", "SMS", "Push"].includes(input.channel) ||
    input.previewEscaped !== true ||
    input.trackingProhibited !== true ||
    !Array.isArray(input.requiredVariables) ||
    input.requiredVariables.length > 40
  )
    fail();
  const variables = input.requiredVariables.map(key);
  if (new Set(variables).size !== variables.length) fail();
  const prior = template.versions.at(-1);
  if (prior && prior.status !== "Archived") fail();
  const version = Object.freeze({
    versionReference: reference(input.versionReference),
    sequence: (prior?.sequence ?? 0) + 1,
    purpose: input.purpose,
    locale: clean(input.locale),
    channel: input.channel,
    requiredVariables: Object.freeze(variables),
    previewFixtureReference: reference(input.previewFixtureReference),
    previewEscaped: true as const,
    trackingProhibited: true as const,
    authoredBy: reference(input.actorReference),
    approvedBy: null,
    status: "Draft" as const,
    createdAt: instant(input.occurredAt),
  });
  return next(template, [...template.versions, version], version.createdAt);
}
export function transitionCommunicationTemplate(
  template: CommunicationTemplate,
  input: {
    expectedVersion: number;
    targetStatus: "InReview" | "Published" | "Archived";
    actorReference: unknown;
    approvalEvidenceReference: unknown | null;
    occurredAt: unknown;
  },
): CommunicationTemplate {
  expected(template, input.expectedVersion);
  const current = template.versions.at(-1);
  if (!current) fail();
  const version = current as NonNullable<typeof current>;
  const actor = reference(input.actorReference);
  if (
    (input.targetStatus === "InReview" && version.status !== "Draft") ||
    (input.targetStatus === "Published" && version.status !== "InReview") ||
    (input.targetStatus === "Archived" && version.status !== "Published")
  )
    fail();
  if (input.targetStatus === "Published") {
    if (actor === version.authoredBy || input.approvalEvidenceReference === null) fail();
    reference(input.approvalEvidenceReference);
  }
  const revised = Object.freeze({
    ...version,
    status: input.targetStatus,
    approvedBy: input.targetStatus === "Published" ? actor : version.approvedBy,
  });
  return next(template, [...template.versions.slice(0, -1), revised], input.occurredAt as string);
}
export function mayResendCommunication(input: {
  classification: CommunicationClass;
  suppressed: boolean;
  providerState: "NotAttempted" | "Delivered" | "Unknown" | "Rejected" | "DeadLettered";
  authorized: boolean;
}): boolean {
  return (
    input.classification === "Operational" &&
    !input.suppressed &&
    input.authorized &&
    ["Unknown", "Rejected", "DeadLettered"].includes(input.providerState)
  );
}
