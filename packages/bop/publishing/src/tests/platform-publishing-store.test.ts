import { describe, expect, it } from "vitest";
import {
  canonicalizeRfc8785,
  sha256Hex,
  verifyPlatformAuditChain,
  parsePlatformAuditChainRecord,
  type PlatformAuditChainRecordV1,
} from "@bop/audit";
import {
  createIdentityActor,
  createAuthenticationSession,
  parsePlatformSessionMfa,
  sessionPolicies,
} from "@bop/identity";
import {
  buildPlatformPermissionPolicy,
  parsePlatformPermissionProvisionCommand,
  platformPermissionIntentDigest,
  platformPermissionActions,
  type PlatformPermissionPolicy,
  type PlatformPermissionIdentityObservation,
} from "@bop/permission";
import {
  createPlatformBrandTemplateRevision,
  parsePlatformBrandTemplateSave,
  parsePlatformBrandTemplateReceipt,
  platformBrandTemplateIntentDigest,
  type PlatformBrandTemplateRevision,
  type PlatformBrandTemplateReceipt,
} from "@bop/tenant";
import {
  parsePlatformPublishingRequest,
  parsePlatformPublishingSourceScope,
  parsePlatformPublishingReceipt,
  parsePlatformPublishingOriginal,
  platformPublishingIntentDigest,
  buildPlatformPublishingSource,
  type PlatformPublishingRequest,
  type PlatformPublishingReceipt,
  type PlatformPublishingSource,
} from "../contracts/platform-publishing-source.js";
import {
  createPostgresPlatformPublishingStore,
  type PlatformPublishingStoreOptions,
  type PlatformPublishingTransaction,
} from "../infrastructure/persistence/platform-publishing-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z",
  review = "2026-10-06T13:00:00.000Z",
  expires = "2026-10-06T14:00:00.000Z";
const codec = {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (text: string) => `sha256:${sha256Hex(text)}`,
  },
  hash = (v: unknown) => `sha256:${sha256Hex(canonicalizeRfc8785(v))}`;
function permission(actor: string) {
  const command = parsePlatformPermissionProvisionCommand({
    profile: "PlatformPermissionProvisionV1",
    targetActorReference: actor,
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(800 + Number(actor.slice(-2))),
    expectedHead: null,
    content: {
      roleCode: "PlatformAdministrator",
      effectiveFrom: at,
      effectiveUntil: expires,
      entries: platformPermissionActions.map((action, i) => ({
        evidenceReference: id(700 + i),
        action,
        effect: "Allow",
        effectiveFrom: at,
        effectiveUntil: expires,
      })),
    },
    recordedByReference: id(90),
    approvedByReference: id(91),
    approvalEvidenceReference: id(92),
    reasonCode: "APPROVED_PROVISIONING",
  });
  return buildPlatformPermissionPolicy({
    profile: "PlatformPermissionPolicyV1",
    actorReference: actor,
    purposeCode: command.purposeCode,
    policyReference: id(93),
    revision: 1,
    supersedesPolicyReference: null,
    content: command.content,
    operationReference: command.operationReference,
    intentDigest: platformPermissionIntentDigest(command),
    originalCommand: command,
    recordedByReference: command.recordedByReference,
    approvedByReference: command.approvedByReference,
    approvalEvidenceReference: command.approvalEvidenceReference,
    reasonCode: command.reasonCode,
    auditReference: id(94),
    recordedAt: at,
    classification: "RestrictedSecurity",
  });
}
function identity(actorReference: string): PlatformPermissionIdentityObservation {
  const actor = createIdentityActor({
      actorType: "User",
      actorReference,
      accountKind: "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    session = createAuthenticationSession({
      sessionReference: id(95),
      actor,
      status: "Active",
      policyCode: "Privileged",
      maxActiveSessions: sessionPolicies.Privileged.maxActiveSessions,
      idleTimeoutMinutes: 15,
      absoluteTimeoutMinutes: 480,
      version: 1,
      authenticatedAt: at,
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: "2026-10-06T12:15:00.000Z",
      absoluteExpiresAt: "2026-10-06T20:00:00.000Z",
      rotatedFromSessionReference: null,
      revokedAt: null,
      revocationReason: null,
    });
  return {
    session,
    recentMfa: parsePlatformSessionMfa({
      sessionReference: session.sessionReference,
      actorReference,
      method: "Totp",
      evidenceReference: id(96),
      authorizationTransactionReference: id(97),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-10-06T12:15:00.000Z",
    }),
    observedAt: at,
    validUntil: deadline,
  };
}
/** Controlled SQL transport and Session facts. Real Permission/Tenant/Audit factories,
 * parsers and pure Publishing run here; PostgreSQL locks/rollback are native evidence. */
