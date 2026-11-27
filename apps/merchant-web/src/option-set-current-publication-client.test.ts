import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  materializeFullOptionSetCreation,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createOptionSetCurrentPublicationClient,
  parseOptionSetCurrentPublicationRequest,
  parseOptionSetCurrentPublicationView,
} from "./option-set-current-publication-client.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z"),
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
    operationReference: id(7),
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "CHOICE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "CHOICE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  };
}
function owningCreate(value: unknown = creation(), brandReference = scope.brandReference) {
  return materializeFullOptionSetCreation(
    {
      ...(value as ReturnType<typeof creation>),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
    },
    {
      brandReference,
      actorReference: scope.actorReference,
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  );
}

function fixture(state: "Absent" | "NotCurrentlyPublished" | "Published" = "Published") {
  const full = owningCreate(),
    release = {
      publicationReference: id(20),
      releaseSequence: 1,
      releasedAt: at,
      lifecycleReference: id(21),
      lifecycleVersion: 4,
      snapshotReference: id(8),
      snapshotDigest: digest,
      approvalDisposition: "Approved",
    };
  return {
    profile: "CatalogOptionSetCurrentPublicationResultV1",
    ...scope,
    optionSetReference: id(6),
    currentAggregateVersion: 2,
    publicationState: state,
    currentLifecycleReference: state === "Absent" ? null : id(21),
    lastReleaseReference: state === "Absent" ? null : id(20),
    release: state === "Published" ? release : null,
    published:
      state === "Published"
        ? {
            profile: "CatalogOptionSetCurrentPublishedContentV1",
            content: full.content,
            sourceDigest: full.sourceDigest,
            contentDigest: full.contentDigest,
            configurationDigest: full.configurationDigest,
            sourceRecords: [
              {
                optionSetReference: id(6),
                versionReference: id(8),
                publicationReference: id(20),
                releaseRecordDigest: digest,
                sealRecordDigest: digest,
                approvalDisposition: "Approved",
              },
            ],
            graphDigest: digest,
            rules: { status: "Satisfiable", reason: null, searchNodes: 1 },
            observedAt: at,
            validUntil: until,
            sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
            referenceEligibility: "NotEvaluated",
            eligibility: "NotEvaluated",
            publishValidation: "Incomplete",
          }
        : null,
    observedAt: at,
    validUntil: until,
  };
}
const command = { optionSetReference: id(6), expectedAggregateVersion: null };
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
it.each(["Absent", "NotCurrentlyPublished", "Published"] as const)(
  "reads genuine %s status without a history grant or fake empty content",
  async (state) => {
    const fetcher = vi.fn(async () => response(fixture(state))),
      view = await createOptionSetCurrentPublicationClient(fetcher).load({
        command,
        expectedScope: scope,
        csrf,
      });
    expect(view.publicationState).toBe(state);
    expect(view.published === null).toBe(state !== "Published");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls).toHaveLength(1);
  },
);
it("sends only closed source pins and exact same-origin scope/CSRF headers", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(fixture()));
  await createOptionSetCurrentPublicationClient(fetcher).load({
    command,
    expectedScope: scope,
    csrf,
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/current-published");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    method: "POST",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(command),
  });
});
it.each([
  "Tenant",
  "Brand",
  "Store",
  "Actor",
  "set",
  "version",
  "release",
  "snapshot",
  "digest",
  "sourcePin",
  "duplicate",
  "sourceAuthority",
  "eligibility",
  "lease",
  "proofClock",
  "absentFake",
])("rejects current publication %s substitution", async (kind) => {
  const raw: Record<string, unknown> = { ...fixture() },
    original = fixture(),
    p = original.published;
  if (!p) throw new Error("Missing fixture");
  if (kind === "Tenant") raw.tenantReference = id(99);
  if (kind === "Brand") raw.brandReference = id(99);
  if (kind === "Store") raw.storeReference = id(99);
  if (kind === "Actor") raw.actorReference = id(99);
  if (kind === "set") raw.optionSetReference = id(99);
  if (kind === "version")
    raw.published = {
      ...p,
      content: {
        ...p.content,
        sourceAggregate: { ...p.content.sourceAggregate, aggregateVersion: 2 },
      },
    };
  if (kind === "release") raw.lastReleaseReference = id(99);
  if (kind === "snapshot") raw.release = { ...original.release, snapshotReference: id(99) };
  if (kind === "digest") raw.published = { ...p, contentDigest: digest };
  if (kind === "sourcePin")
    raw.published = {
      ...p,
      sourceRecords: p.sourceRecords.map((s) => ({ ...s, versionReference: id(99) })),
    };
  if (kind === "duplicate")
    raw.published = { ...p, sourceRecords: [...p.sourceRecords, ...p.sourceRecords] };
  if (kind === "sourceAuthority") raw.published = { ...p, sourceAuthority: "StaticPublished" };
  if (kind === "eligibility") raw.published = { ...p, eligibility: "Pass" };
  if (kind === "lease") raw.validUntil = at;
  if (kind === "proofClock") raw.published = { ...p, validUntil: "2026-10-05T12:00:04.000Z" };
  if (kind === "absentFake") raw.publicationState = "Absent";
  await expect(parseOptionSetCurrentPublicationView(raw, command, scope, at)).rejects.toBeDefined();
});
it.each(["Satisfiable", "Unsatisfiable", "Indeterminate"])(
  "preserves mechanical %s without certifying sale eligibility",
  async (status) => {
    const raw = fixture(),
      p = raw.published;
    if (!p) throw new Error("Missing fixture");
    const view = await parseOptionSetCurrentPublicationView(
      {
        ...raw,
        published: {
          ...p,
          rules: {
            status,
            reason:
              status === "Satisfiable"
                ? null
                : status === "Unsatisfiable"
                  ? "NoSelection"
                  : "SearchLimit",
            searchNodes: 1,
          },
        },
      },
      command,
      scope,
      at,
    );
    expect(view.published?.rules.status).toBe(status);
    expect(view.published?.publishValidation).toBe("Incomplete");
  },
);
it("preserves a real PolicyWaived disposition without inferring approval", async () => {
  const raw = fixture(),
    p = raw.published;
  if (!p) throw new Error("Missing fixture");
  const view = await parseOptionSetCurrentPublicationView(
    {
      ...raw,
      release: { ...raw.release, approvalDisposition: "PolicyWaived" },
      published: {
        ...p,
        sourceRecords: p.sourceRecords.map((s) => ({ ...s, approvalDisposition: "PolicyWaived" })),
      },
    },
    command,
    scope,
    at,
  );
  expect(view.release?.approvalDisposition).toBe("PolicyWaived");
});
it("refuses malformed, getter and caller source/proof input before transport", () => {
  let calls = 0;
  expect(() =>
    parseOptionSetCurrentPublicationRequest({
      optionSetReference: id(6),
      get expectedAggregateVersion() {
        calls++;
        return null;
      },
    }),
  ).toThrow();
  expect(calls).toBe(0);
  expect(() => parseOptionSetCurrentPublicationRequest({ ...command, published: true })).toThrow();
});
it("checks expected current root and never confuses that version with the released source", async () => {
  await expect(
    parseOptionSetCurrentPublicationView(
      fixture(),
      { ...command, expectedAggregateVersion: 1 },
      scope,
      at,
    ),
  ).rejects.toBeDefined();
  const view = await parseOptionSetCurrentPublicationView(
    fixture(),
    { ...command, expectedAggregateVersion: 2 },
    scope,
    at,
  );
  expect(view.published?.content.sourceAggregate.aggregateVersion).toBe(1);
  expect(view.currentAggregateVersion).toBe(2);
});
it.each([
  [403, "request_denied", "Denied"],
  [409, "option_set_current_publication_feature_disabled", "FeatureDisabled"],
  [409, "option_set_current_publication_conflict", "Conflict"],
  [400, "option_set_current_publication_invalid", "Invalid"],
  [503, "option_set_current_publication_unavailable", "Unavailable"],
])("maps bounded HTTP %s/%s and never retries automatically", async (status, error, code) => {
  const fetcher = vi.fn(async () => response({ error }, Number(status)));
  await expect(
    createOptionSetCurrentPublicationClient(fetcher).load({ command, expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledOnce();
});
it("refuses offline, cancellation and late replies", async () => {
  const offline = vi.fn(async () => {
    throw new Error("offline");
  });
  await expect(
    createOptionSetCurrentPublicationClient(offline).load({ command, expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  let release: ((v: Response) => void) | undefined;
  const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
    abort = new AbortController(),
    pending = createOptionSetCurrentPublicationClient(fetcher).load({
      command,
      expectedScope: scope,
      csrf,
      signal: abort.signal,
    });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "Unavailable" });
  release?.(response(fixture()));
});
it("rejects expired streaming observation, oversized bodies and unsafe response headers", async () => {
  const fetcher = vi.fn(async () => {
    vi.setSystemTime(until);
    return response(fixture());
  });
  await expect(
    createOptionSetCurrentPublicationClient(fetcher).load({ command, expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code: "Stale" });
  vi.setSystemTime(at);
  const large = new Response(new Uint8Array(2097153), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  await expect(
    createOptionSetCurrentPublicationClient(vi.fn(async () => large)).load({
      command,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await expect(
    createOptionSetCurrentPublicationClient(
      vi.fn(async () => response({}, 200, { "Cache-Control": "public" })),
    ).load({ command, expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
