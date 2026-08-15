import {
  createApiClientRecord,
  parseApiClientCode,
  parseApiClientReference,
  type ApiClientRecord,
  type ApiClientScope,
} from "../contracts/api-client.js";
import type {
  ApiClientCommand,
  ApiClientOperation,
  ApiClientPorts,
} from "./ports/api-client-ports.js";
export type ApiClientServiceErrorCode =
  | "API_CLIENT_INPUT_INVALID"
  | "API_CLIENT_PERMISSION_DENIED"
  | "API_CLIENT_VERSION_CONFLICT"
  | "API_CLIENT_IDEMPOTENCY_CONFLICT"
  | "API_CLIENT_LIFECYCLE_CONFLICT"
  | "API_CLIENT_APPROVAL_INVALID"
  | "API_CLIENT_GRANT_INVALID"
  | "API_CLIENT_CREDENTIAL_INVALID"
  | "API_CLIENT_DEPENDENCY_UNAVAILABLE";
export class ApiClientServiceError extends Error {
  constructor(readonly code: ApiClientServiceErrorCode) {
    super("API Client operation is unavailable");
    this.name = "ApiClientServiceError";
  }
}
const fail = (code: ApiClientServiceErrorCode = "API_CLIENT_INPUT_INVALID"): never => {
  throw new ApiClientServiceError(code);
};
function dependency(error: unknown): never {
  if (error instanceof ApiClientServiceError) throw error;
  throw new ApiClientServiceError("API_CLIENT_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (a: ApiClientScope, b: ApiClientScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;
function sameExcept(
  a: ApiClientRecord,
  b: ApiClientRecord,
  mutable: readonly (keyof ApiClientRecord)[],
) {
  const ignored = new Set<keyof ApiClientRecord>([
    "revision",
    "updatedAt",
    "auditSummaryReference",
    ...mutable,
  ]);
  return (Object.keys(a) as (keyof ApiClientRecord)[]).every(
    (key) => ignored.has(key) || JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
}
export function createApiClientService(ports: ApiClientPorts) {
  async function apply(input: {
    readonly command: ApiClientCommand;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly expectedRevision: number;
    readonly client: unknown;
    readonly purposeCode: string;
    readonly occurredAt: string;
  }) {
    exact(input, [
      "command",
      "operationReference",
      "actorReference",
      "expectedRevision",
      "client",
      "purposeCode",
      "occurredAt",
    ]);
    let client: ApiClientRecord;
    let operationReference: ReturnType<typeof parseApiClientReference>;
    let actorReference: ReturnType<typeof parseApiClientReference>;
    try {
      client = createApiClientRecord(input.client);
      operationReference = parseApiClientReference(input.operationReference);
      actorReference = parseApiClientReference(input.actorReference);
      parseApiClientCode(input.purposeCode);
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        client.updatedAt !== input.occurredAt
      )
        return fail();
    } catch {
      return fail();
    }
    const allowed = await ports.authorization
      .authorize({
        command: input.command,
        actorReference,
        targetReference: client.clientReference,
        scope: client.scope,
        purposeCode: input.purposeCode,
        observedAt: input.occurredAt,
      })
      .catch(dependency);
    if (!allowed) return fail("API_CLIENT_PERMISSION_DENIED");
    const digest = ports.references.hashIntent(JSON.stringify(input));
    const existing = await ports.repository.resolveOperation(operationReference).catch(dependency);
    if (existing !== null) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("API_CLIENT_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, client: existing.client });
    }
    const latest = await ports.repository.loadLatest(client.clientReference).catch(dependency);
    if (
      client.revision !== input.expectedRevision + 1 ||
      (latest === null ? input.expectedRevision !== 0 : latest.revision !== input.expectedRevision)
    )
      return fail("API_CLIENT_VERSION_CONFLICT");
    if (input.command === "RequestApiClient") {
      if (
        latest !== null ||
        client.revision !== 1 ||
        client.status !== "Requested" ||
        client.createdByReference !== actorReference ||
        client.createdAt !== input.occurredAt
      )
        return fail("API_CLIENT_LIFECYCLE_CONFLICT");
    } else {
      if (
        latest === null ||
        latest.clientReference !== client.clientReference ||
        !sameScope(latest.scope, client.scope) ||
        latest.createdAt !== client.createdAt ||
        latest.createdByReference !== client.createdByReference ||
        latest.nameCode !== client.nameCode ||
        latest.ownerReference !== client.ownerReference ||
        latest.environment !== client.environment
      )
        return fail("API_CLIENT_LIFECYCLE_CONFLICT");
      if (
        input.command === "SubmitApiClientApproval" &&
        (latest.status !== "Requested" ||
          client.status !== "PendingApproval" ||
          !sameExcept(latest, client, ["status"]))
      )
        return fail("API_CLIENT_LIFECYCLE_CONFLICT");
      if (input.command === "ActivateApiClient") {
        if (
          latest.status !== "PendingApproval" ||
          client.status !== "Active" ||
          client.approvalEvidenceReference === null ||
          client.grantSetReference === null ||
          client.credential === null ||
          !sameExcept(latest, client, [
            "status",
            "approvalEvidenceReference",
            "grantSetReference",
            "credential",
          ])
        )
          return fail("API_CLIENT_LIFECYCLE_CONFLICT");
        if (
          !(await ports.approval
            .validate({
              clientReference: client.clientReference,
              approvalEvidenceReference: client.approvalEvidenceReference,
              requestedScopeCodes: client.requestedScopeCodes,
              requestedGrantCodes: client.requestedGrantCodes,
              observedAt: input.occurredAt,
            })
            .catch(dependency))
        )
          return fail("API_CLIENT_APPROVAL_INVALID");
        if (
          !(await ports.grants
            .validate({
              clientReference: client.clientReference,
              grantSetReference: client.grantSetReference,
              scope: client.scope,
              requestedGrantCodes: client.requestedGrantCodes,
              observedAt: input.occurredAt,
            })
            .catch(dependency))
        )
          return fail("API_CLIENT_GRANT_INVALID");
        const issued = await ports.credentials
          .activate({ client, observedAt: input.occurredAt })
          .catch(dependency);
        if (JSON.stringify(issued) !== JSON.stringify(client.credential))
          return fail("API_CLIENT_CREDENTIAL_INVALID");
      }
      if (
        input.command === "SuspendApiClient" &&
        (latest.status !== "Active" ||
          client.status !== "Suspended" ||
          !sameExcept(latest, client, ["status"]))
      )
        return fail("API_CLIENT_LIFECYCLE_CONFLICT");
      if (input.command === "RotateApiClientCredential") {
        if (
          !["Active", "Suspended"].includes(latest.status) ||
          latest.credential === null ||
          client.credential === null ||
          client.credential.credentialVersion !== latest.credential.credentialVersion + 1 ||
          !sameExcept(latest, client, ["credential"])
        )
          return fail("API_CLIENT_LIFECYCLE_CONFLICT");
        const rotated = await ports.credentials
          .rotate({ client, current: latest.credential, observedAt: input.occurredAt })
          .catch(dependency);
        if (JSON.stringify(rotated) !== JSON.stringify(client.credential))
          return fail("API_CLIENT_CREDENTIAL_INVALID");
      }
      if (input.command === "RevokeApiClient") {
        if (
          latest.status === "Revoked" ||
          latest.credential === null ||
          client.status !== "Revoked" ||
          client.credential?.status !== "Revoked" ||
          !sameExcept(latest, client, ["status", "credential"])
        )
          return fail("API_CLIENT_LIFECYCLE_CONFLICT");
        const revoked = await ports.credentials
          .revoke({ client, current: latest.credential, observedAt: input.occurredAt })
          .catch(dependency);
        if (JSON.stringify(revoked) !== JSON.stringify(client.credential))
          return fail("API_CLIENT_CREDENTIAL_INVALID");
      }
    }
    const operation: ApiClientOperation = Object.freeze({
      command: input.command,
      operationReference,
      intentDigest: digest,
      client,
    });
    const committed = await ports.repository
      .commit({ operation, expectedRevision: input.expectedRevision })
      .catch(dependency);
    await ports.audit
      .append({
        command: input.command,
        actorReference,
        clientReference: client.clientReference,
        auditSummaryReference: client.auditSummaryReference,
        purposeCode: input.purposeCode,
        operationReference,
        occurredAt: input.occurredAt,
      })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, client: committed.client });
  }
  const invoke =
    (command: ApiClientCommand) => (input: Omit<Parameters<typeof apply>[0], "command">) =>
      apply({ ...input, command });
  return Object.freeze({
    requestClient: invoke("RequestApiClient"),
    submitApproval: invoke("SubmitApiClientApproval"),
    activateClient: invoke("ActivateApiClient"),
    suspendClient: invoke("SuspendApiClient"),
    rotateCredential: invoke("RotateApiClientCredential"),
    revokeClient: invoke("RevokeApiClient"),
  });
}
