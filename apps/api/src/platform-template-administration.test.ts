import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  BrowserSessionError,
  PlatformBrowserSessionService,
  createPostgresPlatformBrowserSessionStore,
  createIdentityActor,
  parseSelectorHash,
  type SessionEnvelopeCryptoPort,
  type PlatformBrowserSessionServiceOptions,
} from "@bop/identity";
import {
  buildPlatformPermissionPolicy,
  parsePlatformPermissionProvisionCommand,
  platformPermissionIntentDigest,
} from "@bop/permission";
import {
  parsePlatformBrandTemplateReceipt,
  type PlatformBrandTemplateRevision,
  type PlatformBrandTemplateReceipt,
} from "@bop/tenant";
import {
  createPlatformTemplateAdministration,
  parsePlatformTemplateAdministrationCommand,
  parsePlatformTemplateAdministrationQuery,
  type PlatformTemplateAdministrationOptions,
} from "./platform-template-administration.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T13:00:00.000Z";
const cookie = Buffer.alloc(32, 41).toString("base64url"),
  csrf = Buffer.alloc(32, 42).toString("base64url");
const content = {
  code: "BRAND_STANDARD",
  name: "Brand standard",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  overrideAllowedFieldCodes: ["CONTACT"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
};
const save = {
  action: "Save",
  operationReference: id(20),
  templateReference: null,
  expectedHead: null,
  content,
};
/** Controlled SQL/remote directory/crypto transport; actual Session, Permission,
 * Tenant, Publishing and Audit parsers and sources are composed here. Native SQL
 * owner integration is covered separately by native SQL acceptance. Real Cognito
 * acceptance remains unverified; signed-token component tests use synthetic evidence. */
async function fixture() {
  const state = {
    time: at,
    deny: false,
    deniedActions: [] as string[],
    actorActive: true,
    beforeGuards: null as null | (() => void),
    beforeFinal: null as null | (() => void),
    postCommit: false,
    skipFinal: false,
    doubleWork: false,
  };
  const configuration = {
    environment: "synthetic",
    issuer: "https://identity.invalid/",
    clientId: "synthetic-platform",
    redirectUri: "https://platform.invalid/platform/auth/callback",
    allowedPostLoginPaths: ["/platform/tenants"],
  };
  const hasher = {
    hash: (v: string) =>
      parseSelectorHash(createHmac("sha256", Buffer.alloc(32, 51)).update(v).digest("hex")),
    equals: (a: string, b: string) => a === b,
  };
  const key = Buffer.alloc(32, 52);
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(plaintext, context) {
      const iv = Buffer.alloc(12, 53),
        c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(context));
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "synthetic-key",
        encryptionContext: context,
        ciphertext: Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]).toString(
          "base64url",
        ),
      };
    },
    async decrypt(e, context) {
      const b = Buffer.from(e.ciphertext, "base64url"),
        d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
    },
  };
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Platform",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const secrets = {
    profile: "PlatformBrowserSessionV1",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    tokenBundle: "synthetic-private-provider-token",
    csrf,
    mfa: {
      sessionReference: id(2),
      actorReference: id(1),
      method: "Totp",
      evidenceReference: id(3),
      authorizationTransactionReference: id(4),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-10-06T12:15:00.000Z",
    },
  };
  const envelope = await envelopes.encrypt(
    JSON.stringify(secrets),
    "synthetic:platform-session:" + id(2) + ":" + id(1),
  );
  const sessionRow = {
    session_id: id(2),
    actor_id: id(1),
    session_selector_hash: Buffer.from(hasher.hash(cookie), "hex"),
    csrf_selector_hash: Buffer.from(hasher.hash(csrf), "hex"),
    policy_code: "Privileged",
    status: "Active",
    encrypted_secret: Buffer.from(envelope.ciphertext, "base64url"),
    cipher_algorithm: envelope.algorithm,
    key_reference: envelope.keyReference,
    encryption_context: envelope.encryptionContext,
    authenticated_at: new Date(at),
    created_at: new Date(at),
    last_seen_at: new Date(at),
    idle_expires_at: new Date("2026-10-06T12:15:00.000Z"),
    absolute_expires_at: new Date("2026-10-06T20:00:00.000Z"),
    rotated_from_session_id: null,
    version: 1,
    revocation_reason: null,
    revoked_at: null,
  };
  const provision = parsePlatformPermissionProvisionCommand({
    profile: "PlatformPermissionProvisionV1",
    targetActorReference: id(1),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(5),
    expectedHead: null,
    content: {
      roleCode: "PlatformAdministrator",
      effectiveFrom: at,
      effectiveUntil: until,
      entries: [
        "platform.operate",
        "platform.brand-template.read",
        "platform.brand-template.manage",
        "platform.brand-template.submit",
        "platform.brand-template.approve",
        "platform.brand-template.publish",
        "platform.brand-template.archive",
      ].map((action, i) => ({
        evidenceReference: id(40 + i),
        action,
        effect: "Allow",
        effectiveFrom: at,
        effectiveUntil: until,
      })),
    },
    recordedByReference: id(6),
    approvedByReference: id(7),
    approvalEvidenceReference: id(8),
    reasonCode: "APPROVED_PROVISIONING",
  });
  const policy = buildPlatformPermissionPolicy({
    profile: "PlatformPermissionPolicyV1",
    actorReference: id(1),
    purposeCode: provision.purposeCode,
    policyReference: id(9),
    revision: 1,
    supersedesPolicyReference: null,
    content: provision.content,
    operationReference: provision.operationReference,
    intentDigest: platformPermissionIntentDigest(provision),
    originalCommand: provision,
    recordedByReference: provision.recordedByReference,
    approvedByReference: provision.approvedByReference,
    approvalEvidenceReference: provision.approvalEvidenceReference,
    reasonCode: provision.reasonCode,
    auditReference: id(10),
    recordedAt: at,
    classification: "RestrictedSecurity",
  });
  const { sourceDigest: priorDigest, ...policyBody } = policy;
  void priorDigest;
  let revisions: PlatformBrandTemplateRevision[] = [],
    operations = new Map<string, PlatformBrandTemplateReceipt>(),
    publications = new Map<string, { receipt_text: string; receipt_digest: string }>(),
    auditCount = 0,
    previousHash: string | null = null;
  const row = (r: PlatformBrandTemplateRevision) => ({
    template_id: r.templateReference,
    version_id: r.templateVersionReference,
    revision: String(r.revision),
    code: r.content.code,
    actor_id: r.authoredByReference,
    operation_id: r.operationReference,
    audit_id: r.auditReference,
    content_digest: r.contentDigest,
    source_digest: r.sourceDigest,
    snapshot_json: r,
    precise: true,
  });
  const digest = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (sql.startsWith("SELECT * FROM bop_identity.authentication_session"))
      return { rows: values[0] === hasher.hash(cookie) ? [sessionRow] : [] };
    if (sql.startsWith("SELECT current_setting('transaction_isolation')"))
      return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("JOIN bop_permission.platform_permission_policy_revision")) {
      const command = parsePlatformPermissionProvisionCommand({
        ...provision,
        content: {
          ...provision.content,
          entries: provision.content.entries.map((e) => ({
            ...e,
            effect: state.deniedActions.includes(e.action) ? "Deny" : "Allow",
          })),
        },
      });
      const current = buildPlatformPermissionPolicy({
        ...policyBody,
        content: command.content,
        originalCommand: command,
        intentDigest: platformPermissionIntentDigest(command),
      });
      return {
        rows: state.deny
          ? []
          : [
              {
                snapshot_text: canonicalizeRfc8785(current),
                source_digest: current.sourceDigest,
                coherent: true,
              },
            ],
      };
    }
    if (sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_revision")) {
      revisions.push(JSON.parse(String(values[9])));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_operation")) {
      const receipt = JSON.parse(String(values[10])) as PlatformBrandTemplateReceipt;
      operations.set(String(values[0]) + ":" + values[2], receipt);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT actor_id,purpose_code")) {
      const r = operations.get(String(values[0]) + ":" + values[2]);
      return {
        rows: r
          ? [
              {
                actor_id: r.actorReference,
                purpose_code: r.purposeCode,
                operation_id: r.operationReference,
                intent_digest: r.intentDigest,
                receipt_json: r,
                receipt_digest: digest(r),
                precise: true,
              },
            ]
          : [],
      };
    }
    if (sql.includes("SELECT DISTINCT ON(template_id)")) return { rows: revisions.map(row) };
    if (sql.startsWith("SELECT template_id,version_id"))
      return {
        rows: revisions
          .filter((r) =>
            sql.includes("WHERE version_id")
              ? r.templateVersionReference === values[0]
              : r.templateReference === values[0],
          )
          .sort((a, b) => b.revision - a.revision)
          .slice(0, sql.includes("LIMIT 3") ? 3 : 1)
          .map(row),
      };
    if (sql.startsWith("INSERT INTO bop_publishing.platform_template_publishing_operation")) {
      publications.set(String(values[1]) + ":" + values[2], {
        receipt_text: String(values[15]),
        receipt_digest: String(values[14]),
      });
      return { rows: [{ record_reference: values[0] }] };
    }
    if (
      sql.startsWith(
        "SELECT receipt_text,receipt_digest FROM bop_publishing.platform_template_publishing_operation",
      )
    ) {
      const r = publications.get(String(values[0]) + ":" + values[1]);
      return { rows: r ? [r] : [] };
    }
    if (sql.startsWith("SELECT next_sequence::text"))
      return {
        rows: [
          {
            next_sequence: String(auditCount + 1),
            previous_hash: previousHash,
            recorded_at: state.time,
          },
        ],
      };
    if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record")) {
      auditCount++;
      previousHash = Buffer.from(values[15] as Uint8Array).toString("hex");
      return { rows: [{ audit_reference: values[0] }] };
    }
    if (sql.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head"))
      return { rows: [{ next_sequence: String(auditCount + 1) }] };
    return { rows: [] };
  });
  const tx = { query };
  let guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const transactions = {
    async run<T>(work: (actual: typeof tx) => Promise<T>): Promise<T> {
      const previous = {
        revisions: [...revisions],
        operations: new Map(operations),
        publications: new Map(publications),
        auditCount,
        previousHash,
      };
      guards = [];
      try {
        const result = await work(tx);
        if (state.doubleWork) await work(tx);
        state.beforeGuards?.();
        for (const g of guards) await g.guard();
        state.beforeFinal?.();
        if (!state.skipFinal) for (const g of guards) g.final();
        if (state.postCommit && guards.length) state.time = "2026-10-06T12:00:06.000Z";
        return result;
      } catch (error) {
        revisions = previous.revisions;
        operations = previous.operations;
        publications = previous.publications;
        auditCount = previous.auditCount;
        previousHash = previous.previousHash;
        throw error;
      }
    },
  };
  const currentActor = vi.fn(async (actual: typeof tx) => {
    expect(actual).toBe(tx);
    if (!state.actorActive) throw Error("synthetic directory withdrawn");
    return actor;
  });
  const persistence = {
    ...configuration,
    transactions,
    currentActor,
    now: () => state.time,
    hasher,
    envelopes,
  };
  const store = createPostgresPlatformBrowserSessionStore(persistence);
  const unused = () => {
    throw Error("unused authentication port");
  };
  const provider: PlatformBrowserSessionServiceOptions["provider"] = {
    createAuthorizationUrl: async () => unused(),
    exchangeCode: async () => unused(),
    revokeRefreshTokens: async () => unused(),
    createLogoutUrl: unused,
  };
  const service = new PlatformBrowserSessionService({
    configuration,
    store,
    hasher,
    envelopes,
    now: persistence.now,
    provider,
    credentials: { generate: unused, generateUuidV7: unused },
    pkce: { challenge: unused },
  });
  let allocated = 100;
  const allocate = vi.fn(() => id(allocated++));
  const options: PlatformTemplateAdministrationOptions = {
    authentication: service,
    persistence,
    nextReference: allocate,
    registerBeforeCommit: async (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
  };
  return {
    state,
    options,
    allocate,
    api: createPlatformTemplateAdministration(options),
    query,
    service,
    currentActor,
    sessionRow,
    auditCount: () => auditCount,
    revisions: () => revisions,
    input: (request: unknown) => ({ sessionCookie: cookie, csrf, request }),
  };
}
it("saves through actual owners, reads list/current/exact/history, and recovers original without new references or Audit", async () => {
  const f = await fixture();
  const result = await f.api.command(f.input(save));
  expect(result).toMatchObject({ outcome: "Committed" });
  const receipt = parsePlatformBrandTemplateReceipt(result, {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (text) => "sha256:" + sha256Hex(text),
  });
  if (receipt.outcome !== "Committed" || receipt.snapshot === null)
    throw Error("expected committed snapshot");
  const before = f.allocate.mock.calls.length;
  expect(await f.api.command(f.input(save))).toEqual(receipt);
  expect(f.auditCount()).toBe(1);
  expect(
    await f.api.command(
      f.input({
        action: "ResolveSave",
        operationReference: receipt.operationReference,
        intentDigest: receipt.intentDigest,
      }),
    ),
  ).toEqual(receipt);
  expect(f.allocate.mock.calls.length).toBe(before);
  expect(await f.api.query(f.input({ action: "List", after: null, limit: 20 }))).toMatchObject({
    items: [{ templateReference: receipt.snapshot.templateReference, name: content.name }],
    publication: "NotEvaluated",
  });
  expect(
    await f.api.query(
      f.input({ action: "Current", templateReference: receipt.snapshot.templateReference }),
    ),
  ).toMatchObject({ current: receipt.snapshot });
  expect(
    await f.api.query(
      f.input({
        action: "Exact",
        templateVersionReference: receipt.snapshot.templateVersionReference,
      }),
    ),
  ).toMatchObject({ snapshot: receipt.snapshot });
  expect(
    await f.api.query(
      f.input({
        action: "History",
        templateReference: receipt.snapshot.templateReference,
        beforeRevision: null,
      }),
    ),
  ).toMatchObject({ entries: [receipt.snapshot] });
  expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-token");
});
it("uses actual public Audit for absent original and fences late Save", async () => {
  const f = await fixture();
  const request = {
    action: "ResolveSave",
    operationReference: id(20),
    intentDigest: "sha256:" + "a".repeat(64),
  };
  const r = await f.api.command(f.input(request));
  expect(r).toMatchObject({ outcome: "Abandoned", originalCommand: null, snapshot: null });
  expect(f.auditCount()).toBe(1);
  expect(await f.api.command(f.input(request))).toEqual(r);
  await expect(f.api.command(f.input(save))).rejects.toBeDefined();
  expect(f.revisions()).toHaveLength(0);
});
it("rejects actual CSRF denial before business transactions and allocations", async () => {
  const f = await fixture();
  await expect(f.api.command({ ...f.input(save), csrf: cookie })).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => sql.includes("bop_permission"))).toBe(false);
});
it.each(["permission", "actor", "expiry"] as const)(
  "rolls back real Save when %s withdraws before commit",
  async (mode) => {
    const f = await fixture();
    f.state.beforeGuards = () => {
      if (mode === "permission") f.state.deny = true;
      else if (mode === "actor") f.state.actorActive = false;
      else f.state.time = "2026-10-06T12:00:05.000Z";
    };
    await expect(f.api.command(f.input(save))).rejects.toBeDefined();
    expect(f.revisions()).toHaveLength(0);
    expect(f.auditCount()).toBe(0);
  },
);
it("enforces final original deadline but performs only pure assertions after committed expiry", async () => {
  const f = await fixture();
  f.state.beforeFinal = () => {
    f.state.time = "2026-10-06T12:00:05.000Z";
  };
  await expect(f.api.command(f.input(save))).rejects.toBeDefined();
  expect(f.revisions()).toHaveLength(0);
  const g = await fixture();
  g.state.postCommit = true;
  expect(await g.api.command(g.input(save))).toMatchObject({ outcome: "Committed" });
  expect(g.state.time).toBe("2026-10-06T12:00:06.000Z");
});
it("refuses unsealed host or repeated work and rolls back", async () => {
  for (const mode of ["skipFinal", "doubleWork"] as const) {
    const f = await fixture();
    f.state[mode] = true;
    await expect(f.api.command(f.input(save))).rejects.toBeDefined();
    if (mode === "doubleWork") expect(f.revisions()).toHaveLength(0);
  }
});
it("rejects port replacement before dispatch", async () => {
  const f = await fixture();
  f.options.persistence.transactions.run = async () => {
    throw Error("replacement");
  };
  await expect(
    f.api.query(f.input({ action: "Current", templateReference: id(30) })),
  ).rejects.toMatchObject({ code: "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE" });
  expect(f.query).not.toHaveBeenCalled();
});
it("closes action requests and rejects payload authority/accessors/oversized owner versions", () => {
  expect(
    parsePlatformTemplateAdministrationQuery({ action: "List", after: null, limit: 20 }),
  ).toEqual({ action: "List", after: null, limit: 20 });
  expect(() =>
    parsePlatformTemplateAdministrationQuery({
      action: "History",
      templateReference: id(1),
      beforeRevision: 2147483648,
    }),
  ).toThrow();
  expect(() =>
    parsePlatformTemplateAdministrationCommand({ ...save, actorReference: id(9) }),
  ).toThrow();
  expect(() =>
    parsePlatformTemplateAdministrationCommand({
      ...save,
      templateReference: id(1),
      expectedHead: {
        revision: 2147483647,
        templateVersionReference: id(2),
        sourceDigest: "sha256:" + "a".repeat(64),
      },
    }),
  ).toThrow();
  const r = { ...save };
  Object.defineProperty(r, "content", {
    enumerable: true,
    get: () => {
      throw Error("must not invoke");
    },
  });
  expect(() => parsePlatformTemplateAdministrationCommand(r)).toThrow();
});

