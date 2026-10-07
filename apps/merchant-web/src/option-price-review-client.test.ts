import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Test-only owning parser verifies intent fixtures without browser server imports.
import { parsePublishingOptionPriceReviewOperation } from "../../../packages/bop/publishing/src/index.js";
import {
  createOptionPriceReviewClient,
  parseOptionPriceReviewCommand,
  OptionPriceReviewClientError,
} from "./option-price-review-client.js";
const id = (n: number) => "01902421-7990-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  csrf = "A".repeat(43),
  hash = "sha256:" + "a".repeat(64);
const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  context = {
    productReference: id(30),
    expectedProductAggregateVersion: 2,
    bindingReference: id(22),
    optionReference: id(23),
  };
function command(action: "SubmitReview" | "Approve" = "SubmitReview") {
  return {
    action,
    operationReference: id(20),
    ruleReference: id(21),
    draftVersionReference: id(24),
    draftSnapshotDigest: hash,
    expectedAggregateVersion: 1,
    validationValidUntil: "2026-10-05T12:30:00.000Z",
    approvalValidUntil: action === "Approve" ? "2026-10-05T12:20:00.000Z" : null,
    expectedLifecycle:
      action === "Approve"
        ? {
            lifecycleReference: id(40),
            version: 2,
            state: "InReview",
            latestMutationOperationReference: id(41),
          }
        : null,
  };
}
function receipt(action: "SubmitReview" | "Approve" = "SubmitReview") {
  return {
    profile: "MerchantOptionPriceReviewResultV1",
    action,
    operationReference: id(20),
    ...scope,
    outcome: "Committed",
    occurredAt: at,
    observedAt: at,
    validUntil: until,
  };
}
function current() {
  return {
    profile: "MerchantOptionPriceReviewCurrentV1",
    ...scope,
    ruleReference: id(21),
    aggregateVersion: 1,
    draftVersionReference: id(24),
    draftSnapshotDigest: hash,
    draftAuthorActorReference: id(4),
    policy: {
      familyReference: id(50),
      policyReference: id(51),
      policyVersion: 1,
      approvalPolicy: "Required",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      currentPublicationReference: id(52),
    },
    review: {
      outcome: "Recorded",
      lifecycle: {
        lifecycleReference: id(40),
        version: 2,
        state: "InReview",
        latestMutationOperationReference: id(41),
      },
      validationValidUntil: "2026-10-05T11:30:00.000Z",
      approvalValidUntil: null,
      submittedActorReference: id(4),
      approvedActorReference: null,
      sourceAuthority: "RecordedHistory",
      qualification: "NotEvaluated",
    },
    observedAt: at,
    validUntil: until,
  };
}
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const fetcher = (v: unknown, status = 200) => vi.fn<typeof fetch>(async () => response(v, status));
const prepare = (f: typeof fetch, action: "SubmitReview" | "Approve" = "SubmitReview") =>
  createOptionPriceReviewClient(f).prepare({
    command: command(action),
    context,
    expectedScope: scope,
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
it.each(["SubmitReview", "Approve"] as const)(
  "retains exact public owning %s intent and receives only original compact terminal",
  async (action) => {
    const c = command(action),
      f = fetcher(receipt(action));
    expect(
      parsePublishingOptionPriceReviewOperation({
        profile: "PublishingOptionPriceReviewOperationV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        actorReference: scope.actorReference,
        selectedStoreReference: scope.storeReference,
        reasonCode: "AUTHORIZED_OPERATION",
        ...c,
      }),
    ).toBeDefined();
    const p = createOptionPriceReviewClient(f).prepare({
      command: c,
      context: { ...context },
      expectedScope: scope,
    });
    c.draftSnapshotDigest = "sha256:" + "b".repeat(64);
    const result = await p.execute({ csrf });
    expect(result.outcome).toBe("Committed");
    expect(p.pending).toBe(false);
    await p.execute({ csrf });
    expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
      command: command(action),
      context,
    });
    expect(f.mock.calls[0]?.[0]).toBe("/merchant/pricing/option-prices/review/command");
    expect(Object.isFrozen(p.command)).toBe(true);
    expect(f.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    const headers = new Headers(f.mock.calls[0]?.[1]?.headers);
    expect(JSON.parse(atob(headers.get("X-BOP-Catalog-Scope") ?? ""))).toEqual({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    });
  },
);
it("reads actual current governing policy and preserves expired historical review without declaring qualification", async () => {
  const f = fetcher(current()),
    result = await createOptionPriceReviewClient(f).query({
      ruleReference: id(21),
      context,
      expectedScope: scope,
      csrf,
    });
  expect(result.policy.approvalPolicy).toBe("Required");
  expect(result.review).toMatchObject({
    outcome: "Recorded",
    validationValidUntil: "2026-10-05T11:30:00.000Z",
    qualification: "NotEvaluated",
  });
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/pricing/option-prices/review/current");
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
    ruleReference: id(21),
    context,
  });
});
it("supports genuine NotRequired policy and explicit absence without manufacturing a waived approval", async () => {
  const v = current();
  v.policy.approvalPolicy = "NotRequired";
  const result = await createOptionPriceReviewClient(
    fetcher({ ...v, review: { outcome: "Absent" } }),
  ).query({ ruleReference: id(21), context, expectedScope: scope, csrf });
  expect(result.policy.approvalPolicy).toBe("NotRequired");
  expect(result.review).toEqual({ outcome: "Absent" });
});
it.each(["Draft", "InReview", "Approved", "Published", "Archived", "Superseded"])(
  "retains real lifecycle %s in readonly current history",
  async (state) => {
    const v = current();
    v.review.lifecycle.state = state;
    const result = await createOptionPriceReviewClient(fetcher(v)).query({
      ruleReference: id(21),
      context,
      expectedScope: scope,
      csrf,
    });
    if (result.review.outcome !== "Recorded") throw new Error("expected actual recorded fixture");
    expect(result.review.lifecycle.state).toBe(state);
    expect(result.review.qualification).toBe("NotEvaluated");
  },
);
it.each([
  ["Denied", 403, "request_denied"],
  ["Conflict", 409, "option_price_conflict"],
  ["Invalid", 400, "option_price_invalid"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
] as const)(
  "first definitive %s can refuse the new command without a fake terminal",
  async (code, status, error) => {
    const p = prepare(fetcher({ error }, status));
    await expect(p.execute({ csrf })).rejects.toMatchObject({ code });
    expect(p.pending).toBe(false);
  },
);
it.each([
  ["Denied", 403, "request_denied"],
  ["Conflict", 409, "option_price_conflict"],
  ["Invalid", 400, "option_price_invalid"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
  ["Unavailable", 503, "option_price_unavailable"],
] as const)(
  "later %s cannot clear unknown review; resolve retains exact command without context",
  async (attemptCode, status, error) => {
    const f = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("private transport detail"))
        .mockResolvedValueOnce(response({ error }, status))
        .mockResolvedValueOnce(response(receipt())),
      p = prepare(f);
    await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await expect(p.execute({ csrf })).rejects.toMatchObject({
      code: "OutcomeUnknown",
      attemptCode,
    });
    expect(p.pending).toBe(true);
    expect((await p.resolve({ csrf })).outcome).toBe("Committed");
    expect(p.pending).toBe(false);
    expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
    expect(f.mock.calls[2]?.[0]).toBe("/merchant/pricing/option-prices/review/resolve");
    expect(JSON.parse(String(f.mock.calls[2]?.[1]?.body))).toEqual({ command: command() });
  },
);
it("actual original Abandoned clears unknown without adding business evidence", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(response({ ...receipt(), outcome: "Abandoned" })),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect((await p.resolve({ csrf })).outcome).toBe("Abandoned");
  expect(p.pending).toBe(false);
});
it.each([
  {
    name: "wrong operation",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, operationReference: id(90) }),
  },
  {
    name: "wrong action",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, action: "Approve" }),
  },
  {
    name: "wrong Actor",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, actorReference: id(90) }),
  },
  {
    name: "unbounded lease",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, validUntil: "2026-10-05T12:00:06.000Z" }),
  },
  {
    name: "future original clock",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, occurredAt: "2026-10-05T12:00:01.000Z" }),
  },
  {
    name: "fake Absent terminal",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, outcome: "Absent" }),
  },
  {
    name: "fake state or evidence",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, state: null }),
  },
])("malformed $name keeps sent original pending", async ({ change }) => {
  const p = prepare(fetcher(change(receipt())));
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
});
it.each([
  {
    name: "wrong rule",
    change: (v: ReturnType<typeof current>) => ({ ...v, ruleReference: id(90) }),
  },
  {
    name: "unknown policy",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      policy: { ...v.policy, approvalPolicy: "DefaultAllow" },
    }),
  },
  {
    name: "invalid policy interval",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      policy: { ...v.policy, effectiveUntil: v.policy.effectiveFrom },
    }),
  },
  {
    name: "invented qualification",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      review: { ...v.review, qualification: "Pass" },
    }),
  },
  {
    name: "unknown lifecycle",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      review: { ...v.review, lifecycle: { ...v.review.lifecycle, state: "Released" } },
    }),
  },
  {
    name: "absence with evidence",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      review: { outcome: "Absent", validationValidUntil: until },
    }),
  },
  {
    name: "approval exceeding validation",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      review: { ...v.review, approvalValidUntil: until },
    }),
  },
])("query rejects $name without claiming no review", async ({ change }) => {
  await expect(
    createOptionPriceReviewClient(fetcher(change(current()))).query({
      ruleReference: id(21),
      context,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("current query has independent finite scope and expiry failures", async () => {
  await expect(
    createOptionPriceReviewClient(fetcher({ ...current(), actorReference: id(90) })).query({
      ruleReference: id(21),
      context,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  vi.setSystemTime(until);
  await expect(
    createOptionPriceReviewClient(fetcher(current())).query({
      ruleReference: id(21),
      context,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("scope switch blocks recovery and retains the original without cross-scope HTTP", async () => {
  const f = vi.fn<typeof fetch>().mockRejectedValue(new Error()),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(
    p.resolve({ csrf, scope: { ...scope, actorReference: id(90) } }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(p.pending).toBe(true);
  expect(f).toHaveBeenCalledTimes(1);
});
it("scope changes during dispatch suppress the old receipt", async () => {
  const changed = { ...scope },
    f = vi.fn<typeof fetch>(async () => {
      changed.storeReference = id(90);
      return response(receipt());
    }),
    p = prepare(f);
  await expect(p.execute({ csrf, scope: changed })).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "ScopeChanged",
  });
  expect(p.pending).toBe(true);
});
it("expired original review deadlines remain usable for resolving a real historical commit", async () => {
  const c = {
      ...command("Approve"),
      validationValidUntil: "2026-10-05T11:30:00.000Z",
      approvalValidUntil: "2026-10-05T11:20:00.000Z",
    },
    f = fetcher({ ...receipt("Approve"), occurredAt: "2026-10-05T11:00:00.000Z" }),
    p = createOptionPriceReviewClient(f).prepare({ command: c, context, expectedScope: scope });
  expect((await p.resolve({ csrf })).occurredAt).toBe("2026-10-05T11:00:00.000Z");
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({ command: c });
});
it("command parsing enforces actual Submit/Approve modes and rejects accessors without invoking them", () => {
  expect(() => parseOptionPriceReviewCommand({ ...command(), approvalValidUntil: until })).toThrow(
    OptionPriceReviewClientError,
  );
  expect(() =>
    parseOptionPriceReviewCommand({ ...command("Approve"), expectedLifecycle: null }),
  ).toThrow(OptionPriceReviewClientError);
  expect(() =>
    parseOptionPriceReviewCommand({
      ...command("Approve"),
      approvalValidUntil: "2026-10-05T13:00:00.000Z",
    }),
  ).toThrow(OptionPriceReviewClientError);
  let calls = 0;
  const c = command();
  Object.defineProperty(c, "action", {
    enumerable: true,
    get() {
      calls++;
      return "SubmitReview";
    },
  });
  expect(() => parseOptionPriceReviewCommand(c)).toThrow(OptionPriceReviewClientError);
  expect(calls).toBe(0);
  expect(() => parseOptionPriceReviewCommand({ ...command(), policyReference: id(50) })).toThrow(
    OptionPriceReviewClientError,
  );
});
it("unconfirmed original stays blocked after malformed resolve or changed CSRF", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(response({ ...receipt(), operationReference: id(90) })),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(p.resolve({ csrf: "bad" })).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Invalid",
  });
  expect(f).toHaveBeenCalledTimes(1);
  await expect(p.resolve({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
});
it("pre-dispatch abort or bad CSRF cannot send the new review", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fetcher(receipt()),
    p = prepare(f);
  await expect(p.execute({ csrf, signal: controller.signal })).rejects.toMatchObject({
    code: "Unavailable",
  });
  await expect(p.execute({ csrf: "bad" })).rejects.toMatchObject({ code: "Invalid" });
  expect(p.pending).toBe(false);
  expect(f).not.toHaveBeenCalled();
});
it("abort after dispatch and concurrent retry do not unlock uncertainty", async () => {
  const f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    controller = new AbortController(),
    p = prepare(f),
    sent = p.execute({ csrf, signal: controller.signal });
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  controller.abort();
  await expect(sent).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
  expect(f).toHaveBeenCalledTimes(1);
});
it("finite timeout bounds an uncooperative fetch and preserves original", async () => {
  const f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    p = prepare(f),
    sent = p.execute({ csrf }),
    checked = expect(sent).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await vi.advanceTimersByTimeAsync(15000);
  await checked;
  expect(p.pending).toBe(true);
});
it("bounded compact response cancels excess bytes and never interprets them as absence", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled = true;
      },
    }),
    f = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }),
    ),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(cancelled).toBe(true);
  expect(p.pending).toBe(true);
});
it("missing no-store or spoofed error body cannot create definitive refusal", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt()), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        response({ error: "option_price_conflict", privateBody: "secret" }, 409),
      ),
    p = prepare(f);
  const first = await p.execute({ csrf }).catch((e: unknown) => e);
  expect(first).toMatchObject({ code: "OutcomeUnknown" });
  expect(String(first)).not.toContain(id(20));
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
});
it.each([
  ["Denied", 403, "request_denied"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
  ["Conflict", 409, "option_price_conflict"],
  ["Invalid", 400, "option_price_invalid"],
  ["Unavailable", 503, "option_price_unavailable"],
] as const)(
  "query reports finite %s without false current absence",
  async (code, status, error) => {
    await expect(
      createOptionPriceReviewClient(fetcher({ error }, status)).query({
        ruleReference: id(21),
        context,
        expectedScope: scope,
        csrf,
      }),
    ).rejects.toMatchObject({ code });
  },
);
