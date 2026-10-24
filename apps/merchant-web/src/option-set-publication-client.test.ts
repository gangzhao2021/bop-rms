// Synthetic owning public fixtures; browser transport tests do not prove IAM/SQL.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  materializeFullOptionSetCreation,
  createCatalogOptionSetContentReviewBinding,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
} from "../../../packages/bop/publishing/src/index.js";
import {
  createOptionSetPublicationClient,
  parseOptionSetPublicationCommand,
  parseOptionSetPublicationCursor,
} from "./option-set-publication-client.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7900-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-04T12:00:00.000Z"),
  csrf = "A".repeat(43),
  hash = "sha256:" + "a".repeat(64),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  anchor = { brandReference: scope.brandReference, storeReference: scope.storeReference };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function source() {
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTH_CHOICES",
      operationReference: id(7),
      occurredAt: at,
      reasonCode: "INITIAL_CONFIGURATION",
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
    },
    {
      brandReference: scope.brandReference,
      actorReference: scope.actorReference,
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  );
}
function context(action = "SubmitReview", recorded = false) {
  const s = source(),
    draft = {
      optionSetReference: id(6),
      versionReference: id(8),
      aggregateVersion: 1,
      sourceOperationReference: id(7),
      sourceSnapshotTuple: {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        optionSetReference: id(6),
        versionReference: id(8),
        aggregateVersion: 1,
        sourceDigest: s.sourceDigest,
        contentDigest: s.contentDigest,
        configurationDigest: s.configurationDigest,
      },
      sourceDigest: s.sourceDigest,
      contentDigest: s.contentDigest,
      configurationDigest: s.configurationDigest,
    };
  const binding = createCatalogOptionSetContentReviewBinding({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(6),
    versionReference: id(8),
    expectedAggregateVersion: 1,
    sourceDigest: s.sourceDigest,
    contentDigest: s.contentDigest,
    configurationDigest: s.configurationDigest,
    graphDigest: hash,
    policyReference: id(31),
    policyVersion: 1,
    policyContentDigest: hash,
    currentPolicyPublicationReference: id(32),
    originalIntentDigest: hash,
    activationAt: at,
  });
  return {
    profile: "CatalogOptionSetPublicationContextV1",
    action,
    ...scope,
    observedAt: at,
    validUntil: "2026-10-04T12:00:05.000Z",
    draft,
    review: recorded
      ? {
          kind: "Recorded" as const,
          operationReference: id(33),
          publishingReviewOperationReference: id(34),
          lifecycleReference: id(35),
          submittedActorReference: id(20),
          recordedAt: at,
          recordDigest: hash,
          latestMutationOperationReference: id(34),
          binding,
          lifecycle: createPublishingLifecycleRecord({
            lifecycleId: parsePublishingReference(id(35)),
            familyReference: parsePublishingReference(id(6)),
            configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
            purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
            snapshotReference: parsePublishingReference(id(8)),
            snapshotDigest: parsePublishingDigest(binding.digest),
            scope: createPublishingScope({
              kind: "Brand",
              brandReference: id(2),
              storeReference: null,
            }),
            version: parsePublishingVersion(2),
            state: "InReview",
            validationEvidenceReference: parsePublishingReference(id(36)),
            approvalEvidenceReference: null,
            createdAt: parsePublishingInstant(at),
            changedAt: parsePublishingInstant(at),
          }),
        }
      : { kind: "AbsentForCurrentDraft" as const },
  };
}
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const receipt = (action = "SubmitReview", outcome = "Committed") => ({
  profile: "CatalogOptionSetPublicationReceiptV1",
  storeReference: id(3),
  operationReference: id(50),
  action,
  outcome,
  recordedAt: at,
});
async function observed(
  client: ReturnType<typeof createOptionSetPublicationClient>,
  action: "SubmitReview" | "Approve" | "Publish" | "Validate" = "SubmitReview",
) {
  return client.context(
    { optionSetReference: id(6), expectedAggregateVersion: 1, action },
    anchor,
    csrf,
  );
}
it("reads actual root/three digests and preserves distinct Catalog/Pub Review operations", async () => {
  const f = vi.fn<typeof fetch>(async () => response(context("Approve", true))),
    client = createOptionSetPublicationClient(f),
    c = await observed(client, "Approve"),
    p = client.prepare(c, "Approve", id(50));
  expect(p.command.expectedReview).toMatchObject({
    reviewOperationReference: id(33),
    publishingReviewOperationReference: id(34),
  });
  expect(p.command.expectedLifecycle?.latestMutationOperationReference).toBe(id(34));
  expect(p.body).not.toContain("tenantReference");
  expect(p.body).not.toContain("actorReference");
});
it("captures exact bytes/op for retry after Unknown then Denied and does not silently replace", async () => {
  let attempt = 0;
  const f = vi.fn<typeof fetch>(async (path) =>
      String(path).endsWith("/context")
        ? response(context())
        : ++attempt === 1
          ? response({ error: "option_set_publication_unavailable" }, 503)
          : response({ error: "request_denied" }, 403),
    ),
    client = createOptionSetPublicationClient(f),
    p = client.prepare(await observed(client), "SubmitReview", id(50));
  await expect(p.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(p.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  expect(f.mock.calls[1]?.[1]?.body).toBe(p.body);
  expect(f.mock.calls[2]?.[1]?.body).toBe(p.body);
});
it("matches compact terminal receipt exactly and sends identity-only Resolve", async () => {
  const f = vi.fn<typeof fetch>(async (path) =>
      String(path).endsWith("/context") ? response(context()) : response(receipt()),
    ),
    client = createOptionSetPublicationClient(f),
    p = client.prepare(await observed(client), "SubmitReview", id(50));
  expect(await p.execute(csrf)).toMatchObject({ outcome: "Committed" });
  expect(await client.resolve(p.cursor, scope, csrf)).toMatchObject({ outcome: "Committed" });
  const body = JSON.parse(String(f.mock.calls[2]?.[1]?.body));
  expect(body.profile).toBe("CatalogOptionSetPublicationResolutionRequestV1");
  expect(Object.keys(body)).not.toContain("content");
  expect(body).not.toHaveProperty("actorReference");
});
it.each(["brand", "tuple", "binding", "head", "clock", "extra"])(
  "rejects malformed or foreign %s current packet",
  async (mode) => {
    const c = context("Approve", true);
    if (mode === "brand") c.brandReference = id(99);
    if (mode === "tuple") Reflect.set(c.draft.sourceSnapshotTuple, "sourceDigest", hash);
    if (c.review.kind === "Recorded") {
      if (mode === "binding")
        Reflect.set(c.review, "binding", { ...c.review.binding, sourceDigest: hash });
      if (mode === "head") c.review.latestMutationOperationReference = id(98);
    }
    if (mode === "clock") c.validUntil = "2026-10-04T12:00:06.000Z";
    if (mode === "extra") Reflect.set(c, "ready", true);
    const client = createOptionSetPublicationClient(async () => response(c));
    await expect(observed(client, "Approve")).rejects.toThrow();
  },
);
it("accepts a genuine future qualified activation in a bounded four-check report", async () => {
  const validation = {
      checks: [
        "CURRENT_REFERENCES",
        "PUBLISHING_POLICY",
        "RULE_SATISFIABILITY",
        "SCOPE_TOPOLOGY",
      ].map((code) => ({ code, outcome: "Pass" })),
      findings: [],
      decision: "Pass",
      observedAt: at,
      qualifiedActivationAt: "2026-10-05T12:00:00.000Z",
      independentApproval: "NotEvaluated",
      saleEligibility: "NotEvaluated",
    },
    client = createOptionSetPublicationClient(async (path) =>
      String(path).endsWith("/context")
        ? response(context("Validate"))
        : response({
            profile: "CatalogOptionSetPublicationCommandResultV1",
            storeReference: id(3),
            outcome: "Validated",
            validation,
          }),
    );
  expect(await client.validate(await observed(client, "Validate"), csrf)).toEqual(validation);
});
it("refuses a false report Pass and foreign receipt rather than creating success", async () => {
  let mode = "report";
  const client = createOptionSetPublicationClient(async (path) =>
    String(path).endsWith("/context")
      ? response(context(mode === "report" ? "Validate" : "SubmitReview"))
      : mode === "report"
        ? response({
            profile: "CatalogOptionSetPublicationCommandResultV1",
            storeReference: id(3),
            outcome: "Validated",
            validation: {
              checks: [
                "CURRENT_REFERENCES",
                "PUBLISHING_POLICY",
                "RULE_SATISFIABILITY",
                "SCOPE_TOPOLOGY",
              ].map((code) => ({ code, outcome: "HardError" })),
              findings: [],
              decision: "Pass",
              observedAt: at,
              qualifiedActivationAt: at,
              independentApproval: "NotEvaluated",
              saleEligibility: "NotEvaluated",
            },
          })
        : response({ ...receipt(), operationReference: id(99) }),
  );
  await expect(client.validate(await observed(client, "Validate"), csrf)).rejects.toThrow();
  mode = "receipt";
  const p = client.prepare(await observed(client), "SubmitReview", id(50));
  await expect(p.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("does not transmit new authority fields or stale context and isolates other Actor Resolve", async () => {
  const client = createOptionSetPublicationClient(async () => response(context())),
    c = await observed(client),
    p = client.prepare(c, "SubmitReview", id(50));
  expect(() =>
    parseOptionSetPublicationCommand({ ...p.command, actorReference: id(99) }),
  ).toThrow();
  expect(() => parseOptionSetPublicationCursor({ ...p.cursor, policy: {} })).toThrow();
  await expect(
    client.resolve(p.cursor, { ...scope, actorReference: id(99) }, csrf),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  vi.setSystemTime("2026-10-04T12:00:05.000Z");
  expect(() => client.prepare(c, "SubmitReview", id(51))).toThrow();
});
it("aborted in-flight writes retain Unknown; caller pre-abort emits no command", async () => {
  let resolveFetch: ((v: Response) => void) | undefined;
  const f = vi.fn<typeof fetch>(async (path) =>
      String(path).endsWith("/context")
        ? response(context())
        : new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
    ),
    client = createOptionSetPublicationClient(f),
    p = client.prepare(await observed(client), "SubmitReview", id(50)),
    abort = new AbortController(),
    result = p.execute(csrf, abort.signal);
  abort.abort();
  await expect(result).rejects.toMatchObject({ code: "OutcomeUnknown" });
  resolveFetch?.(response(receipt()));
  expect(f).toHaveBeenCalledTimes(2);
});
it("preserves actual Disabled classification from Context and original dispatch", async () => {
  let disabled = false;
  const client = createOptionSetPublicationClient(async (path) =>
      String(path).endsWith("/context") && !disabled
        ? response(context())
        : response({ error: "option_set_publication_feature_disabled" }, 409),
    ),
    p = client.prepare(await observed(client), "SubmitReview", id(50));
  disabled = true;
  await expect(observed(client)).rejects.toMatchObject({ code: "Disabled" });
  await expect(p.execute(csrf)).rejects.toMatchObject({ code: "Disabled" });
});
