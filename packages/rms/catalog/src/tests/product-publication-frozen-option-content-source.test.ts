import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError } from "../contracts/product.js";
import {
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
} from "../contracts/option-set-editor-content.js";
import { parseProductPublicationCommandV2 } from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import {
  createPostgresFrozenFullOptionSetContentStore,
  createPostgresProductPublicationFrozenFullOptionSetContentStore,
  productPublicationFrozenFullOptionSetContentFields,
} from "../infrastructure/persistence/option-set-full-draft-store.js";
import type { ProductLifecycleTransaction as Tx } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z",
  tenant = id(4),
  actor = id(3),
  plus = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function fixture(n = 1, count = 2) {
  const set = id(n * 100),
    version = id(n * 100 + 1);
  const source = {
    optionSetReference: set,
    brandReference: id(2),
    internalCode: "SET_" + n,
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic rule set" },
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 0,
      maximumSelection: Math.max(2, count * 2) as number | null,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: Math.max(2, count * 2) as number | null,
      createdAt: at,
      updatedAt: at,
      options: Array.from({ length: count }, (_, i) => ({
        optionReference: id(n * 100 + 10 + i),
        optionSetReference: set,
        brandReference: id(2),
        stableCode: "OPTION_" + i,
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic option" },
        localizedDescriptions: {},
        sortOrder: i,
        defaultEligible: true,
        triggeredOptionSetReference: null as string | null,
        conflictOptionReferences: [] as string[],
        createdAt: at,
        createdByActorReference: id(3),
      })),
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: source.draft.options.map((o) => ({
      optionReference: o.optionReference,
      quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
      media: null,
      pricingRule: null,
      consumption: null,
      triggeredOptionSetVersionReference: null as string | null,
    })),
    conditionalRules: [] as {
      ruleReference: string;
      whenAllSelected: string[];
      requiredOptionReferences: string[];
    }[],
    conflictRules: [] as { ruleReference: string; forbiddenTogether: string[] }[],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  };
  return { source, details };
}
type Fixture = ReturnType<typeof fixture>;
function stored(f: Fixture) {
  const full = parseCatalogOptionSetEditorContent(f.source, f.details);
  return createCatalogFullOptionSetPublicationMaterialization(f.source, f.details, {
    tenantReference: tenant,
    brandReference: id(2),
    optionSetReference: f.source.optionSetReference,
    versionReference: f.source.draft.versionReference,
    sourceAggregateVersion: 1,
    publicationOperationReference: id(
      Number.parseInt(f.source.optionSetReference.slice(-12), 16) + 40,
    ),
    publicationIntentDigest: "sha256:" + "a".repeat(64),
    successorDraftVersionReference: id(
      Number.parseInt(f.source.optionSetReference.slice(-12), 16) + 41,
    ),
    sealedAt: plus(1),
    sourceDigest: full.sourceDigest,
    contentDigest: full.contentDigest,
    configurationDigest: full.configurationDigest,
  }).content;
}

type Mode =
  | "Validate"
  | "SubmitReview"
  | "Approve"
  | "Reject"
  | "Publish"
  | "SchedulePublish"
  | "ReschedulePublish"
  | "CancelScheduledPublish"
  | "ActivateScheduled"
  | "Ack";
function command(mode: Mode = "Validate") {
  if (mode === "Ack")
    return parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: tenant,
      brandReference: id(2),
      actorReference: actor,
      actorKind: "User",
      operationReference: id(800),
      productReference: id(801),
      versionReference: id(802),
      expectedProductAggregateVersion: 7,
      reportOperationReference: id(803),
      reportDigest: hash("report"),
      warningBindingDigest: hash("warnings"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONFIRMED_WARNING",
      occurredAt: plus(2),
    });
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: tenant,
    brandReference: id(2),
    actorReference: actor,
    actorKind: mode === "ActivateScheduled" ? "System" : "User",
    operationReference: id(800),
    productReference: id(801),
    versionReference: id(802),
    expectedProductAggregateVersion: 7,
    expectedPublicationVersion: 1,
    action: mode,
    contentDigest: hash("product"),
    configurationDigest: hash("configuration"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: [
      "SchedulePublish",
      "ReschedulePublish",
      "CancelScheduledPublish",
      "ActivateScheduled",
    ].includes(mode)
      ? id(804)
      : null,
    replacementVersionReference: null,
    successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(mode)
      ? id(805)
      : null,
    occurredAt: plus(2),
    reasonCode: "SYNTHETIC",
    replacementIntent: { ...intent, digest: hash(intent) },
    replacementIntentDigest: hash(intent),
  });
}
type Options = Parameters<
  typeof createPostgresProductPublicationFrozenFullOptionSetContentStore