it("resolves absent Publishing original with its actual owner and public Audit, then replays without references or content reads", async () => {
  const f = await fixture();
  const input = f.input({
    action: "ResolvePublication",
    operationReference: id(70),
    intentDigest: "sha256:" + "b".repeat(64),
  });
  const result = await f.api.command(input);
  expect(result).toMatchObject({
    profile: "PlatformPublishingReceiptV1",
    outcome: "Abandoned",
    source: null,
    originalCommand: null,
  });
  const allocated = f.allocate.mock.calls.length;
  expect(await f.api.command(input)).toEqual(result);
  expect(f.allocate.mock.calls.length).toBe(allocated);
  expect(f.auditCount()).toBe(1);
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("SELECT template_id,version_id"))).toBe(
    false,
  );
});
it("reports actual Permission denial as denial and refuses changed Session identity during guards", async () => {
  const f = await fixture();
  f.state.deny = true;
  await expect(
    f.api.query(f.input({ action: "List", after: null, limit: 20 })),
  ).rejects.toMatchObject({ code: "PLATFORM_TEMPLATE_PERMISSION_DENIED" });
  expect(f.allocate).not.toHaveBeenCalled();
  const g = await fixture();
  g.state.beforeGuards = () => {
    g.sessionRow.version = 2;
  };
  await expect(g.api.command(g.input(save))).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  expect(g.revisions()).toHaveLength(0);
});
it("reads genuine absent publication packets and refuses fabricated content pins before allocation", async () => {
  const f = await fixture();
  expect(
    await f.api.query(
      f.input({
        action: "PublicationCurrent",
        templateReference: id(80),
        lifecycleReference: null,
      }),
    ),
  ).toMatchObject({ profile: "PlatformPublishingCurrentV1", current: null, currentRelease: null });
  expect(
    await f.api.query(
      f.input({ action: "PublicationExact", templateReference: id(80), sequence: 1 }),
    ),
  ).toMatchObject({ profile: "PlatformPublishingExactV1", source: null });
  expect(
    await f.api.query(
      f.input({ action: "PublicationHistory", templateReference: id(80), beforeSequence: null }),
    ),
  ).toMatchObject({ profile: "PlatformPublishingHistoryV1", items: [] });
  await expect(
    f.api.command(
      f.input({
        action: "Publication",
        request: {
          profile: "PlatformPublishingRequestV1",
          operation: "CreateDraft",
          operationReference: id(81),
          templateReference: id(80),
          templateVersionReference: id(82),
          contentDigest: "sha256:" + "a".repeat(64),
          templateSourceDigest: "sha256:" + "b".repeat(64),
          expectedLifecycle: null,
          reviewValidUntil: null,
          reasonCode: "ADMIN_CONFIGURATION",
        },
      }),
    ),
  ).rejects.toBeDefined();
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.auditCount()).toBe(0);
});

