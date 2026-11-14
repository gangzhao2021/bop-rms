import { parseRecordedPublishingMutation } from "@bop/publishing";
import { parseDigitalReceiptTemplateSubmission } from "../contracts/digital-receipt-template-submission.js";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  createPostgresDigitalReceiptTemplateDraftStore,
  type DigitalReceiptTemplateEditingReview,
  type DigitalReceiptTemplateDraftStoreOptions,
  type DigitalReceiptTemplateDraftTransaction,
} from "../infrastructure/persistence/digital-receipt-template-draft-store.js";
import {
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateDraftSave,
  parseDigitalReceiptTemplateDraftResolve,
  type DigitalReceiptTemplateDraftReceipt,
} from "../contracts/digital-receipt-template-draft.js";
import { parseDigitalReceiptTemplateArtifactVersion } from "../contracts/digital-receipt-template-artifact.js";
import {
  digitalReceiptRequiredFields,
  DigitalReceiptTemplateError,
} from "../contracts/digital-receipt-template.js";
// Controlled owner SQL/counter/artifact/admission ports, not native IAM, Publishing or professional review.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(Object.getOwnPropertyDescriptor(v, k)?.value)}`)
      .join(",")}}`;
  const s = JSON.stringify(v);
  if (s === undefined) throw new Error("noncanonical fixture");
  return s;
}
const hash = (v: string) => `sha256:${createHash("sha256").update(v).digest("hex")}`;
interface DB {
  versions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
function fixture(db: DB = { versions: [], operations: [] }, actor = id(4)) {
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actor,
  };
  let now = at,
    next = 100 + db.versions.length * 10 + db.operations.length * 10,
    allowed = true,
    lease = until,
    scoped = false,
    flushDenied = false,
    published = 1,
    sourceDrift = false,
    childChecks = false;
  let editingPacket: DigitalReceiptTemplateEditingReview | undefined;
  const editingReads: unknown[] = [];
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    locks: string[] = [],
    sql: string[] = [],
    audits: unknown[] = [],
    artifactReads: string[] = [],
    holds: Parameters<
      DigitalReceiptTemplateDraftStoreOptions["authority"]["holdUntilTransactionCompletes"]
    >[1][] = [];
  const tx: DigitalReceiptTemplateDraftTransaction = {
    query: vi.fn(async (statement: string, v: readonly unknown[]) => {
      sql.push(statement);
      if (statement.includes("bop.tenant_id")) {
        scoped =
          v[0] === scope.tenantReference &&
          v[1] === scope.brandReference &&
          v[2] === scope.storeReference;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("transaction_isolation"))
        return { rows: [{ isolation: "read committed" }], rowCount: 1 };
      if (statement.includes("pg_advisory")) {
        locks.push(String(v[0]));
        return { rows: [], rowCount: 1 };
      }
      if (statement.startsWith("SET CONSTRAINTS")) {
        if (!scoped || flushDenied) throw new Error("controlled coherence refusal");
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("FROM rms_device.digital_receipt_template_draft_revision")) {
        if (statement.includes("DISTINCT ON (template_id)")) {
          const heads = new Map<string, Record<string, unknown>>();
          for (const row of db.versions) {
            const key = String(row.template_id),
              old = heads.get(key);
            if (!old || Number(row.revision) > Number(old.revision)) heads.set(key, row);
          }
          const page = [...heads.values()]
            .filter((row) => v[3] === null || String(row.template_id) > String(v[3]))
            .sort((a, b) => String(a.template_id).localeCompare(String(b.template_id)))
            .slice(0, 21);
          return { rows: page, rowCount: page.length };
        }
        let rows = db.versions;
        if (statement.includes("ORDER BY"))
          rows = rows.filter((r) => r.template_id === v[3]).slice(-1);
        else if (statement.includes("AND template_id"))
          rows = rows.filter((r) => r.template_id === v[3] && r.version_id === v[4]);
        else
          rows = rows.filter(
            (r) => r.version_id === v[3] && r.revision === String(v[4]) && r.operation_id === v[5],
          );
        return { rows, rowCount: rows.length };
      }
      if (statement.includes("FROM rms_device.digital_receipt_template_draft_operation")) {
        const rows = db.operations.filter(
          (r) =>
            r.tenant_id === v[0] &&
            r.brand_id === v[1] &&
            r.store_id === v[2] &&
            r.operation_id === v[3],
        );
        return { rows, rowCount: rows.length };
      }
      if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_draft_revision"))
        db.versions.push({
          template_id: v[3],
          family_id: v[4],
          version_id: v[5],
          revision: String(v[6]),
          publication_version_number: String(v[7]),
          operation_id: v[8],
          actor_id: v[9],
          previous_version_id: v[10],
          content_digest: v[11],
          snapshot_json: JSON.parse(String(v[12])),
          snapshot_digest: v[13],
          created_at: v[14],
          updated_at: v[15],
        });
      if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_draft_operation")) {
        if (db.operations.some((r) => r.operation_id === v[0]))
          throw new Error("duplicate original");
        db.operations.push({
          operation_id: v[0],
          tenant_id: v[1],
          brand_id: v[2],
          store_id: v[3],
          actor_id: v[4],
          template_id: v[5],
          intent_digest: v[6],
          expected_version_id: v[7],
          expected_revision: String(v[8]),
          outcome: v[9],
          result_version_id: v[10],
          result_revision: v[11] === null ? null : String(v[11]),
          snapshot_digest: v[12],
          audit_reference: v[13],
          occurred_at: v[14],
        });
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const options: DigitalReceiptTemplateDraftStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: at,
    originalValidUntil: until,
    registerBeforeCommit: (_tx, guard, final) => {
      expect(_tx).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
    authority: {
      holdUntilTransactionCompletes: async (actual, input) => {
        expect(actual).toBe(tx);
        holds.push(input);
        scoped = false;
        if (!allowed) throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        return { validUntil: lease };
      },
    },
    references: { canonicalize: canonical, hashIntent: hash, nextReference: () => id(next++) },
    readEditingReview: vi.fn(async (actual, input) => {
      expect(actual).toBe(tx);
      expect(input.observedAt).toBe(at);
      editingReads.push(input);
      scoped = false;
      return (
        editingPacket ??
        Object.freeze({
          profile: "DigitalReceiptTemplateEditingReviewV1",
          submission: null,
          mutation: null,
          observedAt: at,
          validUntil: input.validUntil,
        })
      );
    }),
    readPublicationSequence: vi.fn(async (actual, input) => {
      expect(actual).toBe(tx);
      scoped = false;
      return {
        profile: "DigitalReceiptTemplatePublicationSequenceV1" as const,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        templateReference: input.templateReference,
        nextVersionNumber: published,
        latestVersionReference: published === 1 ? null : id(90),
      };
    }),
    readArtifact: vi.fn(async (actual, input) => {
      expect(actual).toBe(tx);
      if (childChecks) throw new Error("child callback expired");
      artifactReads.push(input.artifactKind);
      scoped = false;
      return parseDigitalReceiptTemplateArtifactVersion({
        profile: "DigitalReceiptTemplateArtifactV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: sourceDrift ? id(9) : scope.storeReference,
        artifactKind: input.artifactKind,
        artifactReference: input.artifactReference,
        revision: 1,
        authoredByReference: id(8),
        previousArtifactReference: null,
        content:
          input.artifactKind === "Layout"
            ? {
                profile: "AccessibleDigitalReceiptLayoutV1",
                dataContractVersion: 1,
                renderEngineVersion: 1,
                outputProfile: "AccessibleDigitalReceipt",
                requiredFields: [...digitalReceiptRequiredFields],
              }
            : {
                profile: "DigitalReceiptRequiredFieldRuleV1",
                dataContractVersion: 1,
                requiredFields: [...digitalReceiptRequiredFields],
                professionalReviewStatus: "NotEvaluated",
                legalConclusion: "NotEvaluated",
              },
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      });
    }),
    appendAudit: async (actual, input) => {
      expect(actual).toBe(tx);
      audits.push(input);
      scoped = false;
    },
  };
  const store = createPostgresDigitalReceiptTemplateDraftStore(options);
  const save = (op = 10, receipt?: DigitalReceiptTemplateDraftReceipt) => {
    const s = receipt?.snapshot;
    return parseDigitalReceiptTemplateDraftSave({
      profile: "DigitalReceiptTemplateDraftSaveV1",
      ...scope,
      operationReference: id(op),
      templateReference: s?.content.templateReference ?? null,
      expectedVersionReference: s?.content.versionReference ?? null,
      expectedRevision: s?.revision ?? 0,
      fields: {
        locale: "en-CA",
        layoutDefinitionReference: id(5),
        complianceRuleReference: id(6),
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      },
      purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
    });
  };
  const resolve = (command: ReturnType<typeof save>) => {
    const { fields, ...pins } = command;
    void fields;
    return parseDigitalReceiptTemplateDraftResolve({
      ...pins,
      profile: "DigitalReceiptTemplateDraftResolveV1",
      intentDigest: hash(canonical(command)),
    });
  };
  const finish = async () => {
    for (const g of guards) await g();
    for (const f of finals) f();
    return store.assertFinalized(tx);
  };
  return {
    scope,
    options,
    tx,
    store,
    db,
    save,
    resolve,
    finish,
    guards,
    finals,
    holds,
    audits,
    locks,
    sql,
    artifactReads,
    editingReads,
    setEditingReview: (packet: DigitalReceiptTemplateEditingReview) => {
      editingPacket = packet;
    },
    setAllowed: (v: boolean) => {
      allowed = v;
    },
    setLease: (v: string) => {
      lease = v;
    },
    setNow: (v: string) => {
      now = v;
    },
    setPublished: (v: number) => {
      published = v;
    },
    setSourceDrift: () => {
      sourceDrift = true;
    },
    setFlushDenied: () => {
      flushDenied = true;
    },
    setChildChecks: () => {
      childChecks = true;
    },
  };
}
describe("ReceiptTemplate Draft immutable owning source", () => {
  it("allocates actual template/family/version, preserves null intent pin and published number across edits", async () => {
    const f = fixture(),
      command = f.save(),
      r = await f.store.save(command);
    expect(r.outcome).toBe("Committed");
    expect(r.templateReference).toBeNull();
    expect(r.snapshot?.content.versionCode).toBe("RECEIPT_1");
    expect(r.snapshot?.familyReference).not.toBe(r.snapshot?.content.templateReference);
    expect(f.artifactReads).toEqual(["Layout", "Compliance"]);
    expect(f.locks[0]).toBe(`ReceiptTemplateDraftOperation:${command.operationReference}`);
    await f.finish();
    const edit = fixture(f.db, id(8));
    edit.setNow("2026-10-05T10:00:01.000Z");
    const next = await edit.store.save(edit.save(11, r));
    expect(next.snapshot?.revision).toBe(2);
    expect(next.snapshot?.content.versionNumber).toBe(1);
    expect(next.snapshot?.familyReference).toBe(r.snapshot?.familyReference);
    expect(next.snapshot?.createdAt).toBe(r.snapshot?.createdAt);
    expect(next.snapshot?.previousVersionReference).toBe(r.snapshot?.content.versionReference);
    expect(next.snapshot?.authoredByReference).toBe(id(8));
    await edit.finish();
  });
  it("replays exact stored original without current counter/artifact acquisition or allocation", async () => {
    const f = fixture(),
      c = f.save(),
      r = await f.store.save(c);
    await f.finish();
    const retry = fixture(f.db);
    retry.options.references.nextReference = () => {
      throw new Error("should not allocate");
    };
    // Recreate after assigning captured ports; mutating a captured port is intentionally denied below.
    const store = createPostgresDigitalReceiptTemplateDraftStore(retry.options);
    expect(await store.save(c)).toEqual(r);
    for (const g of retry.guards) await g();
    for (const a of retry.finals) a();
    store.assertFinalized(retry.tx);
    expect(retry.options.readArtifact).not.toHaveBeenCalled();
    expect(retry.options.readPublicationSequence).not.toHaveBeenCalled();
    expect(retry.audits).toHaveLength(0);
  });
  it("returns Committed original via payload-free Resolve after head successor", async () => {
    const f = fixture(),
      c = f.save(),
      r = await f.store.save(c);
    await f.finish();
    const edit = fixture(f.db);
    await edit.store.save(edit.save(11, r));
    await edit.finish();
    const recovery = fixture(f.db);
    expect(await recovery.store.resolve(recovery.resolve(c))).toEqual(r);
    await recovery.finish();
    expect(recovery.options.readArtifact).not.toHaveBeenCalled();
  });
  it("durably abandons absence and a late Save returns identical terminal without a version", async () => {
    const f = fixture(),
      c = f.save(),
      r = await f.store.resolve(f.resolve(c));
    expect(r.outcome).toBe("Abandoned");
    await f.finish();
    expect(f.db.versions).toHaveLength(0);
    const late = fixture(f.db);
    expect(await late.store.save(c)).toEqual(r);
    await late.finish();
    expect(late.audits).toHaveLength(0);
  });
  it("reads truthful empty current and immutable exact historical version for a different reader", async () => {
    const empty = fixture();
    expect((await empty.store.readCurrent({ templateReference: null })).snapshot).toBeNull();
    await empty.finish();
    const f = fixture(),
      r = await f.store.save(f.save());
    await f.finish();
    if (!r.snapshot) throw new Error("fixture expected snapshot");
    const read = fixture(f.db, id(8));
    expect(
      await read.store.readVersion({
        templateReference: r.snapshot.content.templateReference,
        versionReference: r.snapshot.content.versionReference,
      }),
    ).toEqual(r.snapshot);
    await read.finish();
    expect(read.holds.every((h) => h.permission === "organization.manage")).toBe(true);
    expect(read.options.readArtifact).not.toHaveBeenCalled();
  });
  it("rejects CAS mismatch, changed original intent and foreign original Actor without extra artifacts", async () => {
    const f = fixture(),
      c = f.save(),
      r = await f.store.save(c);
    await f.finish();
    const wrong = fixture(f.db);
    await expect(
      wrong.store.save({ ...c, fields: { ...c.fields, locale: "fr-CA" } }),
    ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
    const actor = fixture(f.db, id(8));
    await expect(
      actor.store.resolve({ ...actor.resolve(c), actorReference: id(8) }),
    ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
    const stale = fixture(f.db);
    await expect(
      stale.store.save({ ...stale.save(11, r), expectedVersionReference: id(99) }),
    ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
    expect(f.db.operations).toHaveLength(1);
  });
  it("final rereads counter and artifacts before child checks; advancing Published head refuses commit", async () => {
    const f = fixture();
    await f.store.save(f.save());
    f.setPublished(2);
    await expect(f.finish()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
    const good = fixture();
    await good.store.save(good.save());
    good.guards.push(async () => {
      good.setChildChecks();
    });
    await good.finish();
    expect(good.artifactReads).toEqual(["Layout", "Compliance", "Layout", "Compliance"]);
  });
  it("rejects foreign immutable artifact scope and poisons future use", async () => {
    const f = fixture();
    f.setSourceDrift();
    await expect(f.store.save(f.save())).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_UNAVAILABLE",
    });
    await expect(f.store.readCurrent({ templateReference: null })).rejects.toThrow();
    expect(f.db.versions).toHaveLength(0);
  });
  it("restores own scope for only new-original named coherence flush; reads and replay do not flush", async () => {
    const f = fixture(),
      c = f.save();
    await f.store.resolve(f.resolve(c));
    await f.finish();
    expect(f.sql.filter((s) => s.startsWith("SET CONSTRAINTS"))).toHaveLength(1);
    const read = fixture();
    await read.store.readCurrent({ templateReference: null });
    await read.finish();
    expect(read.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
    const retry = fixture(f.db);
    await retry.store.resolve(retry.resolve(c));
    await retry.finish();
    expect(retry.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
  });
  it("denies late permission withdrawal, shortest lease expiry and constraint refusal", async () => {
    for (const failure of ["authority", "lease", "constraint"]) {
      const f = fixture();
      await f.store.save(f.save());
      if (failure === "authority") f.setAllowed(false);
      if (failure === "lease") f.setLease(at);
      if (failure === "constraint") f.setFlushDenied();
      await expect(f.finish()).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
      expect(() => f.store.assertFinalized(f.tx)).toThrow();
    }
  });
  it("rejects invalid closed inputs before allocating and malformed current sequence before content writes", async () => {
    const invalid = fixture();
    await expect(
      invalid.store.readCurrent({ templateReference: null, actorReference: id(8) }),
    ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_INPUT_INVALID" });
    expect(invalid.audits).toHaveLength(0);
    const bad = fixture();
    Object.defineProperty(bad.options, "readPublicationSequence", {
      value: async () => ({
        profile: "DigitalReceiptTemplatePublicationSequenceV1",
        brandReference: id(2),
        storeReference: id(3),
        templateReference: id(100),
        nextVersionNumber: 2,
        latestVersionReference: null,
      }),
      enumerable: true,
    });
    const source = createPostgresDigitalReceiptTemplateDraftStore(bad.options);
    await expect(source.save(bad.save())).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_UNAVAILABLE",
    });
    expect(bad.db.versions).toHaveLength(0);
  });
  it("requires actual completed async/sync hooks, rejects reentry, substitutions and duplicate hooks", async () => {
    const f = fixture();
    await f.store.readCurrent({ templateReference: null });
    expect(() => f.store.assertFinalized(f.tx)).toThrow();
    const doubled = fixture();
    await doubled.store.readCurrent({ templateReference: null });
    await doubled.finish();
    await expect(doubled.guards[0]?.()).rejects.toThrow();
    const drift = fixture();
    await drift.store.readCurrent({ templateReference: null });
    Object.defineProperty(drift.options, "readArtifact", {
      value: async () => null,
      enumerable: true,
    });
    await expect(drift.finish()).rejects.toThrow();
    const concurrent = fixture();
    const first = concurrent.store.readCurrent({ templateReference: null });
    await expect(concurrent.store.readCurrent({ templateReference: null })).rejects.toThrow();
    await expect(first).rejects.toThrow();
  });
});

it("roster discovers multiple independent templates and locks exact sorted heads, not singleton", async () => {
  const db: DB = { versions: [], operations: [] };
  for (let n = 0; n < 2; n++) {
    const writer = fixture(db);
    await writer.store.save(writer.save(20 + n));
    await writer.finish();
  }
  const reader = fixture(db, id(8)),
    page = await reader.store.readRoster({ afterTemplate: null });
  expect(page.entries).toHaveLength(2);
  expect(page.entries.map((e) => e.content.templateReference)).toEqual(
    [...page.entries.map((e) => e.content.templateReference)].sort(),
  );
  expect(page.nextAfter).toBeNull();
  expect(page.actorReference).toBe(id(8));
  expect(reader.locks).toEqual(
    page.entries.map(
      (e) =>
        `ReceiptTemplate:${reader.scope.brandReference}:${reader.scope.storeReference}:${e.content.templateReference}`,
    ),
  );
  await reader.finish();
  expect(reader.audits).toEqual([]);
  expect(reader.options.readArtifact).not.toHaveBeenCalled();
  expect(reader.options.readPublicationSequence).not.toHaveBeenCalled();
});
it("roster pages twenty heads with a single lookahead and resumes after exact last template", async () => {
  const writer = fixture();
  await writer.store.save(writer.save());
  await writer.finish();
  const base = writer.db.versions[0];
  if (!base) throw new Error("missing seed");
  const source = base.snapshot_json;
  if (!source || typeof source !== "object") throw new Error("missing seed snapshot");
  for (let n = 1; n < 21; n++) {
    const original = parseDigitalReceiptTemplateDraft(source),
      content = {
        ...original.content,
        templateReference: id(500 + n),
        versionReference: id(2000 + n),
      },
      snapshot = parseDigitalReceiptTemplateDraft({
        ...original,
        familyReference: id(1000 + n),
        content,
        contentDigest: hash(canonical(content)),
      });
    writer.db.versions.push({
      ...base,
      template_id: snapshot.content.templateReference,
      family_id: snapshot.familyReference,
      version_id: snapshot.content.versionReference,
      snapshot_json: snapshot,
      content_digest: snapshot.contentDigest,
      snapshot_digest: hash(canonical(snapshot)),
    });
  }
  const first = fixture(writer.db),
    page = await first.store.readRoster({ afterTemplate: null });
  expect(page.entries).toHaveLength(20);
  expect(page.nextAfter).toBe(page.entries.at(-1)?.content.templateReference);
  await first.finish();
  const second = fixture(writer.db),
    next = await second.store.readRoster({ afterTemplate: page.nextAfter });
  expect(next.entries).toHaveLength(1);
  expect(next.nextAfter).toBeNull();
  await second.finish();
});
it("roster final head drift or late permission denies and poisons completion", async () => {
  const writer = fixture();
  await writer.store.save(writer.save());
  await writer.finish();
  for (const failure of ["head", "permission"]) {
    const reader = fixture(writer.db);
    await reader.store.readRoster({ afterTemplate: null });
    if (failure === "head") writer.db.versions = [];
    else reader.setAllowed(false);
    await expect(reader.finish()).rejects.toMatchObject({
      code: failure === "head" ? "RECEIPT_TEMPLATE_CONFLICT" : "RECEIPT_TEMPLATE_PERMISSION_DENIED",
    });
    expect(() => reader.store.assertFinalized(reader.tx)).toThrow();
  }
});
it("roster rejects malformed cursor and switching page under the same holder", async () => {
  const bad = fixture();
  await expect(bad.store.readRoster({ afterTemplate: null, limit: 20 })).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_INPUT_INVALID",
  });
  const good = fixture();
  await good.store.readRoster({ afterTemplate: null });
  await expect(good.store.readRoster({ afterTemplate: id(99) })).rejects.toThrow();
});

function editingRecord(
  receipt: DigitalReceiptTemplateDraftReceipt,
  state: "InReview" | "Approved" | "Published" | "Archived" = "InReview",
  businessUntil = "2026-10-05T10:01:00.000Z",
): DigitalReceiptTemplateEditingReview {
  const snapshot = receipt.snapshot;
  if (!snapshot) throw new Error("required original Draft missing");
  const submission = parseDigitalReceiptTemplateSubmission({
    profile: "DigitalReceiptTemplateSubmissionV1",
    tenantReference: snapshot.tenantReference,
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    templateReference: snapshot.content.templateReference,
    familyReference: snapshot.familyReference,
    versionReference: snapshot.content.versionReference,
    draftRevision: snapshot.revision,
    contentDigest: snapshot.contentDigest,
    authoredByReference: snapshot.authoredByReference,
    submittedByReference: id(50),
    operationReference: id(51),
    reviewLifecycleReference: id(52),
    reviewVersion: 2,
    validationEvidenceReference: id(53),
    checkedAt: at,
    validationValidUntil: businessUntil,
    submittedAt: at,
    auditReference: id(54),
    dataClassification: "Internal",
  });
  const scope = {
    kind: "Store",
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
  };
  const base = {
    lifecycleId: id(52),
    familyReference: snapshot.familyReference,
    configurationType: "RECEIPT_TEMPLATE",
    purposeCode: "RECEIPT_ISSUANCE",
    snapshotReference: snapshot.content.versionReference,
    snapshotDigest: snapshot.contentDigest,
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  const review = { ...base, version: 2, state: "InReview", validationEvidenceReference: id(53) },
    approved = { ...review, version: 3, state: "Approved", approvalEvidenceReference: id(55) },
    published = { ...approved, version: 4, state: "Published" };
  const current =
    state === "InReview"
      ? base
      : state === "Approved"
        ? review
        : state === "Published"
          ? approved
          : published;
  const next =
    state === "InReview"
      ? review
      : state === "Approved"
        ? approved
        : state === "Published"
          ? published
          : { ...published, version: 5, state: "Archived" };
  const operation =
    state === "InReview"
      ? "SubmitReview"
      : state === "Approved"
        ? "Approve"
        : state === "Published"
          ? "Publish"
          : "Archive";
  const validation = {
    evidenceReference: id(53),
    snapshotReference: snapshot.content.versionReference,
    snapshotDigest: snapshot.contentDigest,
    scope,
    result: "Pass",
    checkCodes: ["DATA_CONTRACT", "DIGITAL_RENDERER"],
    checkedAt: at,
    validUntil: businessUntil,
  };
  const approval = {
    evidenceReference: id(55),
    reviewLifecycleId: id(52),
    reviewVersion: 2,
    snapshotReference: snapshot.content.versionReference,
    snapshotDigest: snapshot.contentDigest,
    scope,
    decision: "Accepted",
    approvedActorReference: id(56),
    approvedAt: at,
    validUntil: businessUntil,
  };
  const mutation = parseRecordedPublishingMutation({
    operation,
    expectedVersion: current.version,
    idempotencyKey: operation === "SubmitReview" ? id(51) : id(57),
    current,
    next,
    release:
      state === "Published"
        ? {
            releaseId: id(58),
            familyReference: snapshot.familyReference,
            configurationType: "RECEIPT_TEMPLATE",
            purposeCode: "RECEIPT_ISSUANCE",
            snapshotReference: snapshot.content.versionReference,
            snapshotDigest: snapshot.contentDigest,
            scope,
            sequence: 1,
            sourceLifecycleId: id(52),
            kind: "Publish",
            previousReleaseId: null,
            createdAt: at,
          }
        : null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: state === "InReview" || state === "Published" ? validation : null,
    approvalEvidence: state === "Approved" || state === "Published" ? approval : null,
    audit: {
      auditId: state === "InReview" ? id(54) : id(59),
      brandId: snapshot.brandReference,
      storeId: snapshot.storeReference,
      actor: { type: "User", reference: state === "InReview" ? id(50) : id(56) },
      actionCode:
        state === "InReview"
          ? "PUBLISHING_REVIEW_SUBMITTED"
          : state === "Approved"
            ? "PUBLISHING_REVIEW_APPROVED"
            : state === "Published"
              ? "PUBLISHING_RELEASE_PUBLISHED"
              : "PUBLISHING_RELEASE_ARCHIVED",
      targetType: "PublishingLifecycle",
      targetId: id(52),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(51),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    },
  });
  return Object.freeze({
    profile: "DigitalReceiptTemplateEditingReviewV1",
    submission,
    mutation,
    observedAt: at,
    validUntil: until,
  });
}
it("initial server-created Template does not query invented review subject", async () => {
  const f = fixture();
  await f.store.save(f.save());
  await f.finish();
  expect(f.editingReads).toEqual([]);
});
it.each(["InReview", "Approved"] as const)(
  "freezes unexpired actual %s before allocation or Audit",
  async (state) => {
    const initial = fixture();
    const old = await initial.store.save(initial.save());
    await initial.finish();
    const f = fixture(initial.db);
    f.setEditingReview(editingRecord(old, state));
    const next = vi.spyOn(f.options.references, "nextReference");
    // Recreate after capturing the controlled allocator; no replacement of a held source port.
    const owner = createPostgresDigitalReceiptTemplateDraftStore(f.options);
    await expect(owner.save(f.save(21, old))).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_CONFLICT",
    });
    expect(next).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
    expect(initial.db.versions).toHaveLength(1);
  },
);
it.each(["InReview", "Approved"] as const)(
  "permits expired %s successor without mutating original Review or Draft history",
  async (state) => {
    const first = fixture();
    const old = await first.store.save(first.save());
    await first.finish();
    const packet = editingRecord(old, state, "2026-10-05T10:00:00.001Z"),
      f = fixture(first.db);
    f.setNow("2026-10-05T10:00:00.001Z");
    f.setEditingReview(packet);
    const next = await f.store.save(f.save(21, old));
    await f.finish();
    expect(next.snapshot?.revision).toBe(2);
    expect(next.snapshot?.previousVersionReference).toBe(old.snapshot?.content.versionReference);
    expect(first.db.versions).toHaveLength(2);
    expect(packet.submission?.draftRevision).toBe(1);
    expect(packet.mutation?.next.state).toBe(state);
    expect(f.editingReads).toHaveLength(2);
  },
);
it.each(["Published", "Archived"] as const)(
  "permits a new Draft after actual %s without upgrading the old snapshot pin",
  async (state) => {
    const first = fixture();
    const old = await first.store.save(first.save());
    await first.finish();
    const f = fixture(first.db);
    f.setEditingReview(editingRecord(old, state));
    const next = await f.store.save(f.save(21, old));
    await f.finish();
    expect(next.snapshot?.content.versionReference).not.toBe(
      old.snapshot?.content.versionReference,
    );
    expect(next.snapshot?.familyReference).toBe(old.snapshot?.familyReference);
    expect(f.editingReads).toHaveLength(2);
  },
);
it("Committed and Abandoned original replays skip today's Review source entirely", async () => {
  const first = fixture();
  const saved = first.save();
  const receipt = await first.store.save(saved);
  await first.finish();
  const replay = fixture(first.db);
  replay.setEditingReview(editingRecord(receipt));
  expect(await replay.store.save(saved)).toEqual(receipt);
  await replay.finish();
  expect(replay.editingReads).toEqual([]);
  const absent = fixture(),
    command = absent.save(40);
  const abandoned = await absent.store.resolve(absent.resolve(command));
  await absent.finish();
  const late = fixture(absent.db);
  expect(await late.store.save(command)).toEqual(abandoned);
  await late.finish();
  expect(late.editingReads).toEqual([]);
});
it("refuses newly changed Review provenance at the final source recheck and poisons final assertion", async () => {
  const first = fixture();
  const old = await first.store.save(first.save());
  await first.finish();
  const f = fixture(first.db);
  await f.store.save(f.save(21, old));
  f.setEditingReview(editingRecord(old, "Published"));
  await expect(f.finish()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
  expect(() => f.store.assertFinalized(f.tx)).toThrow();
});
it("ignores harmless observation advancement while tightening the held source deadline", async () => {
  const first = fixture();
  const old = await first.store.save(first.save());
  await first.finish();
  const f = fixture(first.db);
  const packet = { ...editingRecord(old, "Published"), validUntil: "2026-10-05T10:00:02.000Z" };
  f.setEditingReview(packet);
  await f.store.save(f.save(21, old));
  f.setNow("2026-10-05T10:00:01.000Z");
  f.setEditingReview({
    ...packet,
    observedAt: "2026-10-05T10:00:01.000Z",
    validUntil: "2026-10-05T10:00:01.500Z",
  });
  expect(await f.finish()).toBe("2026-10-05T10:00:01.500Z");
});
it("rejects getter packets and a missing paired mutation before allocation", async () => {
  const first = fixture();
  const old = await first.store.save(first.save());
  await first.finish();
  const getter = vi.fn(() => editingRecord(old).submission),
    packet = Object.defineProperty({ ...editingRecord(old) }, "submission", {
      enumerable: true,
      get: getter,
    });
  const f = fixture(first.db);
  f.setEditingReview(packet);
  await expect(f.store.save(f.save(21, old))).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const g = fixture(first.db);
  g.setEditingReview({ ...editingRecord(old), mutation: null });
  await expect(g.store.save(g.save(22, old))).rejects.toThrow();
  expect(g.audits).toEqual([]);
});
it("refuses foreign exact review pins and captured editing-source port drift", async () => {
  const first = fixture();
  const old = await first.store.save(first.save());
  await first.finish();
  const packet = editingRecord(old, "Published");
  const f = fixture(first.db);
  f.setEditingReview({
    ...packet,
    submission: packet.submission ? { ...packet.submission, familyReference: id(99) } : null,
  });
  await expect(f.store.save(f.save(21, old))).rejects.toThrow();
  const g = fixture(first.db);
  await g.store.save(g.save(22, old));
  Object.defineProperty(g.options, "readEditingReview", { value: async () => packet });
  await expect(g.finish()).rejects.toThrow();
});
it("rejects expiry reached inside the held review callback without allocating a successor", async () => {
  const first = fixture();
  const old = await first.store.save(first.save());
  await first.finish();
  const f = fixture(first.db);
  Object.defineProperty(f.options, "readEditingReview", {
    value: async () => {
      f.setNow(until);
      return {
        profile: "DigitalReceiptTemplateEditingReviewV1",
        submission: null,
        mutation: null,
        observedAt: at,
        validUntil: until,
      };
    },
  });
  const owner = createPostgresDigitalReceiptTemplateDraftStore(f.options);
  await expect(owner.save(f.save(21, old))).rejects.toThrow();
  expect(f.audits).toEqual([]);
});