>[0];
function harness(mode: Mode = "Validate") {
  const content = stored(fixture()),
    s = content.supportedContent,
    request = command(mode),
    pin = {
      optionSetReference: s.optionSetReference,
      versionReference: s.versionReference,
      expectedRecordDigest: null,
    };
  const metadata = {
    tenantReference: tenant,
    brandReference: id(2),
    optionSetReference: s.optionSetReference,
    versionReference: s.versionReference,
    publicationOperationReference: s.publicationOperationReference,
    publicationIntentDigest: s.publicationIntentDigest,
    successorDraftVersionReference: s.successorDraftVersionReference,
    sourceAggregateVersion: s.sourceAggregateVersion,
    resultAggregateVersion: s.sourceAggregateVersion + 1,
    sealedAt: s.sealedAt,
    sourceDigest: content.sourceDigest,
    contentDigest: content.contentDigest,
    configurationDigest: content.configurationDigest,
    recordDigest: content.digest,
  };
  let time = plus(2),
    deny = false,
    corrupt = false,
    missing = false,
    reads = 0,
    commits = 0,
    consumer = 0,
    late: undefined | (() => void),
    authorityHook: undefined | (() => Promise<void>);
  const packets: Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[1][] = [],
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const tx: Tx = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      let rows: unknown[] = [];
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      if (sql.includes("FROM rms_catalog.option_set_publication_content p")) {
        reads++;
        expect(values).toEqual([tenant, id(2), pin.optionSetReference, pin.versionReference]);
        rows = missing
          ? []
          : [
              {
                snapshot: content,
                metadata: corrupt ? { ...metadata, recordDigest: hash("corrupt") } : metadata,
                coherent: true,
              },
            ];
      }
      return { rows: rows as readonly Row[], rowCount: rows.length };
    },
  };
  const options: Options = {
    command: request,
    observedAt: plus(2),
    validUntil: plus(7),
    clock: { now: () => time },
    transactions: { run: (work) => work(tx) },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        packets.push(input);
        if (authorityHook) await authorityHook();
        if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { observedAt: input.observedAt, validUntil: plus(20) };
      },
    },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
  };
  const reader = createPostgresProductPublicationFrozenFullOptionSetContentStore(options);
  return {
    reader,
    options,
    tx,
    pin,
    request,
    content,
    packets,
    guards,
    setTime(value: string) {
      time = value;
    },
    setDeny() {
      deny = true;
    },
    setCorrupt() {
      corrupt = true;
    },
    setMissing() {
      missing = true;
    },
    setAuthorityHook(hook: () => Promise<void>) {
      authorityHook = hook;
    },
    later(hook: () => void) {
      late = hook;
    },
    counts() {
      return { reads, commits, consumer };
    },
    async commit(work: () => Promise<unknown> = () => reader.readPinned(pin)) {
      try {
        const value = await work();
        consumer++;
        for (const g of guards) await g.guard();
        late?.();
        for (const g of guards) {
          expect(g.final()).toBeUndefined();
        }
        commits++;
        return value;
      } catch (e) {
        consumer = 0;
        throw e;
      }
    },
  };
}

