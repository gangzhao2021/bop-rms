import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor } from "@bop/identity";
import { parseBrandCatalogSourceExact, parseCatalogReference } from "@rms/catalog";
import {
  createBrand,
  createBrandConfigurationRevision,
  createBrandConfigurationVersion,
  createTenantContext,
  createBrandAdministrationContext,
  parseBrandConfigurationCommand,
  type BrandConfigurationCommand,
  type BrandConfigurationFreshPreparation,
  type BrandConfigurationRevision,
} from "@bop/tenant";
import {
  evaluatePermission,
  evaluateBrandAdministrationPermission,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseRoleReference,
  parseEvidenceInstant,
} from "@bop/permission";
import {
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  createMerchantBrandConfigurationPreparation,
  createMerchantBrandAdministrationConfigurationPreparation,
  type MerchantBrandAdministrationConfigurationPreparationOptions,
  type BrandConfigurationReferenceMaterials,
  type MerchantBrandConfigurationPreparationOptions,
} from "./merchant-brand-configuration-preparation.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  after = (milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString(),
  hash = "sha256:" + "a".repeat(64),
  digestReferences = {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (value: string) => "sha256:" + sha256Hex(value),
  };
const fields = () => ({
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(4),
  platformTemplateReference: id(5),
  overrideAllowedFieldCodes: ["DISPLAY_NAME"],
  hardRequirementFieldCodes: ["CURRENCY"],
  effectiveFrom: at,
  effectiveUntil: after(120000),
  reasonCode: "CONFIGURATION_CHANGE",
});
// Actual public Publishing service/store/Audit SQL over controlled transport.
// Reference materials and authority are explicitly synthetic server holders;
// this does not establish real PostgreSQL, Session/IAM, or source publication.
function fixture(administrative = false) {
  const tenantReference = administrative ? id(2) : id(1);
  const records: CommitPublishingMutationInput[] = [],
    calls: string[] = [],
    controls = {
      now: at,
      denied: false,
      referenceDenied: false,
      next: 100,
      brandLifecycle: "Active" as "Active" | "Draft",
      wrongContextProfile: false,
    },
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  let sequence = 1;
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push(sql);
    if (sql.includes("current_setting('transaction_isolation')"))
      return { rows: [{ isolation: "read committed" }] };
    if (sql.startsWith("SELECT mutation_json,intent_hash,audit_id"))
      return {
        rows: records
          .filter((r) => r.idempotencyKey === values[3])
          .map((r) => ({
            mutation_json: r,
            intent_hash: publishingRecordedMutationDigest(r),
            audit_id: r.audit.auditId,
          })),
      };
    if (sql.startsWith("SELECT mutation_json,intent_hash")) {
      const selected = records.filter((r) => r.next.lifecycleId === values[3]);
      const version = sql.includes("lifecycle_version=$5") ? values[4] : undefined;
      const found =
        version === undefined
          ? selected.slice(-1)
          : selected.filter((r) => r.next.version === version);
      return {
        rows: found.map((r) => ({
          mutation_json: r,
          intent_hash: publishingRecordedMutationDigest(r),
        })),
      };
    }
    if (sql.startsWith("SELECT mutation_json FROM"))
      return {
        rows: records
          .filter((r) => r.next.lifecycleId === values[3])
          .slice()
          .reverse()
          .map((r) => ({ mutation_json: r })),
      };
    if (sql.startsWith("SELECT release_id"))
      return {
        rows: records
          .filter((r) => r.release !== null)
          .slice(-1)
          .map((r) => ({ release_id: r.release?.releaseId })),
      };
    if (sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")) {
      records.push(parseRecordedPublishingMutation(values[14]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(sequence),
            previous_hash: sequence === 1 ? null : "b".repeat(64),
            recorded_at: controls.now,
          },
        ],
      };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: String(++sequence) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const tx = { query };
  const leaseUntil = () => new Date(Date.parse(controls.now) + 5000).toISOString();
  const material = (): BrandConfigurationReferenceMaterials => ({
    catalog: parseBrandCatalogSourceExact(
      {
        profile: "BrandCatalogSourceExactV1",
        tenantReference,
        brandReference: id(2),
        actorReference: id(3),
        requestedSourceReference: id(4),
        source: {
          profile: "BrandCatalogSourceRegisteredIdentityV1",
          tenantReference,
          brandReference: id(2),
          sourceReference: id(4),
          code: "MAIN",
          label: "Controlled catalogue",
          registeredByReference: id(3),
          operationReference: id(6),
          auditReference: id(7),
          registeredAt: at,
          dataClassification: "ConfigurationMetadata",
        },
        observedAt: controls.now,
        validUntil: leaseUntil(),
        publicationStatus: "NotEvaluated",
        referenceEligibility: "NotEvaluated",
      },
      {
        tenantReference: parseCatalogReference(tenantReference),
        brandReference: parseCatalogReference(id(2)),
        actorReference: parseCatalogReference(id(3)),
      },
      id(4),
      controls.now,
    ),
    template: {
      reference: id(5),
      digest: hash,
      supportedLocales: ["en-CA", "fr-CA"],
      overrideAllowedFieldCodes: ["DISPLAY_NAME"],
      hardRequirementFieldCodes: ["CURRENCY"],
      effectiveFrom: at,
      effectiveUntil: after(120000),
    },
    theme: null,
  });
  function host(
    actorReference = id(3),
    change?: (value: BrandConfigurationReferenceMaterials) => BrandConfigurationReferenceMaterials,
  ) {
    const start = guards.length;
    const actor = createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      }),
      brand = createBrand({
        brandReference: id(2),
        code: "BRAND",
        displayName: "Controlled",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: controls.brandLifecycle,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
    const options: MerchantBrandConfigurationPreparationOptions = {
      tenantReference,
      brandReference: id(2),
      actorReference,
      transaction: tx,
      clock: { now: () => controls.now },
      originalObservedAt: controls.now,
      originalValidUntil: leaseUntil(),
      registerBeforeCommit(actual, guard, final) {
        expect(actual).toBe(tx);
        guards.push({ guard, final });
      },
      nextReference: () => id(++controls.next),
      authority: {
        async withCurrentContext(actual, _input, work) {
          expect(actual).toBe(tx);
          if (controls.denied) throw new Error("controlled current authority refusal");
          guards.push({
            guard: async () => {
              if (controls.denied) throw new Error("controlled late authority refusal");
            },
            final: () => undefined,
          });
          if (controls.wrongContextProfile)
            return Reflect.apply(work, undefined, [
              createBrandAdministrationContext(actor, brand, controls.now),
              tx,
            ]);
          return work(createTenantContext(actor, brand, null, controls.now), tx);
        },
        publishing: {
          async authorize(request) {
            if (controls.denied) throw new Error("controlled current permission refusal");
            return evaluatePermission({
              tenantContext: request.tenantContext,
              action: request.action,
              resourceScope: request.resourceScope,
              policySnapshotReference: parsePolicyReference(id(40)),
              policyVersion: parsePolicyVersion(1),
              evidence: [
                {
                  source: "RolePermission",
                  evidenceReference: parseEvidenceReference(id(41)),
                  action: request.action,
                  actorReference: actorReference as NonNullable<typeof actor.actorReference>,
                  roleReference: parseRoleReference(id(42)),
                  brandReference: brand.brandReference,
                  storeReference: null,
                  effectiveFrom: parseEvidenceInstant(at),
                  effectiveUntil: null,
                },
              ],
            });
          },
        },
      },
      references: {
        async withCurrentReferences(actual, _input, work) {
          expect(actual).toBe(tx);
          if (controls.referenceDenied) throw new Error("controlled missing source");
          const base = material(),
            value = {
              ...base,
              catalog: { ...base.catalog, actorReference: parseCatalogReference(actorReference) },
            };
          guards.push({
            guard: async () => {
              if (controls.referenceDenied) throw new Error("controlled late source withdrawal");
            },
            final: () => undefined,
          });
          return work(change ? change(value) : value, tx);
        },
      },
    };
    const administrationOptions: MerchantBrandAdministrationConfigurationPreparationOptions = {
      ...options,
      authority: {
        async withCurrentContext(actual, _input, work) {
          expect(actual).toBe(tx);
          if (controls.denied)
            throw new Error("controlled current administrative authority refusal");
          guards.push({
            guard: async () => {
              if (controls.denied)
                throw new Error("controlled late administrative authority refusal");
            },
            final: () => undefined,
          });
          if (controls.wrongContextProfile)
            return Reflect.apply(work, undefined, [
              createTenantContext(actor, brand, null, controls.now),
              tx,
            ]);
          return work(createBrandAdministrationContext(actor, brand, controls.now), tx);
        },
        publishing: {
          async authorize(request) {
            if (controls.denied)
              throw new Error("controlled current administrative permission refusal");
            const ref = actor.actorReference;
            if (ref === null) throw new Error("Controlled named User required");
            if (
              request.resourceScope.kind !== "Brand" ||
              request.resourceScope.storeReference !== null
            )
              throw new Error("Controlled Brand resource required");
            return evaluateBrandAdministrationPermission({
              administrationContext: request.administrationContext,
              action: request.action,
              resourceScope: {
                kind: "Brand",
                brandReference: request.resourceScope.brandReference,
                storeReference: null,
              },
              policySnapshotReference: parsePolicyReference(id(40)),
              policyVersion: parsePolicyVersion(1),
              evidence: [
                {
                  source: "RolePermission",
                  evidenceReference: parseEvidenceReference(id(41)),
                  action: request.action,
                  actorReference: ref,
                  roleReference: parseRoleReference(id(42)),
                  brandReference: brand.brandReference,
                  storeReference: null,
                  effectiveFrom: parseEvidenceInstant(at),
                  effectiveUntil: null,
                },
              ],
            });
          },
        },
      },
    };
    const prepare = administrative
      ? createMerchantBrandAdministrationConfigurationPreparation(administrationOptions)
      : createMerchantBrandConfigurationPreparation(options);
    return {
      options,
      administrationOptions,
      prepare,
      addGuard(guard: () => Promise<void>) {
        guards.push({ guard, final: () => undefined });
      },
      async finalize() {
        const selected = guards.slice(start);
        for (const g of selected) await g.guard();
        for (const g of selected) g.final();
      },
    };
  }
  function command(
    name: BrandConfigurationCommand["command"],
    current: BrandConfigurationRevision | null = null,
    actorReference = id(3),
  ) {
    return parseBrandConfigurationCommand({
      profile: "TenantBrandConfigurationCommandV1",
      tenantReference,
      brandReference: id(2),
      actorReference,
      command: name,
      operationReference: id(++controls.next),
      expectedBrandVersion: 1,
      expectedHead: current
        ? {
            revision: current.revision,
            configurationVersionReference: current.configuration.configurationVersionReference,
            sourceDigest: current.sourceDigest,
          }
        : null,
      configuration: name === "SaveConfigurationDraft" ? fields() : null,
      reviewValidUntil: name === "SubmitConfiguration" ? after(60000) : null,
      purposeCode: "BRAND_CONFIGURATION",
    });
  }
  const configuration = createBrandConfigurationVersion({
    ...fields(),
    configurationVersionReference: id(20),
    brandReference: id(2),
    configurationVersion: 1,
    lifecycle: "Draft",
    supersedesVersionReference: null,
    authoredByReference: id(3),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  function revision(
    request: BrandConfigurationCommand,
    prepared: BrandConfigurationFreshPreparation,
    prior: BrandConfigurationRevision | null,
  ) {
    return createBrandConfigurationRevision(
      {
        profile: "TenantBrandConfigurationRevisionV1",
        tenantReference,
        brandReference: id(2),
        actorReference: request.actorReference,
        revision: (prior?.revision ?? 0) + 1,
        brandVersion: 1,
        command: request.command,
        operationReference: request.operationReference,
        configuration: prepared.configuration,
        submittedByReference: prepared.submittedByReference,
        publishing: prepared.publishing,
        auditReference: id(++controls.next),
        createdAt: prior?.createdAt ?? prepared.occurredAt,
        recordedAt: prepared.occurredAt,
        dataClassification: "ConfigurationMetadata",
      },
      digestReferences,
    );
  }
  async function step(
    name: BrandConfigurationCommand["command"],
    current: BrandConfigurationRevision | null = null,
    actorReference = id(3),
  ) {
    const h = host(actorReference),
      request = command(name, current, actorReference),
      prepared = await h.prepare(tx, {
        command: request,
        current,
        configuration: current?.configuration ?? configuration,
        observedAt: controls.now,
        validUntil: leaseUntil(),
      });
    await h.finalize();
    return revision(request, prepared, current);
  }
  return { records, calls, controls, query, tx, host, command, configuration, revision, step };
}

it("composes genuine public CreateDraft/Submit, independent Approve and Publish with actual receipts and unchanged validation identity", async () => {
  const f = fixture(),
    saved = await f.step("SaveConfigurationDraft"),
    submitted = await f.step("SubmitConfiguration", saved);
  expect(f.records.map((r) => r.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  expect(submitted.configuration.lifecycle).toBe("PendingApproval");
  expect(submitted.submittedByReference).toBe(id(3));
  const validation = submitted.publishing?.validationEvidenceReference;
  f.controls.now = after(10000);
  const approved = await f.step("ApproveConfiguration", submitted, id(8));
  f.controls.now = after(20000);
  const published = await f.step("PublishConfiguration", approved, id(3));
  expect(f.records.map((r) => r.operation)).toEqual([
    "CreateDraft",
    "SubmitReview",
    "Approve",
    "Publish",
  ]);
  expect(approved.configuration.approvedByReference).toBe(id(8));
  expect(published.configuration.lifecycle).toBe("Published");
  expect(published.configuration.publicationReference).toBe(f.records[3]?.release?.releaseId);
  expect(f.records[3]?.release?.previousReleaseId).toBeNull();
  expect(f.records[3]?.validationEvidence).toEqual(f.records[1]?.validationEvidence);
  expect(published.publishing?.validationEvidenceReference).toBe(validation);
  expect(f.records[1]?.validationEvidence?.validUntil).toBe(after(60000));
  expect(f.calls.some((sql) => sql.startsWith("INSERT INTO platform_audit"))).toBe(true);
  expect(f.calls).not.toContain("COMMIT");
  expect(f.calls.findIndex((sql) => sql.includes("SHARE ROW EXCLUSIVE"))).toBeLessThan(
    f.calls.findIndex((sql) => sql.startsWith("INSERT INTO bop_publishing")),
  );
});

it("returns the owning permission denial for separate actual author and submitter before Core admission, ID allocation or Audit", async () => {
  for (const actorReference of [id(3), id(6)]) {
    const f = fixture(),
      saved = await f.step("SaveConfigurationDraft"),
      submitted = await f.step("SubmitConfiguration", saved, id(6)),
      h = f.host(actorReference),
      request = f.command("ApproveConfiguration", submitted, actorReference),
      records = [...f.records],
      calls = f.calls.length,
      next = f.controls.next;
    expect(submitted.configuration.authoredByReference).toBe(id(3));
    expect(submitted.submittedByReference).toBe(id(6));
    await expect(
      h.prepare(f.tx, {
        command: request,
        current: submitted,
        configuration: submitted.configuration,
        observedAt: f.controls.now,
        validUntil: after(5000),
      }),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_PERMISSION_DENIED" });
    expect(f.records).toEqual(records);
    expect(f.calls).toHaveLength(calls);
    expect(f.controls.next).toBe(next);
  }
});

it("preserves the genuine Active Brand context boundary and never fabricates activation for a Draft Brand", async () => {
  const f = fixture(),
    saved = await f.step("SaveConfigurationDraft");
  f.controls.brandLifecycle = "Draft";
  await expect(f.step("SubmitConfiguration", saved)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.records).toHaveLength(0);
});

it("Save source failures and incompatible selected material cannot become a prepared Draft or Core fact", async () => {
  for (const change of [
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      catalog: { ...m.catalog, source: null },
    }),
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      template: { ...m.template, reference: id(99) },
    }),
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      template: { ...m.template, supportedLocales: ["fr-CA"] },
    }),
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      template: { ...m.template, hardRequirementFieldCodes: ["OTHER"] },
    }),
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      template: { ...m.template, overrideAllowedFieldCodes: [] },
    }),
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      template: { ...m.template, effectiveUntil: after(1000) },
    }),
    (m: BrandConfigurationReferenceMaterials) => ({
      ...m,
      theme: { reference: id(9), digest: hash, effectiveFrom: at, effectiveUntil: null },
    }),
  ]) {
    const f = fixture(),
      h = f.host(id(3), change);
    await expect(
      h.prepare(f.tx, {
        command: f.command("SaveConfigurationDraft"),
        current: null,
        configuration: f.configuration,
        observedAt: at,
        validUntil: after(5000),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(f.records).toHaveLength(0);
  }
});

it("requires explicit real reference ports and never defaults to successful qualification", () => {
  const f = fixture(),
    h = f.host();
  const missing = { ...h.options, references: {} } as MerchantBrandConfigurationPreparationOptions;
  expect(() => createMerchantBrandConfigurationPreparation(missing)).toThrow();
});

it("admits a nonnull theme only with matching actual held material and unchanged selected Draft bytes", async () => {
  const f = fixture(),
    selected = createBrandConfigurationVersion({ ...f.configuration, mediaThemeReference: id(9) }),
    request = parseBrandConfigurationCommand({
      ...f.command("SaveConfigurationDraft"),
      configuration: { ...fields(), mediaThemeReference: id(9) },
    }),
    h = f.host(id(3), (m) => ({
      ...m,
      theme: { reference: id(9), digest: hash, effectiveFrom: at, effectiveUntil: after(120000) },
    }));
  const prepared = await h.prepare(f.tx, {
    command: request,
    current: null,
    configuration: selected,
    observedAt: at,
    validUntil: after(5000),
  });
  expect(prepared.configuration.mediaThemeReference).toBe(id(9));
  expect(prepared.configuration.createdAt).toBe(selected.createdAt);
  await h.finalize();
});

it("retains original five-second authority independently of business review validity and refuses final expiry", async () => {
  const f = fixture(),
    h = f.host(),
    request = f.command("SaveConfigurationDraft");
  await h.prepare(f.tx, {
    command: request,
    current: null,
    configuration: f.configuration,
    observedAt: at,
    validUntil: after(5000),
  });
  f.controls.now = after(5000);
  await expect(h.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
});

it("seals original and immutable business deadlines again after a later asynchronous guard consumes the remaining time", async () => {
  for (const businessExpiry of [false, true]) {
    const f = fixture(),
      saved = await f.step("SaveConfigurationDraft"),
      submitted = businessExpiry ? await f.step("SubmitConfiguration", saved) : null;
    if (businessExpiry) f.controls.now = after(59999);
    const h = f.host(businessExpiry ? id(8) : id(3)),
      request = f.command(
        businessExpiry ? "ApproveConfiguration" : "SaveConfigurationDraft",
        submitted,
        businessExpiry ? id(8) : id(3),
      ),
      originalUntil = new Date(Date.parse(f.controls.now) + 5000).toISOString();
    await h.prepare(f.tx, {
      command: request,
      current: submitted,
      configuration: submitted?.configuration ?? f.configuration,
      observedAt: f.controls.now,
      validUntil: originalUntil,
    });
    h.addGuard(async () => {
      await Promise.resolve();
      f.controls.now = businessExpiry ? after(60000) : originalUntil;
    });
    const commit = vi.fn();
    await expect(
      (async () => {
        await h.finalize();
        commit();
      })(),
    ).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(commit).not.toHaveBeenCalled();
    if (businessExpiry) {
      expect(Date.parse(f.controls.now)).toBeLessThan(Date.parse(originalUntil));
      expect(f.records[1]?.validationEvidence?.validUntil).toBe(after(60000));
    }
  }
});

it("retains mandatory source guard withdrawal through the outer commit boundary", async () => {
  const f = fixture(),
    h = f.host();
  await h.prepare(f.tx, {
    command: f.command("SaveConfigurationDraft"),
    current: null,
    configuration: f.configuration,
    observedAt: at,
    validUntil: after(5000),
  });
  f.controls.referenceDenied = true;
  await expect(h.finalize()).rejects.toThrow("controlled late source withdrawal");
});

it("refuses expired original Submit evidence without changing its identity or creating approval", async () => {
  const f = fixture(),
    saved = await f.step("SaveConfigurationDraft"),
    submitted = await f.step("SubmitConfiguration", saved);
  f.controls.now = after(60000);
  const h = f.host(id(8));
  await expect(
    h.prepare(f.tx, {
      command: f.command("ApproveConfiguration", submitted, id(8)),
      current: submitted,
      configuration: submitted.configuration,
      observedAt: f.controls.now,
      validUntil: after(65000),
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(f.records).toHaveLength(2);
  expect(f.records[1]?.validationEvidence?.validUntil).toBe(after(60000));
});

it("rejects actual transaction substitution, captured port drift and caught reentry", async () => {
  for (const mode of ["transaction", "port", "reentry"] as const) {
    const f = fixture(),
      h = f.host(),
      input = {
        command: f.command("SaveConfigurationDraft"),
        current: null,
        configuration: f.configuration,
        observedAt: at,
        validUntil: after(5000),
      };
    if (mode === "port")
      Object.assign(h.options.references, { withCurrentReferences: async () => null });
    if (mode === "reentry") {
      const original = h.options.references.withCurrentReferences;
      const options = {
        ...h.options,
        references: {
          async withCurrentReferences<T>(
            tx: Parameters<typeof original>[0],
            value: Parameters<typeof original>[1],
            work: Parameters<typeof original>[2],
          ): Promise<T> {
            await expect(prepare(tx, value)).rejects.toMatchObject({
              code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
            });
            return original(tx, value, work) as Promise<T>;
          },
        },
      };
      const prepare = createMerchantBrandConfigurationPreparation(options);
      await expect(prepare(f.tx, input)).rejects.toMatchObject({
        code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      });
    } else {
      await expect(
        h.prepare(mode === "transaction" ? { query: f.query } : f.tx, input),
      ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE" });
    }
    expect(f.records).toHaveLength(0);
  }
});

it("prepares and independently publishes genuine Draft Brand configuration through the administrative Context", async () => {
  const f = fixture(true);
  f.controls.brandLifecycle = "Draft";
  const saved = await f.step("SaveConfigurationDraft");
  const submitted = await f.step("SubmitConfiguration", saved);
  await expect(f.step("ApproveConfiguration", submitted)).rejects.toThrow();
  const approved = await f.step("ApproveConfiguration", submitted, id(7));
  const published = await f.step("PublishConfiguration", approved, id(7));
  expect(published.configuration.lifecycle).toBe("Published");
  expect(f.records.map((record) => record.operation)).toContain("Publish");
});

it.each([false, true])(
  "keeps preparation context profiles closed, administrative=%s",
  async (administrative) => {
    const f = fixture(administrative);
    f.controls.wrongContextProfile = true;
    await expect(f.step("SaveConfigurationDraft")).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.records).toHaveLength(0);
  },
);
it("retains Draft administrative business review expiry and late IAM refusal", async () => {
  const f = fixture(true);
  f.controls.brandLifecycle = "Draft";
  const saved = await f.step("SaveConfigurationDraft"),
    submitted = await f.step("SubmitConfiguration", saved);
  f.controls.now = after(60000);
  await expect(f.step("ApproveConfiguration", submitted, id(7))).rejects.toThrow();
  expect(f.records.some((record) => record.operation === "Approve")).toBe(false);
  const g = fixture(true);
  g.controls.brandLifecycle = "Draft";
  const h = g.host(id(3)),
    request = g.command("SaveConfigurationDraft");
  await h.prepare(g.tx, {
    command: request,
    current: null,
    configuration: g.configuration,
    observedAt: at,
    validUntil: after(5000),
  });
  g.controls.denied = true;
  await expect(h.finalize()).rejects.toThrow();
});
