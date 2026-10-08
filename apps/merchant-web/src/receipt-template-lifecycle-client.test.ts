// Production browser contract over controlled HTTP; not native IAM or publication evidence.
import { expect, it, vi } from "vitest";
import {
  createReceiptTemplateLifecycleClient,
  parseReceiptTemplateLifecycleCursor,
  validateReceiptTemplateLifecycleReceipt,
  type PreparedReceiptTemplateLifecycle,
} from "./receipt-template-lifecycle-client.js";
import {
  canonicalPublicationValue,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  csrf = "A".repeat(43),
  at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T11:00:00.000Z";
const input = (action: "Approve" | "Publish" = "Approve") => ({
  expectedScope: scope,
  action,
  operationReference: id(5),
  templateReference: id(6),
  expectedVersionReference: id(7),
  expectedRevision: 2,
  reviewLifecycleReference: id(8),
  expectedReviewVersion: action === "Approve" ? 2 : 3,
  expectedReviewOperationReference: id(9),
});
function receipt(p: PreparedReceiptTemplateLifecycle, abandoned = false) {
  const { profile: _profile, purposeCode: _purpose, ...pins } = p.command;
  void _profile;
  void _purpose;
  return {
    profile: "DigitalReceiptTemplateLifecycleReceiptV1",
    ...pins,
    intentDigest: p.intentDigest,
    outcome: abandoned ? "Abandoned" : "Committed",
    result: abandoned
      ? null
      : {
          lifecycleReference: id(8),
          lifecycleVersion: p.command.expectedReviewVersion + 1,
          state: p.command.action === "Approve" ? "Approved" : "Published",
          mutationOperationReference: id(5),
          changedAt: at,
          approvalEvidenceReference: id(10),
          approvedByReference: id(4),
          approvedAt: at,
          approvalValidUntil: until,
          publishedVersion:
            p.command.action === "Approve"
              ? null
              : {
                  templateReference: id(6),
                  versionReference: id(7),
                  versionNumber: 1,
                  versionCode: "RECEIPT_1",
                  brandReference: id(2),
                  storeReference: id(3),
                  locale: "en-CA",
                  dataContractVersion: 1,
                  renderEngineVersion: 1,
                  outputProfile: "AccessibleDigitalReceipt",
                  layoutDefinitionReference: id(11),
                  complianceRuleReference: id(12),
                  requiredFields: [...receiptTemplateArtifactRequiredFields],
                  publicationReference: id(13),
                  publishedAt: at,
                  effectiveFrom: at,
                  effectiveUntil: null,
                },
        },
    auditReference: id(14),
    occurredAt: at,
  };
}
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
it.each(["Approve", "Publish"] as const)(
  "prepares full immutable %s intent and emits only exact eight browser fields",
  async (action) => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!p) throw new Error("fixture not prepared");
      expect(JSON.parse(String(init?.body))).toEqual({
        command: action,
        operationReference: id(5),
        templateReference: id(6),
        expectedVersionReference: id(7),
        expectedRevision: 2,
        reviewLifecycleReference: id(8),
        expectedReviewVersion: action === "Approve" ? 2 : 3,
        expectedReviewOperationReference: id(9),
      });
      expect(Object.keys(JSON.parse(String(init?.body)))).toHaveLength(8);
      expect(init?.credentials).toBe("same-origin");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-BOP-CSRF")).toBe(csrf);
      expect(
        JSON.parse(
          atob(
            String(headers.get("X-BOP-Store-Setup-Scope")).replace(/-/gu, "+").replace(/_/gu, "/"),
          ),
        ),
      ).toEqual(scope);
      return response(receipt(p));
    });
    const c = createReceiptTemplateLifecycleClient(fetcher);
    const p = await c.prepare(input(action));
    expect(Object.keys(p.command)).toHaveLength(14);
    expect(p.intentDigest).toBe(await publicationValueDigest(p.command));
    const r = await c.execute(p, { csrf });
    expect(r.action).toBe(action);
    expect(r.result?.state).toBe(action === "Approve" ? "Approved" : "Published");
    expect(Object.isFrozen(r.result)).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/store-setup/receipt-template-lifecycle");
  },
);
it("resolves payload-free original ten fields and parses terminal Abandoned without inferring an approval", async () => {
  const prepare = createReceiptTemplateLifecycleClient();
  const p = await prepare.prepare(input());
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      command: "ResolveOriginal",
      action: "Approve",
      operationReference: id(5),
      templateReference: id(6),
      expectedVersionReference: id(7),
      expectedRevision: 2,
      reviewLifecycleReference: id(8),
      expectedReviewVersion: 2,
      expectedReviewOperationReference: id(9),
      intentDigest: p.intentDigest,
    });
    expect(Object.keys(body)).toHaveLength(10);
    return response(receipt(p, true));
  });
  const c = createReceiptTemplateLifecycleClient(fetcher);
  expect((await c.resolve(p.cursor, { csrf })).result).toBeNull();
});
it("keeps historical original business expiry and copies actual published envelope without claiming current readiness", async () => {
  const c = createReceiptTemplateLifecycleClient(),
    p = await c.prepare(input("Publish")),
    raw = receipt(p),
    r = await validateReceiptTemplateLifecycleReceipt(raw, p.cursor);
  expect(r.result?.approvalValidUntil).toBe(until);
  expect(Object.keys(r.result?.publishedVersion ?? {})).toHaveLength(17);
  expect(Object.isFrozen(r.result?.publishedVersion?.requiredFields)).toBe(true);
  expect(r.result?.publishedVersion).not.toBe(raw.result?.publishedVersion);
  expect("sourceQualification" in r).toBe(false);
});
it.each([
  [403, "Denied"],
  [409, "Conflict"],
  [400, "Invalid"],
  [503, "OutcomeUnknown"],
] as const)(
  "retains finite %s response classification without receipt success",
  async (status, code) => {
    const c = createReceiptTemplateLifecycleClient(
        vi.fn(async () => response({ secret: "must not echo" }, status)),
      ),
      p = await c.prepare(input());
    await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code });
  },
);
it("treats a lost response and HTTP200 nonterminal/malformed packet as unknown and never auto-retries", async () => {
  const missing = vi.fn(async () => {
      throw new Error("controlled network lost");
    }),
    c = createReceiptTemplateLifecycleClient(missing),
    p = await c.prepare(input());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(missing).toHaveBeenCalledTimes(1);
  const fake = createReceiptTemplateLifecycleClient(
    vi.fn(async () => response({ status: "Published" })),
  );
  await expect(fake.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("rejects malformed original digest, extra payload and getters before dispatch", async () => {
  const fetcher = vi.fn(async () => response({})),
    c = createReceiptTemplateLifecycleClient(fetcher),
    p = await c.prepare(input());
  await expect(
    c.resolve({ ...p.cursor, intentDigest: "sha256:" + "f".repeat(64) }, { csrf }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(() =>
    parseReceiptTemplateLifecycleCursor({ ...p.cursor, approvalEvidence: {} }),
  ).toThrow();
  const getter = vi.fn(() => id(7)),
    v = input();
  Object.defineProperty(v, "expectedVersionReference", { enumerable: true, get: getter });
  await expect(c.prepare(v)).rejects.toMatchObject({ code: "Invalid" });
  expect(getter).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["actorReference", "brandReference", "storeReference", "tenantReference"])(
  "refuses foreign receipt %s",
  async (field) => {
    const c = createReceiptTemplateLifecycleClient(),
      p = await c.prepare(input());
    await expect(
      validateReceiptTemplateLifecycleReceipt({ ...receipt(p), [field]: id(99) }, p.cursor),
    ).rejects.toMatchObject({ code: "ScopeChanged" });
  },
);
it("checks all original head/CAS pins and result ownership rather than trusting HTTP200", async () => {
  const c = createReceiptTemplateLifecycleClient(),
    p = await c.prepare(input());
  for (const change of [
    { expectedRevision: 3 },
    { expectedReviewVersion: 3 },
    { expectedReviewOperationReference: id(40) },
    { operationReference: id(40) },
    { action: "Publish" },
  ])
    await expect(
      validateReceiptTemplateLifecycleReceipt({ ...receipt(p), ...change }, p.cursor),
    ).rejects.toMatchObject({ code: "Invalid" });
  const raw = receipt(p);
  if (!raw.result) throw new Error("fixture result");
  await expect(
    validateReceiptTemplateLifecycleReceipt(
      { ...raw, result: { ...raw.result, approvedByReference: id(40) } },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("refuses published scope/version/time drift and accessor-bearing field arrays without executing a getter", async () => {
  const c = createReceiptTemplateLifecycleClient(),
    p = await c.prepare(input("Publish")),
    raw = receipt(p);
  if (!raw.result?.publishedVersion) throw new Error("fixture version");
  for (const change of [
    { versionReference: id(99) },
    { publishedAt: "2026-10-05T10:00:00.001Z" },
    { effectiveUntil: at },
    { outputProfile: "HTML" },
  ])
    await expect(
      validateReceiptTemplateLifecycleReceipt(
        {
          ...raw,
          result: {
            ...raw.result,
            publishedVersion: { ...raw.result.publishedVersion, ...change },
          },
        },
        p.cursor,
      ),
    ).rejects.toMatchObject({ code: "Invalid" });
  const getter = vi.fn(() => "Issuer");
  Object.defineProperty(raw.result.publishedVersion.requiredFields, "0", {
    enumerable: true,
    get: getter,
  });
  await expect(validateReceiptTemplateLifecycleReceipt(raw, p.cursor)).rejects.toMatchObject({
    code: "Invalid",
  });
  expect(getter).not.toHaveBeenCalled();
});
it("aborting a transmitted POST is unknown while an already aborted request performs no network call", async () => {
  const controller = new AbortController(),
    fetcher = vi.fn(async () => {
      controller.abort();
      return response({});
    }),
    c = createReceiptTemplateLifecycleClient(fetcher),
    p = await c.prepare(input());
  await expect(c.execute(p, { csrf, signal: controller.signal })).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const no = vi.fn(async () => response({})),
    other = createReceiptTemplateLifecycleClient(no);
  await expect(other.execute(p, { csrf, signal: controller.signal })).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(no).not.toHaveBeenCalled();
});
it("rejects late old-scope response after a new scoped command supersedes its epoch", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  let started: (() => void) | undefined;
  // The old request must be in flight before the newer one starts (not merely one tick later).
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  const c = createReceiptTemplateLifecycleClient(
    vi.fn(async () => {
      if (first) {
        first = false;
        started?.();
        await held;
        if (!old) throw new Error("fixture original");
        return response(receipt(old));
      }
      if (!newer) throw new Error("fixture newer");
      return response(receipt(newer, true));
    }),
  );
  const old = await c.prepare(input());
  const newer = await c.prepare({
    ...input(),
    expectedScope: { ...scope, actorReference: id(80) },
    operationReference: id(81),
  });
  const pending = c.execute(old, { csrf });
  await inFlight;
  await c.execute(newer, { csrf });
  if (!release) throw new Error("fixture release");
  release();
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("enforces bounded response streams and immutable prepared canonical bytes", async () => {
  const source = input(),
    c = createReceiptTemplateLifecycleClient(vi.fn(async () => response("x".repeat(32769)))),
    p = await c.prepare(source),
    before = canonicalPublicationValue(p.command);
  source.expectedRevision = 9;
  expect(canonicalPublicationValue(p.command)).toBe(before);
  expect(Object.isFrozen(p.command)).toBe(true);
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
