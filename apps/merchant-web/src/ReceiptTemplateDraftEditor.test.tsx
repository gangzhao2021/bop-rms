import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReceiptTemplateDraftEditor,
  saveReceiptTemplateDraft,
  finishReceiptTemplateDraftOriginal,
  submitReceiptTemplateDraft,
  finishReceiptTemplateSubmitOriginal,
  advanceReceiptTemplateLifecycle,
  finishReceiptTemplateLifecycleOriginal,
  receiptTemplateLifecycleAvailable,
} from "./ReceiptTemplateDraftEditor.js";
import {
  createReceiptTemplateDraftClient,
  parseReceiptTemplateDraftFields,
  parseReceiptTemplateDraftSnapshot,
  type ReceiptTemplateDraftCursor,
  type ReceiptTemplateDraftSnapshot,
} from "./receipt-template-draft-client.js";
import type { ReceiptTemplateDraftPendingJournal } from "./receipt-template-draft-pending-journal.js";
import {
  createReceiptTemplateSubmitClient,
  type ReceiptTemplateSubmitCursor,
} from "./receipt-template-submit-client.js";
import type { ReceiptTemplateSubmitPendingJournal } from "./receipt-template-submit-pending-journal.js";
import {
  createReceiptTemplateLifecycleClient,
  type ReceiptTemplateLifecycleCursor,
} from "./receipt-template-lifecycle-client.js";
import type { ReceiptTemplateLifecyclePendingJournal } from "./receipt-template-lifecycle-pending-journal.js";
import { StoreSetupClientError } from "./store-setup-client.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
import { publicationValueDigest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  csrf = "A".repeat(43);
const fields = parseReceiptTemplateDraftFields({
  locale: "fr-CA",
  layoutDefinitionReference: id(5),
  complianceRuleReference: id(6),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
// Genuine browser client parsing/hash, controlled HTTP/journal, no native IAM or Publish evidence.
function fixture() {
  let snapshot: ReceiptTemplateDraftSnapshot | null = null,
    pending: ReceiptTemplateDraftCursor | null = null,
    receipt: unknown;
  const state = { lose: false, deny: false, cleanup: false, changed: false },
    sequence: string[] = [],
    bodies: Record<string, unknown>[] = [];
  const journal: ReceiptTemplateDraftPendingJournal = {
    load: async () => pending,
    reserve: async (c) => {
      pending = c;
      sequence.push("reserve");
    },
    complete: async () => {
      sequence.push("complete");
      if (state.cleanup) throw new StoreSetupClientError("Unavailable");
      pending = null;
    },
  };
  const client = createReceiptTemplateDraftClient(
    vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>;
        bodies.push(body);
        sequence.push(String(body.command));
        if (state.deny) return new Response("{}", { status: 403 });
        if (body.command === "SaveDraft") {
          if (!pending) throw new Error("cursor missing");
          const c = {
            profile: "DigitalReceiptTemplateContentV2",
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            templateReference: id(8),
            versionReference: id(9),
            versionNumber: 1,
            versionCode: "RECEIPT_1",
            ...fields,
            dataContractVersion: 1,
            renderEngineVersion: 1,
            outputProfile: "AccessibleDigitalReceipt",
            requiredFields: [...receiptTemplateArtifactRequiredFields],
            dataClassification: "Internal",
          };
          snapshot = parseReceiptTemplateDraftSnapshot({
            profile: "DigitalReceiptTemplateDraftV2",
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            familyReference: id(10),
            revision: pending.expectedRevision + 1,
            authoredByReference: id(4),
            previousVersionReference: pending.expectedVersionReference,
            content: c,
            contentDigest: await publicationValueDigest(c),
            createdAt: at,
            updatedAt: at,
            dataClassification: "Internal",
          });
          receipt = {
            profile: "DigitalReceiptTemplateDraftReceiptV1",
            ...scope,
            operationReference: pending.operationReference,
            templateReference: pending.templateReference,
            expectedVersionReference: pending.expectedVersionReference,
            expectedRevision: pending.expectedRevision,
            intentDigest: pending.intentDigest,
            outcome: "Committed",
            snapshot,
            auditReference: id(11),
            occurredAt: at,
          };
          if (state.lose) throw new Error("lost reply");
        }
        return response(receipt);
      }
      sequence.push("read");
      const requested = new URL(String(url), "https://synthetic.invalid").searchParams.get(
        "templateReference",
      );
      let value = snapshot;
      if (state.changed && snapshot) {
        const c = { ...snapshot.content, versionReference: id(12) };
        value = parseReceiptTemplateDraftSnapshot({
          ...snapshot,
          revision: 2,
          previousVersionReference: snapshot.content.versionReference,
          content: c,
          contentDigest: await publicationValueDigest(c),
        });
      }
      return response({
        profile: "DigitalReceiptTemplateDraftCurrentV1",
        ...scope,
        templateReference: requested,
        snapshot: requested ? value : null,
        observedAt: at,
        validUntil: "2026-10-05T10:00:05.000Z",
        sourceQualification: "NotEvaluated",
      });
    }),
  );
  return {
    client,
    journal,
    state,
    sequence,
    bodies,
    pending: () => pending,
    current: () =>
      client.load({
        storeReference: scope.storeReference,
        expectedScope: scope,
        templateReference: null,
      }),
  };
}
const response = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const common = (f: ReturnType<typeof fixture>) => ({
  client: f.client,
  journal: f.journal,
  scope,
  csrf,
  signal: new AbortController().signal,
  isCurrent: () => true,
  fields,
  onReserved: () => undefined,
});
it("renders actual Store default locale, 13 mechanical labels, with no opaque ID/editor/Published binding", () => {
  const html = renderToStaticMarkup(
    <ReceiptTemplateDraftEditor scope={scope} csrf={csrf} defaultLocale="fr-CA" />,
  );
  expect(html).toContain('value="fr-CA"');
  expect(html).toContain("Save template draft");
  expect(html).toContain("RefundedTotal");
  expect(html).toContain("No actual order or payment details");
  expect(html).not.toContain(scope.storeReference);
  expect(html).not.toContain("Use saved template");
});
it("reserves before first POST and clears only after reading actual allocated template", async () => {
  const f = fixture(),
    result = await saveReceiptTemplateDraft({ ...common(f), baseline: await f.current() });
  expect(f.sequence).toEqual(["read", "read", "reserve", "SaveDraft", "read", "complete"]);
  expect(f.pending()).toBeNull();
  expect(result.current.templateReference).toBe(id(8));
  expect(f.bodies[0]?.templateReference).toBeNull();
});
it("lost confirmed reply survives for explicit original Resolve without resending editable fields", async () => {
  const f = fixture(),
    baseline = await f.current();
  f.state.lose = true;
  await expect(saveReceiptTemplateDraft({ ...common(f), baseline })).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const cursor = f.pending();
  if (!cursor) throw new Error("fixture pending missing");
  expect(JSON.stringify(cursor)).not.toContain("locale");
  f.state.lose = false;
  await finishReceiptTemplateDraftOriginal({ ...common(f), cursor });
  expect(f.bodies[1]?.command).toBe("ResolveOriginal");
  expect(f.bodies[1]?.operationReference).toBe(cursor.operationReference);
  expect(f.bodies[1]?.fields).toBeUndefined();
  expect(f.pending()).toBeNull();
});
it.each(["deny", "cleanup"] as const)("%s cannot clear durable reservation", async (mode) => {
  const f = fixture(),
    baseline = await f.current();
  f.state[mode] = true;
  await expect(saveReceiptTemplateDraft({ ...common(f), baseline })).rejects.toThrow();
  expect(f.pending()).not.toBeNull();
});
it("scope cancellation blocks reservation and new dispatch", async () => {
  const f = fixture();
  await expect(
    saveReceiptTemplateDraft({ ...common(f), baseline: await f.current(), isCurrent: () => false }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.pending()).toBeNull();
  expect(f.bodies).toHaveLength(0);
});
it("actual current drift refuses Save before reserve or POST", async () => {
  const f = fixture(),
    saved = await saveReceiptTemplateDraft({ ...common(f), baseline: await f.current() });
  f.state.changed = true;
  await expect(
    saveReceiptTemplateDraft({ ...common(f), baseline: saved.current }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(f.bodies).toHaveLength(1);
  expect(f.pending()).toBeNull();
});

async function submitFixture() {
  const draft = fixture();
  const saved = await saveReceiptTemplateDraft({
    ...common(draft),
    baseline: await draft.current(),
  });
  const snapshot = saved.current.snapshot;
  if (!snapshot) throw new Error("saved fixture missing");
  let pending: ReceiptTemplateSubmitCursor | null = null;
  let originalReceipt: unknown;
  let recorded: Record<string, unknown> | null = null;
  const state = { lose: false, deny: false, readFailure: false, cleanup: false };
  const sequence: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const journal: ReceiptTemplateSubmitPendingJournal = {
    load: async () => pending,
    reserve: async (cursor) => {
      pending = cursor;
      sequence.push("reserve");
    },
    complete: async () => {
      sequence.push("complete");
      if (state.cleanup) throw new StoreSetupClientError("Unavailable");
      pending = null;
    },
  };
  const submitClient = createReceiptTemplateSubmitClient(async (url, options) => {
    void url;
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      bodies.push(body);
      sequence.push(String(body.command));
      if (state.deny) return new Response("{}", { status: 403 });
      if (body.command === "SubmitReview") {
        if (!pending) throw new Error("submit reservation missing");
        recorded = {
          profile: "DigitalReceiptTemplateSubmissionV1",
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          templateReference: snapshot.content.templateReference,
          familyReference: snapshot.familyReference,
          versionReference: snapshot.content.versionReference,
          draftRevision: snapshot.revision,
          contentDigest: snapshot.contentDigest,
          authoredByReference: snapshot.authoredByReference,
          submittedByReference: scope.actorReference,
          operationReference: pending.operationReference,
          reviewLifecycleReference: id(30),
          reviewVersion: 2,
          validationEvidenceReference: id(31),
          checkedAt: at,
          validationValidUntil: "2026-10-08T10:00:00.000Z",
          submittedAt: at,
          auditReference: id(32),
          dataClassification: "Internal",
        };
        originalReceipt = {
          profile: "DigitalReceiptTemplateSubmitReceiptV1",
          ...scope,
          operationReference: pending.operationReference,
          templateReference: pending.templateReference,
          expectedVersionReference: pending.expectedVersionReference,
          expectedRevision: pending.expectedRevision,
          intentDigest: pending.intentDigest,
          outcome: "Committed",
          submission: recorded,
          auditReference: id(32),
          occurredAt: at,
        };
        if (state.lose) throw new Error("controlled lost reply");
      }
      return response(originalReceipt);
    }
    sequence.push("review");
    if (state.readFailure) return new Response("{}", { status: 503 });
    return response({
      profile: "DigitalReceiptTemplateReviewCurrentV1",
      ...scope,
      templateReference: snapshot.content.templateReference,
      currentDraft: {
        versionReference: snapshot.content.versionReference,
        revision: snapshot.revision,
        contentDigest: snapshot.contentDigest,
      },
      submission: recorded,
      lifecycle: recorded
        ? {
            lifecycleReference: id(30),
            version: 2,
            state: "InReview",
            latestMutationOperationReference: recorded.operationReference,
            changedAt: at,
            validationEvidenceReference: id(31),
            approvalEvidenceReference: null,
          }
        : null,
      observedAt: at,
      validUntil: "2026-10-05T10:00:05.000Z",
      sourceQualification: "NotEvaluated",
    });
  });
  const input = {
    client: draft.client,
    submitClient,
    journal,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  return { draft, saved, state, sequence, bodies, input, pending: () => pending };
}
it("submits only a saved exact tuple, reserves before dispatch and reads both actual sources before cleanup", async () => {
  const f = await submitFixture();
  const result = await submitReceiptTemplateDraft({
    ...f.input,
    scope,
    baseline: f.saved.current,
    fields,
    onReserved: () => undefined,
  });
  expect(f.sequence).toEqual(["review", "reserve", "SubmitReview", "review", "complete"]);
  expect(result.review.lifecycle?.state).toBe("InReview");
  expect(result.current.snapshot).toEqual(f.saved.current.snapshot);
  expect(f.pending()).toBeNull();
  expect(f.bodies[0]).not.toHaveProperty("validationValidUntil");
});
it("dirty unsaved fields and changed actual Draft refuse submission before allocating a pending operation", async () => {
  const f = await submitFixture();
  await expect(
    submitReceiptTemplateDraft({
      ...f.input,
      scope,
      baseline: f.saved.current,
      fields: { ...fields, locale: "en-CA" },
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  f.draft.state.changed = true;
  await expect(
    submitReceiptTemplateDraft({
      ...f.input,
      scope,
      baseline: f.saved.current,
      fields,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(f.pending()).toBeNull();
  expect(f.bodies).toHaveLength(0);
});
it("lost Submit reply reloads identity-only cursor, preserves denied recovery, then resolves exact original", async () => {
  const f = await submitFixture();
  f.state.lose = true;
  await expect(
    submitReceiptTemplateDraft({
      ...f.input,
      scope,
      baseline: f.saved.current,
      fields,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  if (!cursor) throw new Error("pending missing");
  expect(JSON.stringify(cursor)).not.toContain("locale");
  expect(JSON.stringify(cursor)).not.toContain(csrf);
  f.state.lose = false;
  f.state.deny = true;
  await expect(finishReceiptTemplateSubmitOriginal({ ...f.input, cursor })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(f.pending()).toEqual(cursor);
  f.state.deny = false;
  await finishReceiptTemplateSubmitOriginal({ ...f.input, cursor });
  expect(f.bodies[2]?.operationReference).toBe(cursor.operationReference);
  expect(f.bodies[2]?.command).toBe("ResolveOriginal");
  expect(f.pending()).toBeNull();
});
it.each(["readFailure", "cleanup"] as const)(
  "confirmed submission retains its original when %s prevents fresh completion",
  async (mode) => {
    const f = await submitFixture();
    await expect(
      submitReceiptTemplateDraft({
        ...f.input,
        scope,
        baseline: f.saved.current,
        fields,
        onReserved: () => {
          f.state[mode] = true;
        },
      }),
    ).rejects.toThrow();
    expect(f.pending()).not.toBeNull();
  },
);
it("scope epoch change after reserve keeps durable marker and suppresses Submit dispatch", async () => {
  const f = await submitFixture();
  let current = true;
  await expect(
    submitReceiptTemplateDraft({
      ...f.input,
      isCurrent: () => current,
      scope,
      baseline: f.saved.current,
      fields,
      onReserved: () => {
        current = false;
      },
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.pending()).not.toBeNull();
  expect(f.bodies).toHaveLength(0);
});
it("a required fresh review read happens before clearing an original Draft reservation", async () => {
  const f = fixture();
  await expect(
    saveReceiptTemplateDraft({
      ...common(f),
      baseline: await f.current(),
      beforeComplete: async () => {
        throw new StoreSetupClientError("Unavailable");
      },
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.pending()).not.toBeNull();
  expect(f.sequence).not.toContain("complete");
});

it("same-page retry sends the retained exact original after a lost reply", async () => {
  const f = await submitFixture();
  let prepared: Parameters<typeof finishReceiptTemplateSubmitOriginal>[0]["prepared"];
  f.state.lose = true;
  await expect(
    submitReceiptTemplateDraft({
      ...f.input,
      scope,
      baseline: f.saved.current,
      fields,
      onReserved: (value) => {
        prepared = value;
      },
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  if (!cursor || !prepared) throw new Error("retained original missing");
  f.state.lose = false;
  await finishReceiptTemplateSubmitOriginal({ ...f.input, cursor, prepared });
  expect(f.bodies[1]).toEqual(f.bodies[0]);
  expect(f.pending()).toBeNull();
});

async function lifecycleFixture(initialState: "InReview" | "Approved" = "InReview") {
  const f = fixture(),
    saved = await saveReceiptTemplateDraft({ ...common(f), baseline: await f.current() }),
    snapshot = saved.current.snapshot;
  if (!snapshot) throw new Error("saved snapshot missing");
  const selectedScope = { ...scope, actorReference: id(40) };
  let state: "InReview" | "Approved" | "Published" = initialState,
    headOperation = initialState === "InReview" ? id(20) : id(41),
    pending: ReceiptTemplateLifecycleCursor | null = null,
    terminal: unknown;
  const controls = {
    lose: false,
    deny: false,
    cleanup: false,
    readFailure: false,
    headDrift: false,
  };
  const bodies: unknown[] = [],
    order: string[] = [];
  const current = { ...saved.current, ...selectedScope };
  const submission = {
    profile: "DigitalReceiptTemplateSubmissionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    templateReference: snapshot.content.templateReference,
    familyReference: snapshot.familyReference,
    versionReference: snapshot.content.versionReference,
    draftRevision: snapshot.revision,
    contentDigest: snapshot.contentDigest,
    authoredByReference: scope.actorReference,
    submittedByReference: id(6),
    operationReference: id(20),
    reviewLifecycleReference: id(30),
    reviewVersion: 2,
    validationEvidenceReference: id(31),
    checkedAt: at,
    validationValidUntil: "2026-10-05T11:00:00.000Z",
    submittedAt: at,
    auditReference: id(32),
    dataClassification: "Internal",
  };
  const reviewValue = () => ({
    profile: "DigitalReceiptTemplateReviewCurrentV1",
    ...selectedScope,
    templateReference: snapshot.content.templateReference,
    currentDraft: {
      versionReference: snapshot.content.versionReference,
      revision: snapshot.revision,
      contentDigest: snapshot.contentDigest,
    },
    submission,
    lifecycle: {
      lifecycleReference: id(30),
      version: state === "InReview" ? 2 : state === "Approved" ? 3 : 4,
      state,
      latestMutationOperationReference: headOperation,
      changedAt: at,
      validationEvidenceReference: id(31),
      approvalEvidenceReference: state === "InReview" ? null : id(42),
    },
    observedAt: at,
    validUntil: "2026-10-05T10:00:05.000Z",
    sourceQualification: "NotEvaluated",
  });
  const client = createReceiptTemplateDraftClient(async () => {
    order.push("draft");
    return response(current);
  });
  const submitClient = createReceiptTemplateSubmitClient(async () => {
    order.push("review");
    if (controls.readFailure) return new Response("{}", { status: 503 });
    const value = reviewValue();
    return response(
      controls.headDrift
        ? {
            ...value,
            lifecycle: {
              ...value.lifecycle,
              state: "Approved",
              version: 3,
              approvalEvidenceReference: id(42),
              latestMutationOperationReference: id(99),
            },
          }
        : value,
    );
  });
  const lifecycleClient = createReceiptTemplateLifecycleClient(async (url, options) => {
    void url;
    const body = JSON.parse(String(options?.body));
    bodies.push(body);
    order.push(body.command);
    if (controls.deny) return new Response("{}", { status: 403 });
    if (body.command !== "ResolveOriginal") {
      if (!pending) throw new Error("reserved original missing");
      const c = snapshot.content,
        published =
          body.command === "Publish"
            ? {
                templateReference: c.templateReference,
                versionReference: c.versionReference,
                versionNumber: c.versionNumber,
                versionCode: c.versionCode,
                brandReference: c.brandReference,
                storeReference: c.storeReference,
                locale: c.locale,
                dataContractVersion: 1,
                renderEngineVersion: 1,
                outputProfile: "AccessibleDigitalReceipt",
                layoutDefinitionReference: c.layoutDefinitionReference,
                complianceRuleReference: c.complianceRuleReference,
                requiredFields: c.requiredFields,
                publicationReference: id(45),
                publishedAt: at,
                effectiveFrom: at,
                effectiveUntil: null,
              }
            : null;
      terminal = {
        profile: "DigitalReceiptTemplateLifecycleReceiptV1",
        ...selectedScope,
        action: pending.action,
        operationReference: pending.operationReference,
        templateReference: pending.templateReference,
        expectedVersionReference: pending.expectedVersionReference,
        expectedRevision: pending.expectedRevision,
        reviewLifecycleReference: pending.reviewLifecycleReference,
        expectedReviewVersion: pending.expectedReviewVersion,
        expectedReviewOperationReference: pending.expectedReviewOperationReference,
        intentDigest: pending.intentDigest,
        outcome: "Committed",
        result: {
          lifecycleReference: id(30),
          lifecycleVersion: pending.expectedReviewVersion + 1,
          state: body.command === "Approve" ? "Approved" : "Published",
          mutationOperationReference: pending.operationReference,
          changedAt: at,
          approvalEvidenceReference: id(42),
          approvedByReference: selectedScope.actorReference,
          approvedAt: at,
          approvalValidUntil: "2026-10-05T10:30:00.000Z",
          publishedVersion: published,
        },
        auditReference: id(46),
        occurredAt: at,
      };
      state = body.command === "Approve" ? "Approved" : "Published";
      headOperation = pending.operationReference;
      if (controls.lose) throw new Error("controlled lost reply");
    }
    return response(terminal);
  });
  const journal: ReceiptTemplateLifecyclePendingJournal = {
    load: async () => pending,
    reserve: async (value) => {
      order.push("reserve");
      pending = value;
    },
    complete: async (cursor, receipt, fresh, published) => {
      expect(cursor).toEqual(pending);
      expect(fresh.currentDraft.versionReference).toBe(snapshot.content.versionReference);
      expect(published).toBeNull();
      expect(receipt.outcome).toBe("Committed");
      order.push("complete");
      if (controls.cleanup) throw new StoreSetupClientError("Unavailable");
      pending = null;
      return { historical: false };
    },
  };
  const input = {
    client,
    submitClient,
    lifecycleClient,
    journal,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  return {
    input,
    current,
    scope: selectedScope,
    review: await submitClient.load({
      storeReference: scope.storeReference,
      templateReference: snapshot.content.templateReference,
      expectedScope: selectedScope,
      csrf,
    }),
    controls,
    bodies,
    order,
    pending: () => pending,
  };
}
it("offers independent approval only for exact submitted saved version and preserves actual historical author", async () => {
  const f = await lifecycleFixture();
  expect(
    receiptTemplateLifecycleAvailable(f.scope, f.current, f.review, "Approve", Date.parse(at)),
  ).toBe(true);
  expect(
    receiptTemplateLifecycleAvailable(scope, f.current, f.review, "Approve", Date.parse(at)),
  ).toBe(false);
  expect(
    receiptTemplateLifecycleAvailable(
      { ...f.scope, actorReference: id(6) },
      f.current,
      f.review,
      "Approve",
      Date.parse(at),
    ),
  ).toBe(false);
  expect(
    receiptTemplateLifecycleAvailable(f.scope, f.current, f.review, "Publish", Date.parse(at)),
  ).toBe(false);
  expect(
    receiptTemplateLifecycleAvailable(
      f.scope,
      f.current,
      f.review,
      "Approve",
      Date.parse("2026-10-05T11:00:00.000Z"),
    ),
  ).toBe(false);
});
it("reserves actual approval before POST and clears after separate true Draft and Review refresh", async () => {
  const f = await lifecycleFixture();
  f.order.length = 0;
  const result = await advanceReceiptTemplateLifecycle({
    ...f.input,
    scope: f.scope,
    baseline: f.current,
    review: f.review,
    fields,
    action: "Approve",
    onReserved: () => undefined,
  });
  expect(result.receipt.result?.state).toBe("Approved");
  expect(f.order).toEqual(["draft", "review", "reserve", "Approve", "draft", "review", "complete"]);
  expect(f.pending()).toBeNull();
});
it("publication retains immutable Published metadata separately from fresh actual review", async () => {
  const f = await lifecycleFixture("Approved");
  const r = await advanceReceiptTemplateLifecycle({
    ...f.input,
    scope: f.scope,
    baseline: f.current,
    review: f.review,
    fields,
    action: "Publish",
    onReserved: () => undefined,
  });
  expect(r.receipt.result?.publishedVersion?.versionCode).toBe("RECEIPT_1");
  expect(r.review.lifecycle?.state).toBe("Published");
  expect(r.receipt.result?.state).toBe("Published");
});
it("lost approval retains identity-only reload cursor; denied original resolve cannot clear it", async () => {
  const f = await lifecycleFixture();
  f.controls.lose = true;
  await expect(
    advanceReceiptTemplateLifecycle({
      ...f.input,
      scope: f.scope,
      baseline: f.current,
      review: f.review,
      fields,
      action: "Approve",
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  if (!cursor) throw new Error("pending missing");
  expect(JSON.stringify(cursor)).not.toContain("locale");
  f.controls.lose = false;
  f.controls.deny = true;
  await expect(
    finishReceiptTemplateLifecycleOriginal({ ...f.input, cursor }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(f.pending()).toEqual(cursor);
  f.controls.deny = false;
  await finishReceiptTemplateLifecycleOriginal({ ...f.input, cursor });
  expect(f.pending()).toBeNull();
});
it.each(["cleanup", "readFailure"] as const)(
  "lifecycle %s retains terminal original until fresh read and CAS succeed",
  async (mode) => {
    const f = await lifecycleFixture();
    await expect(
      advanceReceiptTemplateLifecycle({
        ...f.input,
        scope: f.scope,
        baseline: f.current,
        review: f.review,
        fields,
        action: "Approve",
        onReserved: () => {
          f.controls[mode] = true;
        },
      }),
    ).rejects.toThrow();
    expect(f.pending()).not.toBeNull();
  },
);
it("changed review head and dirty fields block a new lifecycle intent before reservation", async () => {
  const f = await lifecycleFixture();
  await expect(
    advanceReceiptTemplateLifecycle({
      ...f.input,
      scope: f.scope,
      baseline: f.current,
      review: f.review,
      fields: { ...fields, locale: "en-CA" },
      action: "Approve",
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  f.controls.headDrift = true;
  await expect(
    advanceReceiptTemplateLifecycle({
      ...f.input,
      scope: f.scope,
      baseline: f.current,
      review: f.review,
      fields,
      action: "Approve",
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(f.pending()).toBeNull();
  expect(f.bodies).toHaveLength(0);
});

it("exact retained lifecycle retry does not regenerate operation or head pins", async () => {
  const f = await lifecycleFixture();
  let prepared: Parameters<typeof finishReceiptTemplateLifecycleOriginal>[0]["prepared"];
  f.controls.lose = true;
  await expect(
    advanceReceiptTemplateLifecycle({
      ...f.input,
      scope: f.scope,
      baseline: f.current,
      review: f.review,
      fields,
      action: "Approve",
      onReserved: (p) => {
        prepared = p;
      },
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  if (!cursor || !prepared) throw new Error("retained command missing");
  f.controls.lose = false;
  await finishReceiptTemplateLifecycleOriginal({ ...f.input, cursor, prepared });
  expect(f.bodies[1]).toEqual(f.bodies[0]);
  expect(f.pending()).toBeNull();
});
it("scope change after lifecycle reserve suppresses dispatch while retaining the original marker", async () => {
  const f = await lifecycleFixture();
  let active = true;
  await expect(
    advanceReceiptTemplateLifecycle({
      ...f.input,
      isCurrent: () => active,
      scope: f.scope,
      baseline: f.current,
      review: f.review,
      fields,
      action: "Approve",
      onReserved: () => {
        active = false;
      },
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.pending()).not.toBeNull();
  expect(f.bodies).toHaveLength(0);
});
