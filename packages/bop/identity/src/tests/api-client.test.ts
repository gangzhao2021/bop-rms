import { describe, expect, it, vi } from "vitest";
import {
  ApiClientContractError,
  ApiClientServiceError,
  createApiClientRecord,
  createApiClientService,
  type ApiClientCredentialMetadata,
  type ApiClientOperation,
  type ApiClientPorts,
  type ApiClientRecord,
} from "../index.js";

const id = (suffix: string) => `018f6f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const AT = "2026-08-15T12:00:00.000Z";
const NEXT = "2026-08-15T12:01:00.000Z";

function shape(overrides: Record<string, unknown> = {}) {
  return {
    clientReference: id("1"),
    revision: 1,
    scope: {
      tenantReference: id("2"),
      brandReference: id("3"),
      storeReference: null,
    },
    nameCode: "ORDER_EXPORTER",
    ownerReference: id("4"),
    environment: "Sandbox",
    status: "Requested",
    requestedScopeCodes: ["ORDERS.READ"],
    requestedGrantCodes: ["ORDER.EXPORT.READ"],
    grantSetReference: null,
    approvalEvidenceReference: null,
    credential: null,
    lastUsedAt: null,
    auditSummaryReference: id("5"),
    createdByReference: id("6"),
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function harness(options: { authorize?: boolean; approval?: boolean; grants?: boolean } = {}) {
  const operations = new Map<string, ApiClientOperation>();
  let latest: ApiClientRecord | null = null;
  const ports: ApiClientPorts = {
    authorization: { authorize: vi.fn(async () => options.authorize ?? true) },
    references: {
      hashIntent: (value) => `digest:${value}`,
      equals: (left, right) => left === right,
    },
    approval: { validate: vi.fn(async () => options.approval ?? true) },
    grants: { validate: vi.fn(async () => options.grants ?? true) },
    credentials: {
      activate: vi.fn(async ({ client }) => client.credential as ApiClientCredentialMetadata),
      rotate: vi.fn(async ({ client }) => client.credential as ApiClientCredentialMetadata),
      revoke: vi.fn(async ({ client }) => client.credential as ApiClientCredentialMetadata),
    },
    audit: { append: vi.fn(async () => undefined) },
    repository: {
      resolveOperation: vi.fn(async (reference) => operations.get(reference) ?? null),
      loadLatest: vi.fn(async () => latest),
      commit: vi.fn(async ({ operation }) => {
        operations.set(operation.operationReference, operation);
        latest = operation.client;
        return operation;
      }),
    },
  };
  return {
    ports,
    service: createApiClientService(ports),
    setLatest(value: ApiClientRecord) {
      latest = value;
    },
  };
}

function command(client: unknown, expectedRevision: number, operation = "10") {
  return {
    operationReference: id(operation),
    actorReference: id("6"),
    expectedRevision,
    client,
    purposeCode: "SECURITY.ADMINISTRATION",
    occurredAt: (client as { updatedAt: string }).updatedAt,
  };
}

describe("API Client contract and lifecycle", () => {
  it("rejects credential values and applies an authorized request idempotently", async () => {
    expect(() => createApiClientRecord({ ...shape(), credentialValue: "forbidden" })).toThrow(
      ApiClientContractError,
    );
    const { ports, service } = harness();
    const client = createApiClientRecord(shape());
    await expect(service.requestClient(command(client, 0))).resolves.toMatchObject({
      status: "Applied",
      client,
    });
    await expect(service.requestClient(command(client, 0))).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    expect(ports.authorization.authorize).toHaveBeenCalledTimes(2);
    expect(ports.repository.commit).toHaveBeenCalledTimes(1);
  });

  it("requires both independent approval and the current grant set before activation", async () => {
    const pending = createApiClientRecord(shape({ revision: 2, status: "PendingApproval" }));
    const credential = {
      credentialReference: id("20"),
      credentialVersion: 1,
      status: "Active",
      issuedAt: NEXT,
      expiresAt: "2026-11-15T12:01:00.000Z",
      revokedAt: null,
    } as const;
    const active = createApiClientRecord(
      shape({
        revision: 3,
        status: "Active",
        grantSetReference: id("21"),
        approvalEvidenceReference: id("22"),
        credential,
        updatedAt: NEXT,
      }),
    );
    const denied = harness({ approval: false });
    denied.setLatest(pending);
    await expect(denied.service.activateClient(command(active, 2))).rejects.toMatchObject({
      code: "API_CLIENT_APPROVAL_INVALID",
    });
    const allowed = harness();
    allowed.setLatest(pending);
    await expect(allowed.service.activateClient(command(active, 2))).resolves.toMatchObject({
      status: "Applied",
    });
    expect(allowed.ports.approval.validate).toHaveBeenCalledOnce();
    expect(allowed.ports.grants.validate).toHaveBeenCalledOnce();
    expect(allowed.ports.credentials.activate).toHaveBeenCalledOnce();
  });

  it("rotates metadata by exactly one version and revokes terminally", async () => {
    const firstCredential = {
      credentialReference: id("20"),
      credentialVersion: 1,
      status: "Active",
      issuedAt: AT,
      expiresAt: "2026-11-15T12:00:00.000Z",
      revokedAt: null,
    } as const;
    const active = createApiClientRecord(
      shape({
        status: "Active",
        grantSetReference: id("21"),
        approvalEvidenceReference: id("22"),
        credential: firstCredential,
      }),
    );
    const rotated = createApiClientRecord({
      ...active,
      revision: 2,
      updatedAt: NEXT,
      credential: {
        ...firstCredential,
        credentialReference: id("23"),
        credentialVersion: 2,
        issuedAt: NEXT,
        expiresAt: "2026-11-15T12:01:00.000Z",
      },
    });
    const context = harness();
    context.setLatest(active);
    await expect(context.service.rotateCredential(command(rotated, 1))).resolves.toMatchObject({
      status: "Applied",
    });

    const revoked = createApiClientRecord({
      ...rotated,
      revision: 3,
      status: "Revoked",
      updatedAt: "2026-08-15T12:02:00.000Z",
      credential: {
        ...rotated.credential,
        status: "Revoked",
        revokedAt: "2026-08-15T12:02:00.000Z",
      },
    });
    await expect(context.service.revokeClient(command(revoked, 2, "11"))).resolves.toMatchObject({
      status: "Applied",
    });
    const after = createApiClientRecord({
      ...revoked,
      revision: 4,
      updatedAt: "2026-08-15T12:03:00.000Z",
    });
    await expect(context.service.revokeClient(command(after, 3, "12"))).rejects.toBeInstanceOf(
      ApiClientServiceError,
    );
  });

  it("reauthorizes replay and denies it when the actor no longer has permission", async () => {
    const context = harness();
    const client = createApiClientRecord(shape());
    const input = command(client, 0);
    await context.service.requestClient(input);
    (context.ports.authorization.authorize as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(context.service.requestClient(input)).rejects.toMatchObject({
      code: "API_CLIENT_PERMISSION_DENIED",
    });
  });
});
