import { createHash } from "node:crypto";
import { createIdentityActor } from "@bop/identity";
import { expect, it, vi } from "vitest";
import { createBrand } from "../domain/brand-store.js";
import { createBrandAdministrationContext } from "../contracts/brand-administration-context.js";
import {
  createPlatformBrandTemplateRevision,
  parsePlatformBrandTemplateReceipt,
  parsePlatformBrandTemplateSave,
  platformBrandTemplateIntentDigest,
  type PlatformBrandTemplateCodec,
} from "../contracts/platform-brand-template.js";
import type { PlatformBrandTemplateTransaction } from "../infrastructure/persistence/platform-brand-template-store.js";
import {
  createPostgresPlatformBrandTemplateReferenceSource,
  type PlatformBrandTemplateReferenceSourceOptions,
} from "../infrastructure/persistence/platform-brand-template-reference-source.js";
const id = (n: number) => `01903000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const codec: PlatformBrandTemplateCodec = {
  canonicalize: canonical,
  hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
};
function material() {
  const original = parsePlatformBrandTemplateSave({
    profile: "PlatformBrandTemplateSaveV1",
    kind: "Platform",
    actorReference: id(8),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(9),
    templateReference: null,
    expectedHead: null,
    content: {
      code: "STANDARD",
      name: "Standard Brand material",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA"],
      overrideAllowedFieldCodes: ["CONTACT"],
      hardRequirementFieldCodes: ["SECURITY.REAUTH"],
      effectiveFrom: at,
      effectiveUntil: null,
      reasonCode: "INITIAL_CONFIGURATION",
    },
  });
  const revision = createPlatformBrandTemplateRevision(
    {
      profile: "PlatformBrandTemplateRevisionV1",
      templateReference: id(10),
      templateVersionReference: id(11),
      revision: 1,
      recordKind: "AuthoredContent",
      content: original.content,
      supersedesVersionReference: null,
      authoredByReference: id(8),
      operationReference: id(9),
      auditReference: id(12),
      createdAt: at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    codec,
  );
  const receipt = parsePlatformBrandTemplateReceipt(
    {
      profile: "PlatformBrandTemplateOperationV1",
      kind: "Platform",
      actorReference: id(8),
      purposeCode: "PLATFORM_BRAND_TEMPLATE",
      operationReference: id(9),
      intentDigest: platformBrandTemplateIntentDigest(original, codec),
      originalCommand: original,
      outcome: "Committed",
      snapshot: revision,
      auditReference: id(12),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    codec,
  );
  return { revision, receipt };
}
/** Controlled SQL/IAM protocol boundaries, actual owning context and immutable
 * hash parsers. Native role/fence/rollback evidence belongs to integration. */
function fixture(lifecycle = "Draft") {
  const { revision, receipt } = material();
  const state = {
    clock: at,
    deadline: until,
    allowed: true,
    lifecycle,
    actor: id(1),
    present: true,
    isolation: "read committed",
    onHold: undefined as undefined | (() => Promise<void>),
    onRead: undefined as undefined | (() => void),
    mutate: undefined as undefined | ((row: Record<string, unknown>) => unknown),
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const revisionRow = () => ({
    template_id: revision.templateReference,
    version_id: revision.templateVersionReference,
    revision: String(revision.revision),
    code: revision.content.code,
    actor_id: revision.authoredByReference,
    operation_id: revision.operationReference,
    audit_id: revision.auditReference,
    content_digest: revision.contentDigest,
    source_digest: revision.sourceDigest,
    snapshot_json: revision,
    precise: true,
  });
  const operationRow = () => ({
    actor_id: receipt.actorReference,
    purpose_code: receipt.purposeCode,
    operation_id: receipt.operationReference,
    intent_digest: receipt.intentDigest,
    receipt_json: receipt,
    receipt_digest: codec.hashIntent(codec.canonicalize(receipt)),
    precise: true,
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: state.isolation }] };
    if (sql.includes("platform_brand_template_reference_read")) {
      state.onRead?.();
      const row = { revision_row: revisionRow(), operation_row: operationRow() };
      return {
        rows:
          state.present && values[2] === revision.templateVersionReference
            ? [state.mutate ? state.mutate(row) : row]
            : [],
      };
    }
    return { rows: [] };
  });
  const tx = { query };
  const authority = {
    holdUntilTransactionCompletes: vi.fn(
      async (
        actual: PlatformBrandTemplateTransaction,
        input: Parameters<
          PlatformBrandTemplateReferenceSourceOptions["authority"]["holdUntilTransactionCompletes"]
        >[1],
      ) => {
        expect(actual).toBe(tx);
        expect(input.permission).toBe("organization.manage");
        expect(input.purposeCode).toBe("BRAND_ADMINISTRATION");
        await state.onHold?.();
        if (!state.allowed) throw new Error("Controlled IAM refusal");
        const actor = createIdentityActor({
          actorType: "User",
          actorReference: state.actor,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt: at,
          recentMfaAt: at,
        });
        const brand = createBrand({
          brandReference: id(2),
          code: "SYNTHETIC",
          displayName: "Synthetic Brand",
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          lifecycle: state.lifecycle,
          version: 1,
          createdAt: at,
          updatedAt: at,
        });
        return {
          administrationContext: createBrandAdministrationContext(actor, brand, state.clock),
          validUntil: state.deadline,
        };
      },
    ),
  } satisfies PlatformBrandTemplateReferenceSourceOptions["authority"];
  const register = vi.fn(
    async (
      actual: PlatformBrandTemplateTransaction,
      current: () => Promise<void>,
      seal: () => void,
    ) => {
      expect(actual).toBe(tx);
      guard = current;
      final = seal;
    },
  ) satisfies PlatformBrandTemplateReferenceSourceOptions["registerBeforeCommit"];
  const options: PlatformBrandTemplateReferenceSourceOptions = {
    transaction: tx,
    scope: { tenantReference: id(2), brandReference: id(2), actorReference: id(1) },
    clock: { now: () => state.clock },
    originalObservedAt: at,
    originalValidUntil: until,
    references: codec,
    authority,
    registerBeforeCommit: register,
  };
  const source = createPostgresPlatformBrandTemplateReferenceSource(options);
  return {
    source,
    state,
    options,
    tx,
    query,
    register,
    authority,
    revision,
    receipt,
    revisionRow,
    operationRow,
    guard: async () => {
      if (!guard) throw new Error("missing guard");
      await guard();
    },
    final: () => {
      if (!final) throw new Error("missing final");
      final();
    },
  };
}
it.each(["Draft", "Active", "Suspended", "Archived"])(
  "reads genuine authored immutable material under %s administrative authority",
  async (lifecycle) => {
    const f = fixture(lifecycle);
    expect(await f.source.exact({ templateVersionReference: id(11) })).toEqual(f.revision);
    await f.guard();
    f.final();
    f.source.assertFinalized();
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("bop.platform_actor_id"))).toBe(false);
    expect(
      f.query.mock.calls.some(
        ([sql, values]) =>
          sql.includes("bop.tenant_id") && values[0] === id(2) && values[1] === id(1),
      ),
    ).toBe(true);
    expect(f.revision.authoredByReference).not.toBe(f.options.scope.actorReference);
    expect(f.revision).not.toHaveProperty("publicationReference");
  },
);
it("protects absence and catches a late material appearance", async () => {
  const f = fixture();
  f.state.present = false;
  expect(await f.source.exact({ templateVersionReference: id(11) })).toBeNull();
  f.state.present = true;
  await expect(f.guard()).rejects.toThrow();
  expect(f.final).toThrow();
});
it.each(["content", "source", "receipt", "actor", "operation", "precision", "missingOriginal"])(
  "rejects coherent-looking persisted %s corruption",
  async (mode) => {
    const f = fixture();
    f.state.mutate = () => {
      const r = f.revisionRow(),
        o = f.operationRow();
      if (mode === "content")
        r.snapshot_json = { ...f.revision, content: { ...f.revision.content, name: "Changed" } };
      if (mode === "source") r.source_digest = "sha256:" + "a".repeat(64);
      if (mode === "receipt") o.receipt_digest = "sha256:" + "a".repeat(64);
      if (mode === "actor") r.actor_id = id(30);
      if (mode === "operation") o.operation_id = id(30);
      if (mode === "precision") r.precise = false;
      return { revision_row: r, operation_row: mode === "missingOriginal" ? null : o };
    };
    await expect(f.source.exact({ templateVersionReference: id(11) })).rejects.toThrow();
    await expect(f.guard()).rejects.toThrow();
  },
);
it.each(["allowed", "actor", "lifecycle", "expiry", "clock", "query"])(
  "rejects late %s drift before COMMIT",
  async (mode) => {
    const f = fixture();
    await f.source.exact({ templateVersionReference: id(11) });
    if (mode === "allowed") f.state.allowed = false;
    if (mode === "actor") f.state.actor = id(30);
    if (mode === "lifecycle") f.state.lifecycle = "Active";
    if (mode === "expiry") f.state.deadline = at;
    if (mode === "clock") f.state.clock = "2026-10-06T09:59:59.999Z";
    if (mode === "query") f.options.transaction.query = async () => ({ rows: [] });
    await expect(f.guard()).rejects.toThrow();
    expect(f.final).toThrow();
  },
);
it("retains original shortest lease through the last synchronous seal", async () => {
  const f = fixture();
  f.state.deadline = "2026-10-06T10:00:00.100Z";
  await f.source.exact({ templateVersionReference: id(11) });
  await f.guard();
  f.state.deadline = until;
  f.state.clock = "2026-10-06T10:00:00.100Z";
  expect(f.final).toThrow();
  f.state.clock = at;
  expect(f.final).toThrow();
});
it("registers before a caught first rejection and poisons reentry", async () => {
  const f = fixture();
  f.state.onHold = async () => {
    await f.source.exact({ templateVersionReference: id(11) }).catch(() => undefined);
  };
  await expect(f.source.exact({ templateVersionReference: id(11) })).rejects.toThrow();
  expect(f.register).toHaveBeenCalledTimes(1);
  await expect(f.guard()).rejects.toThrow();
});
it("rejects closed input, bad isolation and accessor rows without executing their getters", async () => {
  const f = fixture();
  await expect(
    f.source.exact(Object.assign({ templateVersionReference: id(11) }, { permission: "Allow" })),
  ).rejects.toThrow();
  await expect(f.guard()).rejects.toThrow();
  const isolation = fixture();
  isolation.state.isolation = "repeatable read";
  await expect(isolation.source.exact({ templateVersionReference: id(11) })).rejects.toThrow();
  const getter = vi.fn(() => ({})),
    g = fixture();
  g.state.mutate = () =>
    Object.defineProperty({}, "revision_row", { enumerable: true, get: getter });
  await expect(g.source.exact({ templateVersionReference: id(11) })).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("does not consult a later clock after successful COMMIT state confirmation", async () => {
  const f = fixture();
  await f.source.exact({ templateVersionReference: id(11) });
  await f.guard();
  f.final();
  f.state.clock = until;
  expect(() => f.source.assertFinalized()).not.toThrow();
  await expect(f.source.exact({ templateVersionReference: id(11) })).rejects.toThrow();
  expect(() => f.source.assertFinalized()).toThrow();
});

it("protects genuine unchanged absence and refuses an extended initial lease", async () => {
  const f = fixture();
  f.state.present = false;
  expect(await f.source.exact({ templateVersionReference: id(11) })).toBeNull();
  await f.guard();
  f.final();
  f.source.assertFinalized();
  expect(() =>
    createPostgresPlatformBrandTemplateReferenceSource({
      ...f.options,
      originalValidUntil: "2026-10-06T10:00:05.001Z",
    }),
  ).toThrow();
  expect(() =>
    createPostgresPlatformBrandTemplateReferenceSource({
      ...f.options,
      scope: { ...f.options.scope, tenantReference: id(4) },
    }),
  ).toThrow();
});
it("rejects a caught invalid public read after a successful read through owning host guards", async () => {
  const f = fixture();
  await f.source.exact({ templateVersionReference: id(11) });
  await f.source
    .exact(Object.assign({ templateVersionReference: id(11) }, { storeReference: id(4) }))
    .catch(() => undefined);
  await expect(f.guard()).rejects.toThrow();
  expect(f.final).toThrow();
});
