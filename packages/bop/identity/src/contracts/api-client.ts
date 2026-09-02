import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type CanonicalInstant,
} from "./identity-actor.js";
export type ApiClientReference = string & { readonly __apiClientReference: unique symbol };
export type ApiClientCode = string & { readonly __apiClientCode: unique symbol };
export interface ApiClientScope {
  readonly tenantReference: ApiClientReference;
  readonly brandReference: ApiClientReference;
  readonly storeReference: ApiClientReference | null;
}
export interface ApiClientCredentialMetadata {
  readonly credentialReference: ApiClientReference;
  readonly credentialVersion: number;
  readonly status: "Active" | "Revoked";
  readonly issuedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly revokedAt: CanonicalInstant | null;
}
export interface ApiClientRecord {
  readonly clientReference: ApiClientReference;
  readonly revision: number;
  readonly scope: ApiClientScope;
  readonly nameCode: ApiClientCode;
  readonly ownerReference: ApiClientReference;
  readonly environment: "Sandbox" | "Production";
  readonly status: "Requested" | "PendingApproval" | "Active" | "Suspended" | "Revoked";
  readonly requestedScopeCodes: readonly ApiClientCode[];
  readonly requestedGrantCodes: readonly ApiClientCode[];
  readonly grantSetReference: ApiClientReference | null;
  readonly approvalEvidenceReference: ApiClientReference | null;
  readonly credential: ApiClientCredentialMetadata | null;
  readonly lastUsedAt: CanonicalInstant | null;
  readonly auditSummaryReference: ApiClientReference;
  readonly createdByReference: ApiClientReference;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}
export class ApiClientContractError extends Error {
  constructor() {
    super("API_CLIENT_INPUT_INVALID");
    this.name = "ApiClientContractError";
  }
}
const fail = (): never => {
  throw new ApiClientContractError();
};
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
export const parseApiClientReference = (value: unknown) => {
  try {
    return parseOpaqueUuidV7(value, "IDENTITY_INPUT_INVALID") as ApiClientReference;
  } catch {
    return fail();
  }
};
export const parseApiClientCode = (value: unknown) =>
  typeof value === "string" && CODE.test(value) ? (value as ApiClientCode) : fail();
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const nullableRef = (value: unknown) => (value === null ? null : parseApiClientReference(value));
const nullableInstant = (value: unknown) => (value === null ? null : parseCanonicalInstant(value));
const codes = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return fail();
  const output = Object.freeze(value.map(parseApiClientCode));
  return new Set(output).size === output.length ? output : fail();
};
function credential(value: unknown): ApiClientCredentialMetadata | null {
  if (value === null) return null;
  const raw = readClosedRecord(value, [
    "credentialReference",
    "credentialVersion",
    "status",
    "issuedAt",
    "expiresAt",
    "revokedAt",
  ]);
  const status = raw.status === "Active" || raw.status === "Revoked" ? raw.status : fail();
  const issuedAt = parseCanonicalInstant(raw.issuedAt);
  const expiresAt = parseCanonicalInstant(raw.expiresAt);
  const revokedAt = nullableInstant(raw.revokedAt);
  if (
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    (status === "Revoked") !== (revokedAt !== null)
  )
    return fail();
  return Object.freeze({
    credentialReference: parseApiClientReference(raw.credentialReference),
    credentialVersion: positive(raw.credentialVersion),
    status,
    issuedAt,
    expiresAt,
    revokedAt,
  });
}
function parseApiClientRecord(value: unknown): ApiClientRecord {
  const raw = readClosedRecord(value, [
    "clientReference",
    "revision",
    "scope",
    "nameCode",
    "ownerReference",
    "environment",
    "status",
    "requestedScopeCodes",
    "requestedGrantCodes",
    "grantSetReference",
    "approvalEvidenceReference",
    "credential",
    "lastUsedAt",
    "auditSummaryReference",
    "createdByReference",
    "createdAt",
    "updatedAt",
  ]);
  const scopeRaw = readClosedRecord(raw.scope, [
    "tenantReference",
    "brandReference",
    "storeReference",
  ]);
  const status = ["Requested", "PendingApproval", "Active", "Suspended", "Revoked"].includes(
    String(raw.status),
  )
    ? (raw.status as ApiClientRecord["status"])
    : fail();
  const grantSetReference = nullableRef(raw.grantSetReference);
  const approvalEvidenceReference = nullableRef(raw.approvalEvidenceReference);
  const credentialMetadata = credential(raw.credential);
  const lastUsedAt = nullableInstant(raw.lastUsedAt);
  const createdAt = parseCanonicalInstant(raw.createdAt);
  const updatedAt = parseCanonicalInstant(raw.updatedAt);
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (lastUsedAt !== null && Date.parse(lastUsedAt) > Date.parse(updatedAt))
  )
    return fail();
  if (
    (["Requested", "PendingApproval"].includes(status) &&
      (grantSetReference !== null ||
        approvalEvidenceReference !== null ||
        credentialMetadata !== null)) ||
    (["Active", "Suspended", "Revoked"].includes(status) &&
      (grantSetReference === null ||
        approvalEvidenceReference === null ||
        credentialMetadata === null)) ||
    (status === "Revoked" && credentialMetadata?.status !== "Revoked") ||
    (status !== "Revoked" && credentialMetadata?.status === "Revoked")
  )
    return fail();
  return Object.freeze({
    clientReference: parseApiClientReference(raw.clientReference),
    revision: positive(raw.revision),
    scope: Object.freeze({
      tenantReference: parseApiClientReference(scopeRaw.tenantReference),
      brandReference: parseApiClientReference(scopeRaw.brandReference),
      storeReference: nullableRef(scopeRaw.storeReference),
    }),
    nameCode: parseApiClientCode(raw.nameCode),
    ownerReference: parseApiClientReference(raw.ownerReference),
    environment:
      raw.environment === "Sandbox" || raw.environment === "Production" ? raw.environment : fail(),
    status,
    requestedScopeCodes: codes(raw.requestedScopeCodes),
    requestedGrantCodes: codes(raw.requestedGrantCodes),
    grantSetReference,
    approvalEvidenceReference,
    credential: credentialMetadata,
    lastUsedAt,
    auditSummaryReference: parseApiClientReference(raw.auditSummaryReference),
    createdByReference: parseApiClientReference(raw.createdByReference),
    createdAt,
    updatedAt,
  });
}

export function createApiClientRecord(value: unknown): ApiClientRecord {
  try {
    return parseApiClientRecord(value);
  } catch (error) {
    if (error instanceof ApiClientContractError) throw error;
    return fail();
  }
}