it("returns only independently authorized actions and mandatory read lease without policy evidence", async () => {
  const f = await fixture();
  f.state.deniedActions = ["platform.brand-template.approve", "platform.brand-template.publish"];
  const result = await f.api.query(f.input({ action: "Actions" }));
  expect(result).toEqual({
    profile: "PlatformTemplateActionsV1",
    scope: { kind: "Platform", actorReference: id(1), purposeCode: "PLATFORM_BRAND_TEMPLATE" },
    allowedActions: [
      "platform.brand-template.manage",
      "platform.brand-template.submit",
      "platform.brand-template.archive",
    ],
    observedAt: at,
    validUntil: "2026-10-06T12:00:05.000Z",
  });
  expect(JSON.stringify(result)).not.toContain("policyReference");
  expect(JSON.stringify(result)).not.toContain("evidenceReference");
  const denied = await fixture();
  denied.state.deniedActions = ["platform.brand-template.read"];
  await expect(denied.api.query(denied.input({ action: "Actions" }))).rejects.toMatchObject({
    code: "PLATFORM_PERMISSION_DENIED",
  });
});
it("rejects action discovery when a successfully held current policy withdraws before commit", async () => {
  const f = await fixture();
  f.state.beforeGuards = () => {
    f.state.deny = true;
  };
  await expect(f.api.query(f.input({ action: "Actions" }))).rejects.toBeDefined();
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.auditCount()).toBe(0);
});

it("cannot omit an optional action denial after that source began guard registration", async () => {
  const f = await fixture();
  const register = f.options.registerBeforeCommit;
  let calls = 0;
  const api = createPlatformTemplateAdministration({
    ...f.options,
    registerBeforeCommit: async (tx, guard, final) => {
      await register(tx, guard, final);
      if (++calls === 3) throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    },
  });
  await expect(api.query(f.input({ action: "Actions" }))).rejects.toMatchObject({
    code: "PLATFORM_PERMISSION_DENIED",
  });
  expect(f.allocate).not.toHaveBeenCalled();
});