function fixture() {
  let time = at,
    allocated = 100,
    withdrawn = false,
    auditFailure = false,
    malformedHead = false,
    getterHead = false,
    getterCalls = 0;
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    templates: PlatformBrandTemplateRevision[] = [],
    templateReceipts = new Map<string, PlatformBrandTemplateReceipt>(),
    operations = new Map<string, { record: string; receipt: PlatformPublishingReceipt }>(),
    heads = new Map<
      string,
      { sequence: number; selected: string; release: string | null; active: boolean }
    >(),
    policies = new Map<string, PlatformPermissionPolicy>(),
    auditHeads = new Map<string, { sequence: number; previous: string | null }>(),
    auditRecords: PlatformAuditChainRecordV1[] = [];
  function saveTemplate(actor = id(1)) {
    const prior = templates.at(-1),
      command = parsePlatformBrandTemplateSave({
        profile: "PlatformBrandTemplateSaveV1",
        kind: "Platform",
        actorReference: actor,
        purposeCode: "PLATFORM_BRAND_TEMPLATE",
        operationReference: id(20 + templates.length),
        templateReference: prior?.templateReference ?? null,
        expectedHead: prior
          ? {
              revision: prior.revision,
              templateVersionReference: prior.templateVersionReference,
              sourceDigest: prior.sourceDigest,
            }
          : null,
        content: {
          code: "BRAND_STANDARD",
          name: "Brand standard",
          defaultLocale: "en-CA",
          supportedLocales: ["en-CA"],
          overrideAllowedFieldCodes: ["CONTACT"],
          hardRequirementFieldCodes: ["SECURITY.REAUTH"],
          effectiveFrom: at,
          effectiveUntil: expires,
          reasonCode: "APPROVED_CONTENT",
        },
      }),
      snapshot = createPlatformBrandTemplateRevision(
        {
          profile: "PlatformBrandTemplateRevisionV1",
          templateReference: id(10),
          templateVersionReference: id(11 + templates.length),
          revision: templates.length + 1,
          recordKind: "AuthoredContent",
          content: command.content,
          supersedesVersionReference: prior?.templateVersionReference ?? null,
          authoredByReference: actor,
          operationReference: command.operationReference,
          auditReference: id(30 + templates.length),
          createdAt: at,
          recordedAt: at,
          dataClassification: "ConfigurationMetadata",
        },
        codec,
      ),
      receipt = parsePlatformBrandTemplateReceipt(
        {
          profile: "PlatformBrandTemplateOperationV1",
          kind: "Platform",
          actorReference: actor,
          purposeCode: "PLATFORM_BRAND_TEMPLATE",
          operationReference: command.operationReference,
          intentDigest: platformBrandTemplateIntentDigest(command, codec),
          originalCommand: command,
          outcome: "Committed",
          snapshot,
          auditReference: snapshot.auditReference,
          occurredAt: at,
          dataClassification: "ConfigurationMetadata",
        },
        codec,
      );
    templates.push(snapshot);
    templateReceipts.set(actor + ":" + command.operationReference, receipt);
    return snapshot;
  }
  const first = saveTemplate();
  const receiptRow = (receipt: PlatformPublishingReceipt) => ({
      receipt_text: canonicalizeRfc8785(receipt),
      receipt_digest: hash(receipt),
    }),
    byRecord = (record: string) =>
      [...operations.values()].find((o) => o.record === record)?.receipt ?? null;
  const tx: PlatformPublishingTransaction = {
    async query(sql, values) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')"))
        return { rows: [{ isolation: "read committed" }] };
      if (sql.includes("JOIN bop_permission.platform_permission_policy_revision")) {
        const actor = String(values[0]),
          policy = policies.get(actor) ?? permission(actor);
        policies.set(actor, policy);
        return {
          rows: withdrawn
            ? []
            : [
                {
                  snapshot_text: canonicalizeRfc8785(policy),
                  source_digest: policy.sourceDigest,
                  coherent: true,
                },
              ],
        };
      }
      if (sql.startsWith("SELECT template_id,version_id")) {
        const snapshot = sql.includes("WHERE version_id")
          ? templates.find((t) => t.templateVersionReference === values[0])
          : templates.filter((t) => t.templateReference === values[0]).at(-1);
        return {
          rows: snapshot
            ? [
                {
                  template_id: snapshot.templateReference,
                  version_id: snapshot.templateVersionReference,
                  revision: String(snapshot.revision),
                  code: snapshot.content.code,
                  actor_id: snapshot.authoredByReference,
                  operation_id: snapshot.operationReference,
                  audit_id: snapshot.auditReference,
                  content_digest: snapshot.contentDigest,
                  source_digest: snapshot.sourceDigest,
                  snapshot_json: snapshot,
                  precise: true,
                },
              ]
            : [],
        };
      }
      if (sql.startsWith("SELECT actor_id,purpose_code")) {
        const receipt = templateReceipts.get(String(values[0]) + ":" + String(values[2]));
        return {
          rows: receipt
            ? [
                {
                  actor_id: receipt.actorReference,
                  purpose_code: receipt.purposeCode,
                  operation_id: receipt.operationReference,
                  intent_digest: receipt.intentDigest,
                  receipt_json: receipt,
                  receipt_digest: hash(receipt),
                  precise: true,
                },
              ]
            : [],
        };
      }
      if (sql.startsWith("SELECT receipt_text,receipt_digest FROM bop_publishing")) {
        let matches = [...operations.values()].map((o) => o.receipt);
        if (sql.includes("WHERE actor_id"))
          matches = matches.filter(
            (r) => r.actorReference === values[0] && r.operationReference === values[1],
          );
        else
          matches = matches.filter(
            (r) =>
              r.source !== null &&
              r.source.command.next.familyReference === values[0] &&
              (sql.includes("lifecycle_id=$2")
                ? r.source.command.next.lifecycleId === values[1]
                : sql.includes("sequence=$2")
                  ? r.source.sequence === values[1]
                  : values[1] === null || r.source.sequence < Number(values[1])),
          );
        matches.sort((a, b) => (b.source?.sequence ?? 0) - (a.source?.sequence ?? 0));
        return { rows: matches.slice(0, sql.includes("LIMIT 21") ? 21 : 1).map(receiptRow) };
      }
      if (sql.startsWith("SELECT h.sequence")) {
        if (getterHead) {
          const list: unknown[] = [];
          Object.defineProperty(list, "0", {
            enumerable: true,
            get() {
              getterCalls++;
              return {};
            },
          });
          return { rows: list };
        }
        if (malformedHead) return { rows: [{ wrong: true }] };
        const h = heads.get(String(values[0]));
        return {
          rows: h
            ? [
                {
                  sequence: h.sequence,
                  release_active: h.active,
                  selected_receipt_text: canonicalizeRfc8785(byRecord(h.selected)),
                  selected_receipt_digest: hash(byRecord(h.selected)),
                  release_receipt_text:
                    h.release === null ? null : canonicalizeRfc8785(byRecord(h.release)),
                  release_receipt_digest: h.release === null ? null : hash(byRecord(h.release)),
                },
              ]
            : [],
        };
      }
      if (sql.startsWith("INSERT INTO bop_publishing.platform_template_publishing_operation")) {
        const receipt = parsePlatformPublishingReceipt(JSON.parse(String(values[15])));
        operations.set(receipt.actorReference + ":" + receipt.operationReference, {
          record: String(values[0]),
          receipt,
        });
        return { rows: [{ record_reference: values[0] }] };
      }
      if (sql.includes("platform_template_publishing_head_advance")) {
        const family = String(values[1]),
          record = String(values[2]),
          prior = heads.get(family),
          receipt = byRecord(record);
        if (!receipt?.source || Number(values[3]) !== (prior?.sequence ?? 0))
          return { rows: [{ advanced: false }] };
        heads.set(family, {
          sequence: receipt.source.sequence,
          selected: values[4] ? record : (prior?.selected ?? record),
          release: values[5] ? record : (prior?.release ?? null),
          active: values[6] === true,
        });
        return { rows: [{ advanced: true }] };
      }
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_chain_head")) {
        const actor = String(values[0]);
        if (!auditHeads.has(actor)) auditHeads.set(actor, { sequence: 1, previous: null });
        return { rows: [] };
      }
      if (sql.includes("FROM platform_audit.platform_actor_audit_chain_head")) {
        const h = auditHeads.get(String(values[0]));
        return {
          rows: h
            ? [{ next_sequence: String(h.sequence), previous_hash: h.previous, recorded_at: time }]
            : [],
        };
      }
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record")) {
        if (auditFailure) throw new Error("controlled Audit failure");
        const previous = values[14],
          recordHash = values[15];
        if ((previous !== null && !Buffer.isBuffer(previous)) || !Buffer.isBuffer(recordHash))
          throw new Error("controlled Audit bytes");
        auditRecords.push(
          parsePlatformAuditChainRecord({
            profile: values[12],
            sequence: values[13],
            previousHash: previous === null ? null : previous.toString("hex"),
            recordHash: recordHash.toString("hex"),
            recordedAt: values[16],
            content: {
              auditReference: values[0],
              actorReference: values[1],
              purposeCode: values[2],
              actionCode: values[3],
              targetType: values[4],
              targetReference: values[5],
              operationReference: values[6],
              intentDigest:
                "sha256:" + (Buffer.isBuffer(values[7]) ? values[7].toString("hex") : ""),
              occurredAt: values[8],
              reasonCode: values[9],
              retentionPolicyCode: values[10],
              retentionPolicyVersion: values[11],
            },
          }),
        );
        return { rows: [{ audit_reference: values[0] }] };
      }
      if (sql.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head")) {
        const h = auditHeads.get(String(values[0]));
        if (!h || !Buffer.isBuffer(values[2])) throw new Error("controlled Audit head");
        h.previous = values[2].toString("hex");
        return { rows: [{ next_sequence: String(++h.sequence) }] };
      }
      return { rows: [] };
    },
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  function make(actor = id(1)) {
    guard = undefined;
    final = undefined;
    const options: PlatformPublishingStoreOptions = {
      transaction: tx,
      scope: parsePlatformPublishingSourceScope({
        kind: "Platform",
        actorReference: actor,
        purposeCode: "PLATFORM_BRAND_TEMPLATE",
      }),
      clock: { now: () => time },
      originalObservedAt: at,
      originalValidUntil: deadline,
      currentIdentity: async (actual) => {
        expect(actual).toBe(tx);
        return identity(actor);
      },
      nextReference: () => id(++allocated),
      registerBeforeCommit: async (actual, g, f) => {
        expect(actual).toBe(tx);
        guard = g;
        final = f;
      },
    };
    return { store: createPostgresPlatformPublishingStore(options), options };
  }
  function request(
    operation: PlatformPublishingRequest["operation"],
    op: number,
    previous: PlatformPublishingSource | null = null,
    material = first,
  ) {
    return parsePlatformPublishingRequest({
      profile: "PlatformPublishingRequestV1",
      operation,
      operationReference: id(op),
      templateReference: material.templateReference,
      templateVersionReference: material.templateVersionReference,
      contentDigest: material.contentDigest,
      templateSourceDigest: material.sourceDigest,
      expectedLifecycle: previous
        ? {
            lifecycleReference: previous.command.next.lifecycleId,
            version: previous.command.next.version,
            sourceDigest: previous.sourceDigest,
          }
        : null,
      reviewValidUntil: operation === "SubmitReview" ? review : null,
      reasonCode: "APPROVED_PUBLICATION",
    });
  }
  async function commit(
    operation: PlatformPublishingRequest["operation"],
    op: number,
    prior: PlatformPublishingSource | null = null,
    actor = id(1),
    material = first,
  ) {
    const pair = make(actor),
      receipt = await pair.store.execute(request(operation, op, prior, material));
    await finish(pair.store);
    if (receipt.outcome !== "Committed") throw new Error("fixture source");
    return receipt.source;
  }
  async function finish(store: ReturnType<typeof createPostgresPlatformPublishingStore>) {
    if (!guard || !final) throw new Error("missing guards");
    await guard();
    final();
    store.assertFinalized();
  }
  return {
    tx,
    calls,
    templates,
    operations,
    heads,
    first,
    make,
    request,
    commit,
    finish,
    saveTemplate,
    allocated: () => allocated,
    getterCalls: () => getterCalls,
    withdraw: () => {
      withdrawn = true;
    },
    failAudit: () => {
      auditFailure = true;
    },
    badHead: () => {
      malformedHead = true;
    },
    getterHead: () => {
      getterHead = true;
    },
    setTime: (value: string) => {
      time = value;
    },
    runGuard: async () => {
      if (!guard) throw new Error("missing guard");
      await guard();
    },
    runFinal: () => {
      if (!final) throw new Error("missing final");
      final();
    },
    auditRecords,
  };
}
describe("actual Platform Template publication owner composition", () => {
  it("builds Draft/Submit/independent Approve/Publish from actual saved sources and original validation", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      submitted = await f.commit("SubmitReview", 41, draft),
      approved = await f.commit("Approve", 42, submitted, id(2)),
      published = await f.commit("Publish", 43, approved);
    expect(approved.command.validationEvidence).toEqual(submitted.command.validationEvidence);
    expect(published.command.validationEvidence).toEqual(submitted.command.validationEvidence);
    expect(published.command.approvalEvidence).toEqual(approved.command.approvalEvidence);
    expect(published.command.release?.sequence).toBe(1);
    const p = f.make(id(2)),
      read = await p.store.current({
        templateReference: f.first.templateReference,
        lifecycleReference: null,
      });
    expect(read.currentRelease).toEqual(published);
    await f.finish(p.store);
    expect(f.calls.some((c) => c.sql.includes("platform_brand_template_operation_admit"))).toBe(
      true,
    );
    expect(f.calls.some((c) => c.sql.includes("platform_permission_policy_hold"))).toBe(true);
    expect(
      f.calls.filter((c) =>
        c.sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record"),
      ),
    ).toHaveLength(4);
    expect(
      verifyPlatformAuditChain(f.auditRecords.filter((r) => r.content.actorReference === id(1))),
    ).toBe(true);
    expect(
      verifyPlatformAuditChain(f.auditRecords.filter((r) => r.content.actorReference === id(2))),
    ).toBe(true);
  });
  it("retains old Review through a new Draft and can publish the old lifecycle independently", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      submitted = await f.commit("SubmitReview", 41, draft),
      material = f.saveTemplate(),
      newDraft = await f.commit("CreateDraft", 42, submitted, id(1), material),
      approved = await f.commit("Approve", 43, submitted, id(2)),
      published = await f.commit("Publish", 44, approved);
    const p = f.make(),
      current = await p.store.current({
        templateReference: f.first.templateReference,
        lifecycleReference: null,
      });
    expect(current.current).toEqual(newDraft);
    expect(current.currentRelease).toEqual(published);
    await f.finish(p.store);
    const q = f.make(id(2)),
      old = await q.store.current({
        templateReference: f.first.templateReference,
        lifecycleReference: submitted.command.next.lifecycleId,
      });
    expect(old.current).toEqual(published);
    await f.finish(q.store);
  });
  it("archives eligible current release while preserving exact history and release sequence", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      submitted = await f.commit("SubmitReview", 41, draft),
      approved = await f.commit("Approve", 42, submitted, id(2)),
      published = await f.commit("Publish", 43, approved),
      archived = await f.commit("Archive", 44, published);
    const p = f.make(),
      read = await p.store.current({
        templateReference: f.first.templateReference,
        lifecycleReference: null,
      });
    expect(read.currentRelease).toBeNull();
    await f.finish(p.store);
    const q = f.make(),
      exact = await q.store.exact({
        templateReference: f.first.templateReference,
        sequence: published.sequence,
      });
    expect(exact.source).toEqual(published);
    await f.finish(q.store);
    const nextDraft = await f.commit("CreateDraft", 45, archived),
      nextSubmit = await f.commit("SubmitReview", 46, nextDraft),
      nextApprove = await f.commit("Approve", 47, nextSubmit, id(2)),
      nextPublish = await f.commit("Publish", 48, nextApprove);
    expect(nextPublish.command.release?.sequence).toBe(2);
    expect(nextPublish.command.release?.previousReleaseId).toBe(
      published.command.release?.releaseId,
    );
  });
  it("replays original committed receipt before qualification and allocation", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40);
    f.saveTemplate();
    const n = f.allocated(),
      before = f.calls.length,
      p = f.make(),
      receipt = await p.store.execute(f.request("CreateDraft", 40));
    expect(receipt.source).toEqual(draft);
    await f.finish(p.store);
    expect(f.allocated()).toBe(n);
    expect(
      f.calls.slice(before).some((c) => c.sql.includes("platform_brand_template_operation_admit")),
    ).toBe(false);
  });
  it("persists genuine Abandoned resolution and refuses late writes or changed intent", async () => {
    const f = fixture(),
      req = f.request("CreateDraft", 40),
      scope = parsePlatformPublishingSourceScope({
        kind: "Platform",
        actorReference: id(1),
        purposeCode: "PLATFORM_BRAND_TEMPLATE",
      }),
      intent = platformPublishingIntentDigest(
        parsePlatformPublishingOriginal({
          profile: "PlatformPublishingOriginalV1",
          scope,
          request: req,
        }),
      ),
      p = f.make(),
      receipt = await p.store.resolve({
        profile: "PlatformPublishingResolveV1",
        operationReference: req.operationReference,
        intentDigest: intent,
      });
    expect(receipt.outcome).toBe("Abandoned");
    await f.finish(p.store);
    const n = f.allocated(),
      q = f.make();
    await expect(q.store.execute(req)).rejects.toThrow();
    await expect(f.runGuard()).rejects.toThrow();
    expect(f.allocated()).toBe(n);
    const r = f.make();
    await expect(
      r.store.resolve({
        profile: "PlatformPublishingResolveV1",
        operationReference: req.operationReference,
        intentDigest: "sha256:" + "a".repeat(64),
      }),
    ).rejects.toThrow();
  });
  it("rejects missing/changed immutable content, author reuse, stale CAS and same-op changed intent", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40);
    const n = f.allocated(),
      p = f.make();
    await expect(
      p.store.execute({
        ...f.request("SubmitReview", 41, draft),
        contentDigest: "sha256:" + "a".repeat(64),
      }),
    ).rejects.toThrow();
    const q = f.make(id(2));
    await expect(q.store.execute(f.request("CreateDraft", 42, draft))).rejects.toThrow();
    const r = f.make();
    await expect(
      r.store.execute({
        ...f.request("SubmitReview", 43, draft),
        expectedLifecycle: {
          lifecycleReference: draft.command.next.lifecycleId,
          version: draft.command.next.version,
          sourceDigest: "sha256:" + "b".repeat(64),
        },
      }),
    ).rejects.toThrow();
    const s = f.make();
    await expect(
      s.store.execute({ ...f.request("CreateDraft", 40), reasonCode: "OTHER_REASON" }),
    ).rejects.toThrow();
    expect(f.allocated()).toBe(n);
  });
  it("rejects author/submitter self approval and retains original business deadline", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      submitted = await f.commit("SubmitReview", 41, draft);
    const p = f.make();
    await expect(p.store.execute(f.request("Approve", 42, submitted))).rejects.toThrow();
    const q = f.make(id(2));
    await expect(
      q.store.execute({ ...f.request("Approve", 43, submitted), reviewValidUntil: expires }),
    ).rejects.toThrow();
    expect(f.operations.size).toBe(2);
  });
  it("bounds history and serves real per-lifecycle current packets", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      submitted = await f.commit("SubmitReview", 41, draft);
    const p = f.make(id(2)),
      history = await p.store.history({
        templateReference: f.first.templateReference,
        beforeSequence: null,
      });
    expect(history.items).toEqual([submitted, draft]);
    expect(history.hasMore).toBe(false);
    await f.finish(p.store);
    const q = f.make(),
      empty = await q.store.current({
        templateReference: f.first.templateReference,
        lifecycleReference: id(999),
      });
    expect(empty.current).toBeNull();
    await f.finish(q.store);
  });
  it("refuses changed real Permission before COMMIT and original lease expiry at final seal", async () => {
    const f = fixture(),
      p = f.make();
    await p.store.execute(f.request("CreateDraft", 40));
    f.withdraw();
    await expect(f.runGuard()).rejects.toThrow();
    expect(() => p.store.assertFinalized()).toThrow();
    const g = fixture(),
      q = g.make();
    await q.store.execute(g.request("CreateDraft", 40));
    await g.runGuard();
    g.setTime(deadline);
    expect(() => g.runFinal()).toThrow();
  });
  it("registers rollback guard before writes and poisons caught post-write transport failures", async () => {
    const f = fixture(),
      p = f.make();
    const original = f.tx.query;
    f.tx.query = async function (sql, values) {
      const result = await original.call(f.tx, sql, values);
      if (sql.includes("head_advance")) f.badHead();
      return result;
    };
    const q = f.make();
    await expect(q.store.execute(f.request("CreateDraft", 40))).rejects.toThrow();
    expect(f.operations.size).toBe(1);
    await expect(f.runGuard()).rejects.toThrow();
    expect(() => q.store.assertFinalized()).toThrow();
    expect(() => p.store.assertFinalized()).toThrow();
  });
  it("binds stored source author to the exact immutable Tenant owner even after valid rehash", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      row = [...f.operations.values()][0];
    if (!row) throw new Error("fixture source");
    const original = parsePlatformPublishingOriginal({
        ...draft.originalCommand,
        scope: { kind: "Platform", actorReference: id(3), purposeCode: "PLATFORM_BRAND_TEMPLATE" },
      }),
      intent = platformPublishingIntentDigest(original),
      draftBody = Object.fromEntries(
        Object.entries(draft).filter(([key]) => key !== "sourceDigest"),
      ),
      source = buildPlatformPublishingSource({
        ...draftBody,
        originalCommand: original,
        intentDigest: intent,
        command: {
          ...draft.command,
          currentActorReference: id(3),
          next: { ...draft.command.next, authoredActorReference: id(3) },
        },
      });
    const { sourceDigest, ...body } = source;
    expect(sourceDigest).toBe(source.sourceDigest);
    const forged = buildPlatformPublishingSource(body);
    row.receipt = parsePlatformPublishingReceipt({
      ...row.receipt,
      actorReference: id(3),
      originalCommand: original,
      intentDigest: intent,
      source: forged,
    });
    const p = f.make(id(2));
    await expect(
      p.store.current({ templateReference: f.first.templateReference, lifecycleReference: null }),
    ).rejects.toThrow();
    await expect(f.runGuard()).rejects.toThrow();
  });
  it("allows Archive after business review expiry without renewing the review deadline", async () => {
    const f = fixture(),
      draft = await f.commit("CreateDraft", 40),
      p = f.make(),
      receipt = await p.store.execute({
        ...f.request("SubmitReview", 41, draft),
        reviewValidUntil: "2026-10-06T12:00:00.500Z",
      });
    await f.finish(p.store);
    if (!receipt.source) throw new Error("fixture source");
    const approved = await f.commit("Approve", 42, receipt.source, id(2)),
      published = await f.commit("Publish", 43, approved);
    f.setTime("2026-10-06T12:00:01.000Z");
    const archived = await f.commit("Archive", 44, published);
    expect(archived.command.next.reviewValidUntil).toBe("2026-10-06T12:00:00.500Z");
  });
  it("does not invoke raw SQL row getters", async () => {
    const f = fixture();
    f.getterHead();
    const p = f.make();
    await expect(
      p.store.current({ templateReference: f.first.templateReference, lifecycleReference: null }),
    ).rejects.toThrow();
    expect(f.getterCalls()).toBe(0);
    await expect(f.runGuard()).rejects.toThrow();
  });
  it("rejects actual Audit failure, query drift and concurrent reentry without foreign SQL", async () => {
    const f = fixture();
    f.failAudit();
    const p = f.make();
    await expect(p.store.execute(f.request("CreateDraft", 40))).rejects.toThrow();
    await expect(f.runGuard()).rejects.toThrow();
    const g = fixture(),
      q = g.make();
    await q.store.execute(g.request("CreateDraft", 40));
    let foreign = 0;
    g.tx.query = async () => {
      foreign++;
      return { rows: [] };
    };
    await expect(g.runGuard()).rejects.toThrow();
    expect(foreign).toBe(0);
    const h = fixture(),
      r = h.make(),
      first = r.store.execute(h.request("CreateDraft", 40));
    await expect(r.store.execute(h.request("CreateDraft", 41))).rejects.toThrow();
    await expect(first).rejects.toThrow();
  });
});