it.each([
  "Validate",
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "CancelScheduledPublish",
  "ActivateScheduled",
  "Ack",
] as const)(
  "holds actual %s identity/purpose/hash and immutable content through final commit",
  async (mode) => {
    const h = harness(mode),
      result = await h.commit();
    expect(result).toEqual({
      content: h.content,
      observedAt: plus(2),
      validUntil: plus(7),
      eligibility: "NotEvaluated",
    });
    expect(h.counts()).toEqual({ reads: 3, commits: 1, consumer: 1 });
    for (const input of h.packets) {
      expect(input.command).toEqual(h.request);
      expect(input.originalIntentDigest).toBe(hash(h.request));
      expect(input.actorKind).toBe(h.request.actorKind);
      expect(input.purposeCode).toBe(h.request.purposeCode);
      expect(input.requiredFields).toEqual(productPublicationFrozenFullOptionSetContentFields);
      expect(input.requestValidUntil).toBe(plus(7));
      expect(input.replacementIntentDigest).toBe(
        "replacementIntentDigest" in h.request ? h.request.replacementIntentDigest : null,
      );
      expect(input.warningBindingDigest).toBe(
        "warningBindingDigest" in h.request ? h.request.warningBindingDigest : null,
      );
    }
  },
);
it("retains the old User-only read tuple and returned bytes", async () => {
  const h = harness(),
    seen: unknown[] = [];
  const old = createPostgresFrozenFullOptionSetContentStore({
    tenantReference: tenant,
    brandReference: id(2),
    actorReference: actor,
    clock: { now: () => plus(2) },
    transactions: { run: (work) => work(h.tx) },
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        seen.push(input);
        return { observedAt: input.observedAt, validUntil: plus(9) };
      },
    },
  });
  expect(await old.readPinned(h.pin)).toEqual({
    content: h.content,
    observedAt: plus(2),
    validUntil: plus(9),
    eligibility: "NotEvaluated",
  });
  expect(seen).toHaveLength(3);
  for (const p of seen)
    expect(p).toEqual(
      expect.objectContaining({
        actorKind: "User",
        purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT",
      }),
    );
  expect(Object.hasOwn(seen[0] as object, "command")).toBe(false);
  expect(h.guards).toHaveLength(0);
});
it.each(["deny", "digest", "expiry", "query"] as const)(
  "refuses late %s after a successful source read and prevents commit",
  async (mode) => {
    const h = harness();
    await expect(
      h.commit(async () => {
        const result = await h.reader.readPinned(h.pin);
        if (mode === "deny") h.setDeny();
        if (mode === "digest") h.setCorrupt();
        if (mode === "expiry") h.setTime(plus(7));
        if (mode === "query") h.tx.query = async () => ({ rows: [] });
        return result;
      }),
    ).rejects.toMatchObject({
      code: mode === "deny" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(h.counts().commits).toBe(0);
    expect(h.counts().consumer).toBe(0);
  },
);
it("runs final lease assertion after a later async guard consumes the original deadline", async () => {
  const h = harness();
  h.later(() => h.setTime(plus(7)));
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.counts().commits).toBe(0);
});
it("poisons a caught missing record failure before unrelated consumer work", async () => {
  const h = harness();
  h.setMissing();
  await expect(
    h.commit(async () => {
      try {
        await h.reader.readPinned(h.pin);
      } catch {
        return "caught";
      }
      return "unexpected";
    }),
  ).rejects.toThrow();
  expect(h.counts().commits).toBe(0);
});
it("poisons same-factory same-tx caught reentry", async () => {
  const h = harness();
  let calls = 0;
  h.setAuthorityHook(async () => {
    if (calls++ === 0) {
      try {
        await h.reader.readPinned(h.pin);
      } catch {
        return;
      }
    }
  });
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.counts().commits).toBe(0);
});
it("detects a partial clock rollback that remains after the original observation", async () => {
  const h = harness();
  let calls = 0;
  h.setAuthorityHook(async () => {
    h.setTime(plus(++calls === 1 ? 4 : 3));
  });
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures configured methods and detaches the full intent before awaits", async () => {
  const h = harness();
  h.options.clock.now = () => {
    throw Error("replaced");
  };
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw Error("replaced");
  };
  h.options.transactions.run = async () => {
    throw Error("replaced");
  };
  expect(await h.commit()).toEqual(expect.objectContaining({ content: h.content }));
});
it("rejects accessor input without executing it and keeps the registered guard poisoned", async () => {
  const h = harness(),
    getter = vi.fn(),
    pin = { ...h.pin };
  Object.defineProperty(pin, "versionReference", { get: getter, enumerable: true });
  await expect(
    h.commit(async () => {
      try {
        await h.reader.readPinned(pin);
      } catch {
        return undefined;
      }
      return "unexpected";
    }),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each(["V1", "SystemAck", "Supersede", "longLease"] as const)(
  "does not widen the fixed entry for %s",
  (kind) => {
    const h = harness(),
      raw: Record<string, unknown> = { ...h.request };
    if (kind === "V1") delete raw.profile;
    if (kind === "SystemAck") Object.assign(raw, command("Ack"), { actorKind: "System" });
    if (kind === "Supersede")
      Object.assign(raw, {
        action: "Supersede",
        actorKind: "System",
        replacementVersionReference: id(990),
      });
    expect(() =>
      createPostgresProductPublicationFrozenFullOptionSetContentStore({
        ...h.options,
        command: raw,
        ...(kind === "longLease" ? { validUntil: plus(8) } : {}),
      }),
    ).toThrow();
  },
);
