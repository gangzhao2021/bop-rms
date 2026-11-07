import { afterEach, expect, it, vi } from "vitest";
import {
  createProductPublicationCommandClient,
  parseProductPublicationUserCommand,
  productPublicationUserActions,
  type ProductPublicationUserAction,
  type ProductPublicationUserCommand,
} from "./product-publication-command-client.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  csrf = "c".repeat(43),
  hash = "sha256:" + "a".repeat(64);
const scope = { brandReference: id(2), storeReference: id(3) };
function command(action: ProductPublicationUserAction = "Validate"): ProductPublicationUserCommand {
  return {
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 7,
    expectedPublicationVersion: 2,
    action,
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-10-01T12:00:00.000Z",
        localDateTime: "2026-10-01T08:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    scheduleReference: ["SchedulePublish", "ReschedulePublish", "CancelScheduledPublish"].includes(
      action,
    )
      ? id(8)
      : null,
    replacementVersionReference: null,
    successorDraftVersionReference: action === "Publish" ? id(9) : null,
    occurredAt: "2026-10-01T11:00:00.000Z",
    reasonCode: "SYNTHETIC_EDIT",
  };
}
function receipt(c: ProductPublicationUserCommand, status = "Applied") {
  return {
    status,
    operationReference: c.operationReference,
    productReference: c.productReference,
    versionReference: c.versionReference,
    aggregateVersion: c.expectedProductAggregateVersion + 1,
    publicationVersion: c.expectedPublicationVersion + 1,
    state: {
      Validate: "Draft",
      SubmitReview: "InReview",
      Approve: "Approved",
      Reject: "Draft",
      Publish: "Published",
      SchedulePublish: "Scheduled",
      ReschedulePublish: "Scheduled",
      CancelScheduledPublish: "Draft",
    }[c.action],
    scheduleVersion: c.scheduleReference ? 2 : 0,
    effectiveFrom: c.effectivePeriod.effectiveFrom.instant,
    successorDraftVersionReference: c.successorDraftVersionReference,
  };
}
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
afterEach(() => vi.useRealTimers());
it.each(productPublicationUserActions)(
  "binds native %s receipt to original action and exact same-origin transport",
  async (action) => {
    const c = command(action),
      fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(receipt(c)));
    const prepared = createProductPublicationCommandClient(fetcher).prepare(c, scope);
    const result = await prepared.execute(csrf);
    expect(result).toEqual(receipt(c));
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/publication");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(prepared.command),
    });
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-bop-csrf")).toBe(csrf);
    expect(JSON.parse(atob(headers.get("x-bop-catalog-scope") ?? ""))).toEqual(scope);
    expect(Object.isFrozen(prepared.command.effectivePeriod.effectiveFrom)).toBe(true);
    expect(Object.isFrozen(prepared.command.scopeSet[0]?.channelCodes)).toBe(true);
    expect(result).not.toHaveProperty("eligibility");
    expect(result).not.toHaveProperty("validationDecision");
  },
);
it("unknown outcome and permission-restored Replayed keep original bytes and time without new sources", async () => {
  const original = command("SchedulePublish"),
    fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Synthetic offline"))
      .mockResolvedValueOnce(reply({ error: "request_denied" }, 403))
      .mockResolvedValueOnce(reply(receipt(original, "Replayed")));
  const prepared = createProductPublicationCommandClient(fetcher).prepare(original, scope);
  Object.assign(original, { operationReference: id(99), occurredAt: "2027-10-01T12:00:00.000Z" });
  Object.assign(original.effectivePeriod.effectiveFrom, { instant: "2027-10-01T12:00:00.000Z" });
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(prepared.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  const recovered = await prepared.execute(csrf);
  expect(recovered.status).toBe("Replayed");
  expect(recovered.operationReference).toBe(id(4));
  const bodies = fetcher.mock.calls.map((call) => call[1]?.body);
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(String(bodies[0])).occurredAt).toBe("2026-10-01T11:00:00.000Z");
});
it.each([
  [400, "product_publication_invalid", "Invalid"],
  [403, "request_denied", "Denied"],
  [409, "product_publication_conflict", "Conflict"],
  [409, "product_publication_feature_disabled", "FeatureDisabled"],
] as const)(
  "recognizes definitive native %s refusal before uncertain outcome",
  async (status, error, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ error }, status));
    await expect(
      createProductPublicationCommandClient(fetcher).prepare(command(), scope).execute(csrf),
    ).rejects.toMatchObject({ code });
  },
);
it.each([
  "operation",
  "product",
  "version",
  "root",
  "publication",
  "state",
  "period",
  "successor",
  "status",
  "extra",
  "schedule",
])("rejects rebound native receipt %s as Unknown", async (mode) => {
  const c = command("SchedulePublish"),
    result = receipt(c);
  if (mode === "operation") result.operationReference = id(99);
  if (mode === "product") result.productReference = id(99);
  if (mode === "version") result.versionReference = id(99);
  if (mode === "root") result.aggregateVersion++;
  if (mode === "publication") result.publicationVersion++;
  if (mode === "state") result.state = "Published";
  if (mode === "period") result.effectiveFrom = "2027-10-01T12:00:00.000Z";
  if (mode === "successor") result.successorDraftVersionReference = id(99);
  if (mode === "status") result.status = "AlreadyApplied";
  if (mode === "extra") Object.assign(result, { eligibility: "Eligible" });
  if (mode === "schedule") result.scheduleVersion = 0;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(result));
  await expect(
    createProductPublicationCommandClient(fetcher).prepare(c, scope).execute(csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([
  "system",
  "supersede",
  "authority",
  "getter",
  "cycle",
  "sparse",
  "extra",
  "schedule",
  "successor",
  "period",
  "offset",
  "fold",
  "zone",
  "scope",
  "duplicate",
  "oversize",
])("refuses malformed/authority candidate %s before fetch", (mode) => {
  const c = command();
  const fetcher = vi.fn<typeof fetch>();
  if (mode === "system")
    Object.assign(c, {
      action: "ActivateScheduled",
      actorKind: "System",
      scheduleReference: id(8),
      successorDraftVersionReference: id(9),
    });
  if (mode === "supersede")
    Object.assign(c, { action: "Supersede", replacementVersionReference: id(9) });
  if (mode === "authority") Object.assign(c, { validation: { decision: "Pass" } });
  if (mode === "getter")
    Object.defineProperty(c, "reasonCode", {
      enumerable: true,
      get() {
        throw new Error("must not invoke");
      },
    });
  if (mode === "cycle") Object.assign(c, { scopeSet: [c] });
  if (mode === "sparse") Object.assign(c, { scopeSet: Array(2) });
  if (mode === "extra") Object.assign(c, { tenantReference: id(99) });
  if (mode === "schedule") Object.assign(c, { scheduleReference: id(8) });
  if (mode === "successor")
    Object.assign(c, { action: "Publish", successorDraftVersionReference: c.versionReference });
  if (mode === "period")
    Object.assign(c.effectivePeriod, { effectiveUntil: c.effectivePeriod.effectiveFrom });
  if (mode === "offset") Object.assign(c.effectivePeriod.effectiveFrom, { utcOffsetMinutes: -300 });
  if (mode === "fold")
    Object.assign(c.effectivePeriod.effectiveFrom, {
      instant: "2026-11-01T06:30:00.000Z",
      localDateTime: "2026-11-01T01:30:00.000",
      utcOffsetMinutes: -240,
    });
  if (mode === "zone") Object.assign(c.effectivePeriod, { timeZone: "Synthetic/Unknown" });
  if (mode === "scope")
    Object.assign(c, {
      scopeSet: [{ level: "Channel", reference: "WEB", channelCodes: ["APP"], orderTypeCodes: [] }],
    });
  if (mode === "duplicate") Object.assign(c, { scopeSet: [...c.scopeSet, ...c.scopeSet] });
  if (mode === "oversize")
    Object.assign(c, {
      scopeSet: Array.from({ length: 200 }, (_, n) => ({
        level: "Store",
        reference: id(n + 100),
        channelCodes: [],
        orderTypeCodes: [],
      })),
    });
  expect(() => createProductPublicationCommandClient(fetcher).prepare(c, scope)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("binds both real Toronto fold offsets and rejects the spring gap", () => {
  for (const [instant, utcOffsetMinutes] of [
    ["2026-11-01T05:30:00.000Z", -240],
    ["2026-11-01T06:30:00.000Z", -300],
  ] as const) {
    const c = command();
    Object.assign(c.effectivePeriod.effectiveFrom, {
      instant,
      localDateTime: "2026-11-01T01:30:00.000",
      utcOffsetMinutes,
    });
    expect(
      parseProductPublicationUserCommand(c).effectivePeriod.effectiveFrom.utcOffsetMinutes,
    ).toBe(utcOffsetMinutes);
  }
  const c = command();
  Object.assign(c.effectivePeriod.effectiveFrom, {
    instant: "2026-03-08T07:30:00.000Z",
    localDateTime: "2026-03-08T02:30:00.000",
    utcOffsetMinutes: -300,
  });
  expect(() => parseProductPublicationUserCommand(c)).toThrow();
});
it("finite timeout refuses ignored abort and preserves exact explicit retry", async () => {
  vi.useFakeTimers();
  const c = command(),
    fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(reply(receipt(c, "Replayed")));
  const prepared = createProductPublicationCommandClient(fetcher).prepare(c, scope);
  const first = expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await vi.advanceTimersByTimeAsync(15000);
  await first;
  expect((await prepared.execute(csrf)).status).toBe("Replayed");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
});
it.each(["cache", "type", "bytes", "utf8", "missing", "unknown", "spoof"])(
  "refuses untrusted native response %s",
  async (mode) => {
    const c = command();
    let response = reply(receipt(c));
    if (mode === "cache") response.headers.set("cache-control", "public");
    if (mode === "type") response.headers.set("content-type", "text/html");
    if (mode === "bytes") response = reply({ padding: "茶".repeat(22000) });
    if (mode === "utf8")
      response = new Response(new Uint8Array([255]), { headers: response.headers });
    if (mode === "missing") response = new Response(null, { headers: response.headers });
    if (mode === "unknown") response = reply({ error: "product_publication_unavailable" }, 503);
    const fetcher =
      mode === "spoof"
        ? vi.fn<typeof fetch>().mockRejectedValue({ code: "Denied" })
        : vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      createProductPublicationCommandClient(fetcher).prepare(c, scope).execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  },
);
it.each([
  [403, "request_denied", "Denied"],
  [400, "product_publication_invalid", "Invalid"],
  [409, "product_publication_conflict", "Conflict"],
  [409, "product_publication_feature_disabled", "FeatureDisabled"],
] as const)(
  "restored original retains unknown after current %s refusal",
  async (status, error, attemptCode) => {
    const original = command("SchedulePublish"),
      fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(reply({ error }, status))
        .mockResolvedValueOnce(reply(receipt(original, "Replayed")));
    const recovered = createProductPublicationCommandClient(fetcher).recover(original, scope);
    await expect(recovered.execute(csrf)).rejects.toMatchObject({
      code: "OutcomeUnknown",
      attemptCode,
    });
    const result = await recovered.execute(csrf);
    expect(result.status).toBe("Replayed");
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(recovered.command);
  },
);
it("restored pending never becomes a new request after cancellation or bad CSRF", async () => {
  const send = vi.fn<typeof fetch>();
  const original = createProductPublicationCommandClient(send).recover(command("Publish"), scope);
  await expect(original.execute("bad")).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Invalid",
  });
  const abort = new AbortController();
  abort.abort();
  await expect(original.execute(csrf, abort.signal)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(send).not.toHaveBeenCalled();
});
