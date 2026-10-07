import { canonicalizeRfc8785 } from "../../../packages/bop/audit/src/index.js";
import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  materializeFullOptionSetCreation,
  materializeFullOptionSetEdit,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogOptionSetAuthoringResolutionCommand,
  createCatalogOptionSetAuthoringIdentity,
  createCatalogOptionSetAuthoringResolution,
  createCatalogOptionSetContentReviewBinding,
  createCatalogOptionSetReviewRecord,
  createCatalogOptionSetReleaseRecord,
  type OptionSetHistoryEntry,
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogOptionSetEditorContent,
  optionContentReviewValidationCodes,
  parseCatalogOptionSetHistoryResult,
  parseCatalogOptionSetHistoricalDraftResult,
  parseCatalogOptionSetHistoricalFrozenResult,
  compareCatalogOptionSetContent,
  evaluateCatalogOptionSetRuleSatisfiability,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingVersion,
  parsePublishingOptionSetPublicationOperation,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parseReleaseSequence,
} from "../../../packages/bop/publishing/src/index.js";
// Real production DOM/IndexedDB. HTTP identities and business records are
// explicitly synthetic; owning public contracts generate every full receipt.
// This does not claim actual Session/IAM/Postgres authorization (native gate).
const id = (n: number) =>
  parseCatalogReference("01902421-7a00-7000-8000-" + n.toString(16).padStart(12, "0"));
const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  csrf = "A".repeat(43);
const send = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
const hash = (v: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(v)).digest("hex");
async function rows(page: Page, database = "bop-option-set-authoring-pending-v1") {
  return page.evaluate(async (database) => {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const open = indexedDB.open(database, 1);
      open.onerror = () => reject(Error("journal inspection failed"));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("originals")) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction("originals", "readonly"),
          get = tx.objectStore("originals").getAll();
        let result: Record<string, unknown>[] = [];
        get.onsuccess = () => {
          result = get.result;
        };
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(Error("journal inspection failed"));
        };
      };
    });
  }, database);
}
const publicationRows = (page: Page) => rows(page, "bop-option-set-publication-pending-v1");
function seed() {
  const at = parseCatalogInstant(new Date(Date.now() - 60_000).toISOString());
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTH_CHOICES",
      operationReference: id(20),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic choices" },
        localizedDescriptions: { "en-CA": "Synthetic full configuration" },
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 2,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 2,
        allowRepeatedOption: false,
        options: [
          {
            stableCode: "OLD",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Synthetic original option" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: false,
            triggeredOptionSetReference: id(60),
            conflictOptionCodes: [],
          },
        ],
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: [
          {
            stableCode: "OLD",
            quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
            media: {
              mediaReference: id(61),
              assetReference: id(62),
              assetVersionReference: id(63),
              altText: { "en-CA": "Synthetic original image" },
            },
            pricingRule: { reference: id(64), versionReference: id(65) },
            consumption: {
              kind: "Inventory",
              reference: id(66),
              versionReference: id(67),
              quantity: "0.125",
              unitCode: "GRAM",
            },
            triggeredOptionSetVersionReference: id(68),
          },
        ],
        conditionalRules: [],
        conflictRules: [],
        scopeSet: [
          { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
        ],
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
        optionSetReference: id(10),
        versionReference: id(11),
        options: [{ stableCode: "OLD", optionReference: id(12) }],
      },
    },
  );
}
type Full = ReturnType<typeof materializeFullOptionSetCreation>;
async function sources(page: Page, initial: Full | null = null) {
  const state = {
    current: initial,
    sourceOperationReference: id(20),
    publicationMode: "Confirm" as
      "Confirm" | "CommitUnknown" | "AbsentUnknown" | "Denied" | "Disabled" | "Conflict",
    publicationResolveDenied: false,
    publicationReview: null as ReturnType<typeof createCatalogOptionSetReviewRecord> | null,
    publicationLifecycle: null as ReturnType<typeof createPublishingLifecycleRecord> | null,
    publicationValidation: null as ReturnType<typeof createPublishingValidationEvidence> | null,
    publicationApproval: null as ReturnType<typeof createPublishingApprovalEvidence> | null,
    publicationRelease: null as ReturnType<typeof createPublishingReleaseRecord> | null,
    catalogRelease: null as ReturnType<typeof createCatalogOptionSetReleaseRecord> | null,
    publishingReviewOperationReference: id(900),
    latestPublicationOperationReference: id(901),
    publicationWrites: [] as { action: string; body: string }[],
    publicationResolves: [] as string[],
    publicationContexts: [] as string[],
    publicationOriginals: new Map<
      string,
      {
        body: string;
        receipt: {
          profile: string;
          storeReference: string;
          operationReference: string;
          action: string;
          outcome: "Committed" | "Abandoned";
          recordedAt: string;
        };
      }
    >(),
    publicationAllocation: 1000,
    frozen: null as ReturnType<typeof createCatalogFullOptionSetPublicationMaterialization> | null,
    historyDenied: false,
    historyConflict: false,
    historyRequests: [] as string[],
    publicationTimeline: [] as {
      operationReference: string;
      lifecycleReference: string;
      lifecycleVersion: number;
      operation: string;
      actorKind: "User";
      actorReference: string;
      occurredAt: string;
      recordedAt: string;
      reasonCode: string;
      fromState: string | null;
      toState: string;
      snapshotReference: string;
      snapshotDigest: string;
      releaseReference: string | null;
      releaseSequence: number | null;
      supersededReleaseReference: null;
      rollbackTargetReleaseReference: null;
    }[],
    draftHistory: new Map<
      string,
      {
        source: Full;
        action: "Create" | "ReplaceDraft" | "Publish";
        intentDigest: string;
        occurredAt: string;
      }
    >(),
    createMode: "Confirm" as "Confirm" | "CommitUnknown" | "AbsentUnknown" | "Denied",
    resolveDenied: false,
    currentReadError: false,
    listEnabled: true,
    editEnabled: true,
    actor: scope.actorReference,
    sessionCsrf: csrf,
    writes: [] as { path: string; body: string }[],
    reads: 0,
    contexts: [] as string[],
    resolves: 0,
    originals: new Map<
      string,
      {
        source: Full;
        action: "Create" | "Edit";
        at: ReturnType<typeof parseCatalogInstant>;
        auditReference: ReturnType<typeof parseCatalogReference>;
        intentDigest: string;
      }
    >(),
    abandoned: new Set<string>(),
    capabilities: [] as string[],
  };
  if (initial)
    state.draftHistory.set(String(id(20)), {
      source: initial,
      action: "Create",
      intentDigest: hash({ syntheticOriginal: initial.content }),
      occurredAt: initial.content.sourceAggregate.updatedAt,
    });
  await page.route("**/merchant/session", (route) =>
    send(route, {
      authenticated: true,
      csrf: state.sessionCsrf,
      workspace: {
        screenId: "HOME-OVERVIEW",
        selectedScope: {
          brandLabel: "Synthetic Brand",
          storeLabel: "Synthetic Store",
          storeReference: scope.storeReference,
        },
        authorizedStores: [
          {
            brandLabel: "Synthetic Brand",
            storeLabel: "Synthetic Store",
            storeReference: scope.storeReference,
          },
        ],
        businessDate: "2026-10-05",
        storeStatus: "Unavailable",
        freshness: "Stale",
        dashboardAvailability: "UnavailableUntilWP1905",
        navigation: [
          {
            screenId: "CAT-OPTIONSET-LIST",
            label: "Option sets",
            href: "/app/commerce/option-sets",
            permission: "catalog.manage",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/store-capability", (route) => {
    const key = String(route.request().postDataJSON().capabilityKey),
      action = key.slice("catalog.cat_optionset_".length),
      enabled =
        action === "list" ? state.listEnabled : action === "edit" ? state.editEnabled : true;
    state.capabilities.push(key);
    return send(route, {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      capabilityKey: key,
      controlKey: "catalog.optionset." + action,
      backendExecution: enabled ? "Allow" : "Deny",
      frontendVisibility: enabled ? "Show" : "Hide",
      reason: enabled ? "Enabled" : "Disabled",
      source: "BrandOverride",
      controlReference: id(30),
      controlVersion: 1,
      observedAt: new Date().toISOString(),
    });
  });
  await page.route("**/merchant/catalog/option-sets/authoring/context", (route) => {
    const action = String(route.request().postDataJSON().action),
      at = new Date().toISOString();
    state.contexts.push(action);
    return send(route, {
      profile: "CatalogOptionSetAuthoringContextV1",
      action,
      ...scope,
      actorReference: state.actor,
      observedAt: at,
      validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    });
  });
  await page.route("**/merchant/catalog/option-sets/current-editor", (route) => {
    state.reads++;
    expect(route.request().postDataJSON().expectedAggregateVersion).toBeNull();
    if (state.currentReadError)
      return send(route, { error: "option_set_authoring_unavailable" }, 503);
    if (!state.current) return send(route, { error: "option_set_authoring_unavailable" }, 503);
    return send(route, {
      profile: "CatalogOptionSetCurrentEditorResultV1",
      ...scope,
      actorReference: state.actor,
      ...state.current,
      referenceEligibility: "NotEvaluated",
    });
  });
  for (const action of ["Create", "Edit"] as const)
    await page.route(
      "**/merchant/catalog/option-sets/" + (action === "Create" ? "create" : "draft"),
      async (route) => {
        const body = route.request().postDataJSON(),
          operationReference = parseCatalogReference(body.operationReference);
        state.writes.push({ path: action, body: route.request().postData() ?? "" });
        expect(route.request().headers()["x-bop-csrf"]).toBe(state.sessionCsrf);
        const markers = await rows(page);
        expect(markers).toHaveLength(1);
        expect(markers[0]?.operationReference).toBe(operationReference);
        expect(Object.keys(markers[0] ?? {}).sort()).toEqual(
          [
            "profile",
            "scope",
            "action",
            "operationReference",
            "optionSetReference",
            "expectedAggregateVersion",
          ].sort(),
        );
        if (state.createMode === "Denied") return send(route, { error: "request_denied" }, 403);
        if (state.abandoned.has(operationReference))
          return send(route, { error: "option_set_authoring_conflict" }, 409);
        if (state.createMode === "AbsentUnknown") return route.abort("failed");
        let original = state.originals.get(operationReference);
        const replay = Boolean(original);
        if (!original) {
          const at = parseCatalogInstant(new Date().toISOString());
          const source =
            action === "Create"
              ? materializeFullOptionSetCreation(
                  { ...body, occurredAt: at, reasonCode: "AUTHORIZED_OPERATION" },
                  {
                    brandReference: scope.brandReference,
                    actorReference: state.actor,
                    allocations: {
                      optionSetReference: id(10),
                      versionReference: id(11),
                      options: body.draft.options.map((o: { stableCode: string }, i: number) => ({
                        stableCode: o.stableCode,
                        optionReference: id(12 + i),
                      })),
                    },
                  },
                )
              : materializeFullOptionSetEdit(
                  { ...body, occurredAt: at, reasonCode: "AUTHORIZED_OPERATION" },
                  state.current?.content,
                  {
                    actorReference: state.actor,
                    newOptions: body.draft.options
                      .filter((o: { identity: { kind: string } }) => o.identity.kind === "New")
                      .map((o: { stableCode: string }, i: number) => ({
                        stableCode: o.stableCode,
                        optionReference: id(40 + i),
                      })),
                  },
                );
          original = {
            source,
            action,
            at,
            auditReference: id(80 + state.originals.size),
            intentDigest: hash(body),
          };
          state.originals.set(operationReference, original);
          state.current = source;
          state.sourceOperationReference = operationReference;
          state.draftHistory.set(operationReference, {
            source,
            action: action === "Create" ? "Create" : "ReplaceDraft",
            intentDigest: original.intentDigest,
            occurredAt: at,
          });
        }
        if (state.createMode === "CommitUnknown") return route.abort("failed");
        return send(route, {
          profile: "CatalogOptionSetAuthoringCommandResultV1",
          action,
          status: replay ? "Replayed" : "Applied",
          operationReference,
          content: original.source.content,
          contentDigest: original.source.contentDigest,
          configurationDigest: original.source.configurationDigest,
          storeReference: scope.storeReference,
          referenceEligibility: "NotEvaluated",
        });
      },
    );
  await page.route("**/merchant/catalog/option-sets/authoring/resolve", (route) => {
    state.resolves++;
    expect(route.request().headers()["x-bop-csrf"]).toBe(state.sessionCsrf);
    const body = route.request().postDataJSON();
    expect(body).not.toHaveProperty("draft");
    expect(body).not.toHaveProperty("actorReference");
    expect(body).not.toHaveProperty("occurredAt");
    if (state.resolveDenied) return send(route, { error: "request_denied" }, 403);
    const command = parseCatalogOptionSetAuthoringResolutionCommand({
        ...body,
        profile: "CatalogOptionSetAuthoringResolutionCommandV1",
        brandReference: scope.brandReference,
        actorReference: state.actor,
        reasonCode: "AUTHORIZED_OPERATION",
      }),
      original = state.originals.get(command.operationReference);
    const identity = original
      ? createCatalogOptionSetAuthoringIdentity({
          command,
          sourceOperationReference: command.operationReference,
          optionSetReference: original.source.content.sourceAggregate.optionSetReference,
          versionReference: original.source.content.sourceAggregate.draft.versionReference,
          aggregateVersion: original.source.content.sourceAggregate.aggregateVersion,
          originalOccurredAt: original.at,
          auditReference: original.auditReference,
          originalIntentDigest: original.intentDigest,
          sourceDigest: original.source.sourceDigest,
          contentDigest: original.source.contentDigest,
          configurationDigest: original.source.configurationDigest,
        })
      : null;
    if (!identity) state.abandoned.add(command.operationReference);
    const resolution = createCatalogOptionSetAuthoringResolution({
      command,
      outcome: identity ? "Committed" : "Abandoned",
      identity,
      recordedAt: identity
        ? identity.originalOccurredAt
        : parseCatalogInstant(new Date().toISOString()),
    });
    return send(route, {
      profile: "CatalogOptionSetAuthoringResolutionResultV1",
      storeReference: scope.storeReference,
      resolution,
      content: original?.source.content ?? null,
    });
  });
  // Controlled HTTP observations use real owning root, immutable Review and
  // lifecycle constructors. They are not native source/IAM qualification.
  const allocate = () => id(++state.publicationAllocation);
  const currentPublicationContext = (action: string) => {
    const c = state.current;
    if (!c) throw Error("synthetic current source absent");
    const root = c.content.sourceAggregate,
      at = new Date().toISOString();
    const review = state.publicationReview;
    const sameDraft =
      review?.binding.versionReference === root.draft.versionReference &&
      review.binding.expectedAggregateVersion === root.aggregateVersion;
    return {
      profile: "CatalogOptionSetPublicationContextV1",
      action,
      ...scope,
      actorReference: state.actor,
      observedAt: at,
      validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      draft: {
        optionSetReference: root.optionSetReference,
        versionReference: root.draft.versionReference,
        aggregateVersion: root.aggregateVersion,
        sourceOperationReference: state.sourceOperationReference,
        sourceDigest: c.sourceDigest,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        sourceSnapshotTuple: {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          optionSetReference: root.optionSetReference,
          versionReference: root.draft.versionReference,
          aggregateVersion: root.aggregateVersion,
          sourceDigest: c.sourceDigest,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
        },
      },
      review:
        sameDraft && review && state.publicationLifecycle
          ? {
              kind: "Recorded",
              operationReference: review.operationReference,
              publishingReviewOperationReference: state.publishingReviewOperationReference,
              lifecycleReference: review.lifecycleReference,
              submittedActorReference: review.actorReference,
              recordedAt: review.recordedAt,
              recordDigest: review.digest,
              latestMutationOperationReference: state.latestPublicationOperationReference,
              binding: review.binding,
              lifecycle: state.publicationLifecycle,
            }
          : { kind: "AbsentForCurrentDraft" },
    };
  };
  await page.route("**/merchant/catalog/option-sets/publication/context", (route) => {
    const body = route.request().postDataJSON();
    state.publicationContexts.push(body.action);
    expect(Object.keys(body).sort()).toEqual(
      ["action", "expectedAggregateVersion", "optionSetReference"].sort(),
    );
    expect(route.request().headers()["x-bop-csrf"]).toBe(state.sessionCsrf);
    if (!state.current)
      return send(route, { error: "option_set_publication_context_unavailable" }, 503);
    if (body.action !== "Inspect" && (!state.editEnabled || state.publicationMode === "Disabled"))
      return send(route, { error: "option_set_publication_feature_disabled" }, 409);
    if (
      body.optionSetReference !== state.current.content.sourceAggregate.optionSetReference ||
      (body.expectedAggregateVersion !== null &&
        body.expectedAggregateVersion !== state.current.content.sourceAggregate.aggregateVersion)
    )
      return send(route, { error: "option_set_publication_context_conflict" }, 409);
    return send(route, currentPublicationContext(body.action));
  });
  const reason = (action: string) =>
    action === "SubmitReview"
      ? "PUBLISHING_REVIEW_SUBMITTED"
      : action === "Approve"
        ? "PUBLISHING_REVIEW_APPROVED"
        : "PUBLISHING_RELEASE_PUBLISHED";
  const owningCommand = (body: Record<string, unknown>) =>
    parsePublishingOptionSetPublicationOperation({
      ...body,
      profile: "PublishingOptionSetPublicationOperationV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      selectedStoreReference: scope.storeReference,
      actorReference: state.actor,
      reasonCode: reason(String(body.action)),
    });
  await page.route("**/merchant/catalog/option-sets/publication/command", async (route) => {
    const body = route.request().postDataJSON();
    expect(route.request().headers()["x-bop-csrf"]).toBe(state.sessionCsrf);
    if (body.action === "Validate") {
      const at = new Date().toISOString(),
        c = state.current;
      if (!c) throw Error("synthetic validation source absent");
      expect(body.optionSetReference).toBe(c.content.sourceAggregate.optionSetReference);
      expect(body.expectedAggregateVersion).toBe(c.content.sourceAggregate.aggregateVersion);
      expect(body.sourceDigest).toBe(c.sourceDigest);
      expect(body.contentDigest).toBe(c.contentDigest);
      expect(body.configurationDigest).toBe(c.configurationDigest);
      // Public report is a controlled HTTP observation, not a source qualification.
      return send(route, {
        profile: "CatalogOptionSetPublicationCommandResultV1",
        storeReference: scope.storeReference,
        outcome: "Validated",
        validation: {
          checks: optionContentReviewValidationCodes.map((code) => ({ code, outcome: "Pass" })),
          findings: [],
          decision: "Pass",
          observedAt: at,
          qualifiedActivationAt: at,
          independentApproval: "NotEvaluated",
          saleEligibility: "NotEvaluated",
        },
      });
    }
    const command = owningCommand(body),
      originalBody = canonicalizeRfc8785(body);
    state.publicationWrites.push({ action: command.action, body: originalBody });
    const markers = await publicationRows(page);
    expect(markers).toHaveLength(1);
    expect(Object.keys(markers[0] ?? {}).sort()).toEqual(["profile", "scope", "command"].sort());
    expect(markers[0]).toEqual({
      profile: "CatalogOptionSetPublicationCursorV1",
      scope: { ...scope, actorReference: state.actor },
      command: body,
    });
    const serialized = JSON.stringify(markers);
    for (const forbidden of [
      "localizedNames",
      "additionalContent",
      "policyContent",
      "validation",
      "csrf",
      state.sessionCsrf,
    ])
      expect(serialized).not.toContain(forbidden);
    const prior = state.publicationOriginals.get(command.operationReference);
    if (prior) {
      expect(prior.body).toBe(originalBody);
      return send(route, prior.receipt);
    }
    if (state.publicationMode === "Denied") return send(route, { error: "request_denied" }, 403);
    if (state.publicationMode === "Disabled")
      return send(route, { error: "option_set_publication_feature_disabled" }, 409);
    if (state.publicationMode === "Conflict")
      return send(route, { error: "option_set_publication_conflict" }, 409);
    if (state.publicationMode === "AbsentUnknown") return route.abort("failed");
    const c = state.current;
    if (!c) throw Error("synthetic source absent");
    const at = parseCatalogInstant(new Date().toISOString()),
      root = c.content.sourceAggregate;
    expect(command.optionSetReference).toBe(root.optionSetReference);
    expect(command.expectedAggregateVersion).toBe(root.aggregateVersion);
    expect(command.sourceDigest).toBe(c.sourceDigest);
    expect(command.contentDigest).toBe(c.contentDigest);
    expect(command.configurationDigest).toBe(c.configurationDigest);
    const fromState = state.publicationLifecycle?.state ?? "Draft";
    if (command.action === "SubmitReview") {
      expect(command.expectedReview).toBeNull();
      const binding = createCatalogOptionSetContentReviewBinding({
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        optionSetReference: root.optionSetReference,
        versionReference: root.draft.versionReference,
        expectedAggregateVersion: root.aggregateVersion,
        sourceDigest: c.sourceDigest,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        graphDigest: hash({ root: c.content, authority: "SyntheticControlledHttp" }),
        policyReference: id(910),
        policyVersion: 1,
        policyContentDigest: hash({ syntheticPolicy: "Required" }),
        currentPolicyPublicationReference: id(911),
        originalIntentDigest: hash(body),
        activationAt: at,
      });
      state.publicationReview = createCatalogOptionSetReviewRecord({
        operationReference: allocate(),
        sourceOperationReference: state.sourceOperationReference,
        lifecycleReference: allocate(),
        actorReference: state.actor,
        auditReference: allocate(),
        reasonCode: reason(command.action),
        recordedAt: at,
        binding,
        content: c.content,
      });
      state.publicationValidation = createPublishingValidationEvidence({
        evidenceReference: parsePublishingReference(allocate()),
        snapshotReference: parsePublishingReference(root.draft.versionReference),
        snapshotDigest: parsePublishingDigest(binding.digest),
        scope: createPublishingScope({
          kind: "Brand",
          brandReference: scope.brandReference,
          storeReference: null,
        }),
        result: "Pass",
        checkedAt: parsePublishingInstant(at),
        validUntil: parsePublishingInstant(new Date(Date.parse(at) + 5000).toISOString()),
        checkCodes: optionContentReviewValidationCodes.map(parsePublishingCode),
      });
      state.publishingReviewOperationReference = parseCatalogReference(command.operationReference);
      state.publicationLifecycle = createPublishingLifecycleRecord({
        lifecycleId: parsePublishingReference(state.publicationReview.lifecycleReference),
        familyReference: parsePublishingReference(root.optionSetReference),
        configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
        purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
        snapshotReference: parsePublishingReference(root.draft.versionReference),
        snapshotDigest: parsePublishingDigest(binding.digest),
        scope: createPublishingScope({
          kind: "Brand",
          brandReference: scope.brandReference,
          storeReference: null,
        }),
        version: parsePublishingVersion(2),
        state: "InReview",
        validationEvidenceReference: state.publicationValidation.evidenceReference,
        approvalEvidenceReference: null,
        createdAt: parsePublishingInstant(at),
        changedAt: parsePublishingInstant(at),
      });
    } else {
      const review = state.publicationReview,
        lifecycle = state.publicationLifecycle;
      if (!review || !lifecycle) throw Error("synthetic recorded review absent");
      expect(command.expectedReview).toEqual({
        reviewOperationReference: review.operationReference,
        publishingReviewOperationReference: state.publishingReviewOperationReference,
        recordDigest: review.digest,
        bindingDigest: review.binding.digest,
      });
      expect(command.expectedLifecycle?.latestMutationOperationReference).toBe(
        state.latestPublicationOperationReference,
      );
      if (command.action === "Approve" && state.actor === review.actorReference)
        return send(route, { error: "request_denied" }, 403);
      if (command.action === "Approve")
        state.publicationApproval = createPublishingApprovalEvidence({
          evidenceReference: parsePublishingReference(allocate()),
          reviewLifecycleId: lifecycle.lifecycleId,
          reviewVersion: lifecycle.version,
          snapshotReference: lifecycle.snapshotReference,
          snapshotDigest: lifecycle.snapshotDigest,
          scope: lifecycle.scope,
          decision: "Accepted",
          approvedActorReference: parsePublishingReference(state.actor),
          approvedAt: parsePublishingInstant(at),
          validUntil: parsePublishingInstant(new Date(Date.parse(at) + 5000).toISOString()),
        });
      state.publicationLifecycle = createPublishingLifecycleRecord({
        ...lifecycle,
        state: command.action === "Approve" ? "Approved" : "Published",
        version: parsePublishingVersion(lifecycle.version + 1),
        changedAt: parsePublishingInstant(at),
        approvalEvidenceReference:
          command.action === "Approve"
            ? (state.publicationApproval?.evidenceReference ?? null)
            : lifecycle.approvalEvidenceReference,
      });
      if (command.action === "Publish") {
        expect(lifecycle.state).toBe("Approved");
        state.publicationRelease = createPublishingReleaseRecord({
          releaseId: parsePublishingReference(allocate()),
          familyReference: lifecycle.familyReference,
          configurationType: lifecycle.configurationType,
          purposeCode: lifecycle.purposeCode,
          snapshotReference: lifecycle.snapshotReference,
          snapshotDigest: lifecycle.snapshotDigest,
          scope: lifecycle.scope,
          sequence: parseReleaseSequence(1),
          sourceLifecycleId: lifecycle.lifecycleId,
          kind: "Publish",
          previousReleaseId: null,
          createdAt: parsePublishingInstant(at),
        });
        const { sourceAggregate, ...additional } = c.content;
        const sealOperation = allocate();
        const plan = createCatalogFullOptionSetPublicationMaterialization(
          sourceAggregate,
          additional,
          {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            optionSetReference: root.optionSetReference,
            versionReference: root.draft.versionReference,
            sourceAggregateVersion: root.aggregateVersion,
            publicationOperationReference: sealOperation,
            publicationIntentDigest: hash(body),
            successorDraftVersionReference: allocate(),
            sealedAt: at,
            sourceDigest: c.sourceDigest,
            contentDigest: c.contentDigest,
            configurationDigest: c.configurationDigest,
          },
        );
        if (!state.publicationRelease) throw Error("synthetic release absent");
        state.catalogRelease = createCatalogOptionSetReleaseRecord({
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          optionSetReference: root.optionSetReference,
          versionReference: root.draft.versionReference,
          operationReference: allocate(),
          reviewOperationReference: review.operationReference,
          reviewRecordDigest: review.digest,
          reviewBindingDigest: review.binding.digest,
          sealOperationReference: sealOperation,
          sealRecordDigest: plan.content.digest,
          publishingOperationReference: command.operationReference,
          actorReference: state.actor,
          auditReference: allocate(),
          reasonCode: reason(command.action),
          recordedAt: state.publicationRelease.createdAt,
          release: state.publicationRelease,
        });
        state.frozen = plan;
        state.current = parseCatalogOptionSetEditorContent(plan.successor, additional);
        state.draftHistory.set(sealOperation, {
          source: state.current,
          action: "Publish",
          intentDigest: hash(body),
          occurredAt: at,
        });
        state.sourceOperationReference = sealOperation;
      }
    }
    const next = state.publicationLifecycle;
    if (!next) throw Error("synthetic lifecycle missing");
    state.publicationTimeline.unshift({
      operationReference: command.operationReference,
      lifecycleReference: next.lifecycleId,
      lifecycleVersion: next.version,
      operation: command.action,
      actorKind: "User",
      actorReference: state.actor,
      occurredAt: next.changedAt,
      recordedAt: at,
      reasonCode: reason(command.action),
      fromState,
      toState: next.state,
      snapshotReference: next.snapshotReference,
      snapshotDigest: next.snapshotDigest,
      releaseReference:
        command.action === "Publish" ? (state.publicationRelease?.releaseId ?? null) : null,
      releaseSequence:
        command.action === "Publish" ? (state.publicationRelease?.sequence ?? null) : null,
      supersededReleaseReference: null,
      rollbackTargetReleaseReference: null,
    });
    state.publicationTimeline.sort((a, b) =>
      a.occurredAt < b.occurredAt
        ? 1
        : a.occurredAt > b.occurredAt
          ? -1
          : a.operationReference < b.operationReference
            ? 1
            : a.operationReference > b.operationReference
              ? -1
              : 0,
    );
    state.latestPublicationOperationReference = parseCatalogReference(command.operationReference);
    const receipt = {
      profile: "CatalogOptionSetPublicationReceiptV1",
      storeReference: String(scope.storeReference),
      operationReference: String(command.operationReference),
      action: command.action,
      outcome: "Committed" as const,
      recordedAt: String(at),
    };
    state.publicationOriginals.set(command.operationReference, { body: originalBody, receipt });
    if (state.publicationMode === "CommitUnknown") return route.abort("failed");
    return send(route, receipt);
  });
  await page.route("**/merchant/catalog/option-sets/publication/resolve", (route) => {
    const body = route.request().postDataJSON();
    owningCommand(body);
    state.publicationResolves.push(canonicalizeRfc8785(body));
    expect(route.request().headers()["x-bop-csrf"]).toBe(state.sessionCsrf);
    if (state.publicationResolveDenied) return send(route, { error: "request_denied" }, 403);
    const originalBody = canonicalizeRfc8785({
      ...body,
      profile: "CatalogOptionSetPublicationCommandRequestV1",
    });
    const prior = state.publicationOriginals.get(body.operationReference);
    if (prior) {
      expect(prior.body).toBe(originalBody);
      return send(route, prior.receipt);
    }
    const receipt = {
      profile: "CatalogOptionSetPublicationReceiptV1",
      storeReference: String(scope.storeReference),
      operationReference: String(body.operationReference),
      action: String(body.action),
      outcome: "Abandoned" as const,
      recordedAt: new Date().toISOString(),
    };
    state.publicationOriginals.set(body.operationReference, { body: originalBody, receipt });
    return send(route, receipt);
  });
  // These immutable snapshots are generated by actual Catalog materializers.
  // HTTP scope/permission observations remain controlled and explicitly synthetic.
  const historyView = (kind: "Draft" | "Frozen", command: Record<string, unknown>, at: string) => {
    const window = { observedAt: at, validUntil: new Date(Date.parse(at) + 5000).toISOString() };
    if (kind === "Frozen") {
      const frozen = state.frozen?.content;
      if (!frozen) throw Error("synthetic Frozen absent");
      const pin = frozen.supportedContent;
      return parseCatalogOptionSetHistoricalFrozenResult(
        {
          profile: "CatalogOptionSetHistoricalFrozenV1",
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          optionSetReference: pin.optionSetReference,
          originalTuple: {
            operationReference: pin.publicationOperationReference,
            versionReference: pin.versionReference,
            resultAggregateVersion: pin.sourceAggregateVersion + 1,
            action: "Publish",
            intentDigest: pin.publicationIntentDigest,
            occurredAt: pin.sealedAt,
          },
          content: frozen,
          sourceDigest: frozen.sourceDigest,
          contentDigest: frozen.contentDigest,
          configurationDigest: frozen.configurationDigest,
          recordDigest: frozen.digest,
          ...window,
          recordingStatus: "RecordedFrozen",
          referenceEligibility: "NotEvaluated",
        },
        command,
      );
    }
    const original = state.draftHistory.get(String(command.operationReference));
    if (!original) throw Error("synthetic original Draft absent");
    const root = original.source.content.sourceAggregate;
    return parseCatalogOptionSetHistoricalDraftResult(
      {
        profile: "CatalogOptionSetHistoricalDraftV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        optionSetReference: root.optionSetReference,
        originalTuple: {
          operationReference: command.operationReference,
          versionReference: root.draft.versionReference,
          resultAggregateVersion: root.aggregateVersion,
          action: original.action,
          intentDigest: original.intentDigest,
          occurredAt: original.occurredAt,
        },
        ...original.source,
        ...window,
        referenceEligibility: "NotEvaluated",
      },
      command,
    );
  };
  await page.route("**/merchant/catalog/option-sets/history", (route) => {
    const packet = route.request().postDataJSON(),
      command = packet.command;
    state.historyRequests.push(JSON.stringify(packet));
    expect(route.request().headers()["x-bop-csrf"]).toBe(state.sessionCsrf);
    if (state.historyDenied) return send(route, { error: "request_denied" }, 403);
    if (state.historyConflict) return send(route, { error: "option_set_history_conflict" }, 409);
    const c = state.current;
    if (!c) return send(route, { error: "option_set_history_unavailable" }, 503);
    const at = new Date().toISOString(),
      window = {
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      };
    let view;
    if (packet.action === "List") {
      if (
        command.expectedAggregateVersion !== null &&
        command.expectedAggregateVersion !== c.content.sourceAggregate.aggregateVersion
      )
        return send(route, { error: "option_set_history_conflict" }, 409);
      const entries: OptionSetHistoryEntry[] = [...state.draftHistory].map(
        ([operationReference, original]): OptionSetHistoryEntry => {
          const root = original.source.content.sourceAggregate;
          return {
            resultAggregateVersion: root.aggregateVersion,
            operationReference,
            kind: "DraftSnapshot",
            action: original.action,
            occurredAt: original.occurredAt,
            availability: "Complete",
            versionReference: root.draft.versionReference,
            sourceAggregateVersion: root.aggregateVersion,
            sourceDigest: original.source.sourceDigest,
            contentDigest: original.source.contentDigest,
            configurationDigest: original.source.configurationDigest,
            recordDigest: null,
          };
        },
      );
      const frozen = state.frozen?.content;
      if (frozen)
        entries.push({
          resultAggregateVersion: frozen.supportedContent.sourceAggregateVersion + 1,
          operationReference: frozen.supportedContent.publicationOperationReference,
          kind: "FrozenSeal",
          action: "Publish",
          occurredAt: frozen.supportedContent.sealedAt,
          availability: "Complete",
          versionReference: frozen.supportedContent.versionReference,
          sourceAggregateVersion: frozen.supportedContent.sourceAggregateVersion,
          sourceDigest: frozen.sourceDigest,
          contentDigest: frozen.contentDigest,
          configurationDigest: frozen.configurationDigest,
          recordDigest: frozen.digest,
        });
      entries.sort(
        (a, b) =>
          b.resultAggregateVersion - a.resultAggregateVersion ||
          (a.operationReference < b.operationReference
            ? 1
            : a.operationReference > b.operationReference
              ? -1
              : a.kind < b.kind
                ? 1
                : a.kind > b.kind
                  ? -1
                  : 0),
      );
      const before = command.before;
      const offset = before
        ? entries.findIndex(
            (e) =>
              e.operationReference === before.operationReference &&
              e.kind === before.kind &&
              e.resultAggregateVersion === before.resultAggregateVersion,
          ) + 1
        : 0;
      const pageEntries = entries.slice(offset, offset + command.limit),
        last = pageEntries.at(-1);
      view = parseCatalogOptionSetHistoryResult(
        {
          profile: "CatalogOptionSetHistoryV1",
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          optionSetReference: c.content.sourceAggregate.optionSetReference,
          currentAggregateVersion: c.content.sourceAggregate.aggregateVersion,
          entries: pageEntries,
          nextBefore:
            offset + pageEntries.length < entries.length && last
              ? {
                  resultAggregateVersion: last.resultAggregateVersion,
                  operationReference: last.operationReference,
                  kind: last.kind,
                }
              : null,
          ...window,
          publicationStatus: "NotEvaluated",
        },
        command,
      );
    } else if (packet.action === "Publishing") {
      view = {
        profile: "PublishingOptionSetHistoryV1",
        scope: {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          selectedStoreReference: scope.storeReference,
          actorReference: state.actor,
        },
        familyReference: c.content.sourceAggregate.optionSetReference,
        entries: state.publicationTimeline,
        nextBefore: null,
        ...window,
      };
    } else if (packet.action === "Compare") {
      const left = {
          kind: command.left.kind,
          view: historyView(command.left.kind, command.left.command, at),
        },
        right = {
          kind: command.right.kind,
          view: historyView(command.right.kind, command.right.command, at),
        };
      const editor = (v: typeof left.view) =>
        "editorContent" in v.content ? v.content.editorContent : v.content;
      view = {
        profile: "CatalogOptionSetHistoryComparisonV1",
        left,
        right,
        comparison: compareCatalogOptionSetContent({
          left: editor(left.view),
          right: editor(right.view),
        }),
        ...window,
      };
    } else view = historyView(packet.action, command, at);
    return send(route, {
      profile: "CatalogOptionSetHistoryQueryResultV1",
      action: packet.action,
      storeReference: scope.storeReference,
      actorReference: state.actor,
      view,
    });
  });
  await page.route("**/merchant/catalog/option-sets/current-published", (route) => {
    const c = state.current;
    if (!c) return send(route, { error: "option_set_current_publication_unavailable" }, 503);
    const at = new Date().toISOString(),
      window = { observedAt: at, validUntil: new Date(Date.parse(at) + 5000).toISOString() },
      release = state.publicationRelease,
      frozen = state.frozen?.content,
      lifecycle = state.publicationLifecycle;
    let published = null;
    if (release && frozen) {
      if (
        frozen.editorContent.sourceAggregate.draft.options.some(
          (option) => option.triggeredOptionSetReference !== null,
        )
      )
        return send(route, { error: "option_set_current_publication_unavailable" }, 503);
      if (!state.catalogRelease) throw Error("synthetic actual release linkage absent");
      const full = parseCatalogOptionSetEditorContent(frozen.editorContent.sourceAggregate, {
        profile: frozen.editorContent.profile,
        optionDetails: frozen.editorContent.optionDetails,
        conditionalRules: frozen.editorContent.conditionalRules,
        conflictRules: frozen.editorContent.conflictRules,
        scopeSet: frozen.editorContent.scopeSet,
        effectivePeriod: frozen.editorContent.effectivePeriod,
      });
      const mechanical = evaluateCatalogOptionSetRuleSatisfiability({
        brandReference: scope.brandReference,
        rootOptionSetReference: c.content.sourceAggregate.optionSetReference,
        rootVersionReference: release.snapshotReference,
        contents: [full.content],
      });
      published = {
        profile: "CatalogOptionSetCurrentPublishedContentV1",
        ...full,
        sourceRecords: [
          {
            optionSetReference: c.content.sourceAggregate.optionSetReference,
            versionReference: release.snapshotReference,
            publicationReference: release.releaseId,
            releaseRecordDigest: state.catalogRelease.digest,
            sealRecordDigest: frozen.digest,
            approvalDisposition: "Approved",
          },
        ],
        graphDigest: mechanical.graphDigest,
        rules: {
          status: mechanical.status,
          reason: "reason" in mechanical ? mechanical.reason : null,
          searchNodes: mechanical.searchNodes,
        },
        ...window,
        sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
        referenceEligibility: "NotEvaluated",
        eligibility: "NotEvaluated",
        publishValidation: "Incomplete",
      };
    }
    return send(route, {
      profile: "CatalogOptionSetCurrentPublicationResultV1",
      ...scope,
      actorReference: state.actor,
      optionSetReference: c.content.sourceAggregate.optionSetReference,
      currentAggregateVersion: c.content.sourceAggregate.aggregateVersion,
      publicationState: release ? "Published" : "Absent",
      currentLifecycleReference: lifecycle?.lifecycleId ?? null,
      lastReleaseReference: release?.releaseId ?? null,
      release:
        release && lifecycle
          ? {
              publicationReference: release.releaseId,
              releaseSequence: release.sequence,
              releasedAt: release.createdAt,
              lifecycleReference: lifecycle.lifecycleId,
              lifecycleVersion: lifecycle.version,
              snapshotReference: release.snapshotReference,
              snapshotDigest: release.snapshotDigest,
              approvalDisposition: "Approved",
            }
          : null,
      published,
      ...window,
    });
  });
  await page.route("**/merchant/catalog/option-sets/list", (route) => {
    if (!state.listEnabled) return send(route, { error: "option_set_list_disabled" }, 409);
    const filters = route.request().postDataJSON(),
      c = state.current?.content,
      r = c?.sourceAggregate,
      d = r?.draft;
    const items =
      r && d && c
        ? [
            {
              optionSetReference: r.optionSetReference,
              internalCode: r.internalCode,
              lifecycle: r.lifecycle,
              aggregateVersion: r.aggregateVersion,
              draftVersionReference: d.versionReference,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
              name: d.localizedNames[d.defaultLocale],
              nameLocale: d.defaultLocale,
              localeFallback: false,
              selectionRule: {
                displayStyle: d.displayStyle,
                minimumSelection: d.minimumSelection,
                maximumSelection: d.maximumSelection,
                allowRepeatedOption: d.allowRepeatedOption,
                perOptionMaximumQuantity: d.perOptionMaximumQuantity,
                maximumTotalQuantity: d.maximumTotalQuantity,
              },
              optionCount: d.options.length,
              activeOptionCount: d.options.filter((o) => o.lifecycle === "Active").length,
              productBindingCount: 0,
              recordedPricingReference: {
                status: "Known",
                present: c.optionDetails.some((o) => o.pricingRule !== null),
              },
              recordedConsumptionReference: {
                status: "Known",
                present: c.optionDetails.some((o) => o.consumption !== null),
              },
              recordedConflict: {
                status: "Known",
                present:
                  c.conflictRules.length > 0 ||
                  d.options.some((o) => o.conflictOptionReferences.length > 0),
              },
              publishingStatus: { status: "Unavailable" },
              referenceEligibility: "NotEvaluated",
            },
          ]
        : [];
    return send(route, {
      projection: {
        name: "catalog_option_set_search_v1",
        version: 1,
        asOfUtc: new Date().toISOString(),
        stale: false,
        partial: true,
        sourceGeneration: state.current?.sourceDigest ?? hash([]),
      },
      scope: { ...scope, actorReference: state.actor },
      locale: filters.locale,
      items,
      hasMore: false,
      nextCursor: null,
    });
  });
  return state;
}
async function nameLocale(page: Page, label: string, text: string) {
  const group = page.getByRole("group", { name: label, exact: true });
  await group.getByLabel("Add locale", { exact: true }).fill("en-CA");
  await group
    .getByRole("button", { name: "Add " + label.toLowerCase() + " locale", exact: true })
    .click();
  await page.getByLabel(label + " en-CA", { exact: true }).fill(text);
}
async function fillCreate(page: Page) {
  await expect(page.getByLabel("Internal code", { exact: true })).toBeEnabled();
  await page.getByLabel("Internal code", { exact: true }).fill("SYNTH_CHOICES");
  await page.getByLabel("Default locale", { exact: true }).fill("en-CA");
  await nameLocale(page, "Option Set names", "Synthetic choices");
  await page
    .getByRole("combobox", { name: "Display style", exact: true })
    .selectOption("MultiChoice");
  await page.getByLabel("Minimum selections", { exact: true }).fill("0");
  await page
    .getByLabel("Maximum selections (empty means no explicit maximum)", { exact: true })
    .fill("2");
  await page.getByLabel("Per-option maximum quantity", { exact: true }).fill("1");
  await page
    .getByLabel("Maximum total quantity (empty means no explicit maximum)", { exact: true })
    .fill("2");
  await page.getByRole("button", { name: "Add option", exact: true }).click();
  await page.getByLabel("Stable code", { exact: true }).fill("OLD");
  await nameLocale(page, "Option 1 names", "Synthetic original option");
  await page.getByRole("combobox", { name: "Lifecycle", exact: true }).selectOption("Active");
  await page.getByRole("button", { name: "Add current Brand scope", exact: true }).click();
  await page.getByLabel("IANA time zone", { exact: true }).fill("UTC");
  await page
    .getByLabel("Effective from local date and time", { exact: true })
    .fill("2026-10-05T12:00");
  await page.getByLabel("From UTC offset in minutes", { exact: true }).fill("0");
  await page.getByLabel("I reviewed this complete Draft", { exact: false }).check();
}
test("@production ordinary Option Create → fresh Detail → complete Edit New/Archive → fresh List", async ({
  page,
}) => {
  const s = await sources(page);
  await page.goto("/app/commerce/option-sets/new");
  await fillCreate(page);
  await page.getByRole("button", { name: "Create Option Set", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original save confirmed" }),
  ).toBeVisible();
  expect(s.reads).toBe(1);
  expect(await rows(page)).toEqual([]);
  await page.getByRole("link", { name: "Open current detail", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Option Set detail", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic choices", exact: true })).toBeVisible();
  expect(s.reads).toBe(2);
  await page.getByRole("link", { name: "Edit current Draft", exact: true }).click();
  await expect(page.getByLabel("Internal code", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Internal code", { exact: true })).toHaveAttribute("readonly", "");
  await page.getByLabel("Option Set names en-CA", { exact: true }).fill("Synthetic edited choices");
  await page.getByLabel("Archive OLD explicitly", { exact: false }).check();
  await page.getByRole("button", { name: "Add option", exact: true }).click();
  await page.getByLabel("Stable code", { exact: true }).last().fill("NEW");
  await nameLocale(page, "Option 2 names", "Synthetic newly entered option");
  await page.getByLabel("I reviewed this complete Draft", { exact: false }).check();
  await page.getByRole("button", { name: "Save complete Draft", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original save confirmed" }),
  ).toBeVisible();
  expect(s.current?.content.sourceAggregate.aggregateVersion).toBe(2);
  expect(
    s.current?.content.sourceAggregate.draft.options.find((o) => o.stableCode === "OLD"),
  ).toMatchObject({ optionReference: id(12), lifecycle: "Archived" });
  expect(
    s.current?.content.sourceAggregate.draft.options.find((o) => o.stableCode === "NEW")
      ?.optionReference,
  ).toBe(id(40));
  expect(await rows(page)).toEqual([]);
  await page.getByRole("link", { name: "Back to Option Sets", exact: true }).click();
  const table = page.getByRole("table", { name: "Current Option Set authoring records" });
  await expect(
    table.getByRole("link", { name: "Synthetic edited choices", exact: true }),
  ).toBeVisible();
  await expect(table).toContainText("Draft version 2");
  expect(s.writes).toHaveLength(2);
});
for (const outcome of ["Committed", "Abandoned"] as const)
  test(`@production Option Unknown then Denied reload retains identity-only barrier until explicit ${outcome}`, async ({
    page,
  }) => {
    const s = await sources(page);
    s.createMode = outcome === "Committed" ? "CommitUnknown" : "AbsentUnknown";
    await page.goto("/app/commerce/option-sets/new");
    await fillCreate(page);
    await page.getByRole("button", { name: "Create Option Set", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "OutcomeUnknown" })).toBeVisible();
    const markers = await rows(page);
    expect(markers).toHaveLength(1);
    s.createMode = "Denied";
    await page.getByRole("button", { name: "Retry exact original request", exact: true }).click();
    await expect.poll(() => s.writes.length).toBe(2);
    await expect(
      page.getByRole("status").filter({ hasText: "OutcomeUnknown / Denied" }),
    ).toBeVisible();
    expect(s.writes[0]?.body).toBe(s.writes[1]?.body);
    expect(await rows(page)).toEqual(markers);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Resolve original operation", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Retry exact original request", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Create Option Set", exact: true }),
    ).toBeDisabled();
    expect(s.writes).toHaveLength(2);
    expect(await rows(page)).toEqual(markers);
    s.resolveDenied = true;
    await page.getByRole("button", { name: "Resolve original operation", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Denied" })).toBeVisible();
    expect(await rows(page)).toEqual(markers);
    s.resolveDenied = false;
    await page.getByRole("button", { name: "Resolve original operation", exact: true }).click();
    await expect(
      page.getByRole("status").filter({
        hasText:
          outcome === "Committed" ? "Original committed save recovered" : "permanently abandoned",
      }),
    ).toBeVisible();
    expect(await rows(page)).toEqual([]);
    expect(s.writes).toHaveLength(2);
    if (outcome === "Committed") {
      await expect(
        page.getByRole("heading", { name: "Synthetic choices", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create Option Set", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save complete Draft", exact: true }),
      ).toBeDisabled();
      expect(s.reads).toBe(1);
    } else {
      expect(s.abandoned.has(String(markers[0]?.operationReference))).toBe(true);
      s.createMode = "Confirm";
      await fillCreate(page);
      await page.getByRole("button", { name: "Create Option Set", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Original save confirmed" }),
      ).toBeVisible();
      expect(s.writes).toHaveLength(3);
      expect(JSON.parse(s.writes[2]?.body ?? "{}").operationReference).not.toBe(
        markers[0]?.operationReference,
      );
    }
  });
test("@production Option Detail uses own read feature while List/Edit disabled and retains complete source fields", async ({
  page,
}) => {
  const original = seed(),
    s = await sources(page, original);
  s.listEnabled = false;
  s.editEnabled = false;
  await page.goto(`/app/commerce/option-sets/${id(10)}`);
  await expect(page.getByRole("heading", { name: "Synthetic choices", exact: true })).toBeVisible();
  expect(s.contexts).toEqual([]);
  expect(s.capabilities).toEqual(["catalog.cat_optionset_detail"]);
  await expect(page.getByText("Recorded media retained", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Recorded consumption quantity", { exact: true })).toHaveValue(
    original.content.optionDetails[0]?.consumption?.quantity ?? "",
  );
  await expect(
    page.getByRole("button", { name: "Save complete Draft", exact: true }),
  ).toBeDisabled();
  s.editEnabled = true;
  await page.getByRole("link", { name: "Edit current Draft", exact: true }).click();
  await expect(page.getByLabel("Option Set names en-CA", { exact: true })).toBeEnabled();
  await page
    .getByLabel("Option Set names en-CA", { exact: true })
    .fill("Synthetic rich preserved choices");
  await page.getByLabel("I reviewed this complete Draft", { exact: false }).check();
  await page.getByRole("button", { name: "Save complete Draft", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original save confirmed" }),
  ).toBeVisible();
  expect(s.current?.content.optionDetails).toEqual(original.content.optionDetails);
  expect(s.current?.content.scopeSet).toEqual(original.content.scopeSet);
  expect(s.current?.content.effectivePeriod).toEqual(original.content.effectivePeriod);
  expect(s.current?.content.sourceAggregate.createdAt).toBe(
    original.content.sourceAggregate.createdAt,
  );
});
test("@production Option CSRF rotation preserves original reload barrier and permits current identity Resolve only", async ({
  page,
}) => {
  const s = await sources(page);
  s.createMode = "CommitUnknown";
  await page.goto("/app/commerce/option-sets/new");
  await fillCreate(page);
  await page.getByRole("button", { name: "Create Option Set", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "OutcomeUnknown" })).toBeVisible();
  const before = await rows(page);
  s.sessionCsrf = "B".repeat(43);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resolve original operation", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Retry exact original request", exact: true }),
  ).toBeDisabled();
  expect(await rows(page)).toEqual(before);
  await page.getByRole("button", { name: "Resolve original operation", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original committed save recovered" }),
  ).toBeVisible();
  expect(s.writes).toHaveLength(1);
  expect(await rows(page)).toEqual([]);
});
test("@production late Option current-read response after navigation cannot restore abandoned detail", async ({
  page,
}) => {
  const original = seed();
  await sources(page, original);
  let arrived: () => void = () => undefined,
    release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
      arrived = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  await page.route("**/merchant/catalog/option-sets/current-editor", async (route) => {
    arrived();
    await held;
    try {
      await send(route, {
        profile: "CatalogOptionSetCurrentEditorResultV1",
        ...scope,
        ...original,
      });
    } catch {
      /* navigation cancelled the original HTTP read */
    }
  });
  await page.goto(`/app/commerce/option-sets/${id(10)}`);
  await started;
  await page.getByRole("link", { name: "Back to Option Sets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Option Sets", exact: true })).toBeVisible();
  release();
  await expect(
    page.getByRole("table", { name: "Current Option Set authoring records" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Option Set detail", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("form", { name: "Complete Option Set Draft", exact: true }),
  ).toHaveCount(0);
});

test("@production confirmed Option Create retains durable original through failed current refresh until explicit committed recovery", async ({
  page,
}) => {
  const s = await sources(page);
  s.currentReadError = true;
  await page.goto("/app/commerce/option-sets/new");
  await fillCreate(page);
  await page.getByRole("button", { name: "Create Option Set", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unavailable" })).toBeVisible();
  expect(s.current?.content.sourceAggregate.aggregateVersion).toBe(1);
  expect(s.writes).toHaveLength(1);
  const pending = await rows(page);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.operationReference).toBe(
    JSON.parse(s.writes[0]?.body ?? "{}").operationReference,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resolve original operation", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Create Option Set", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Retry exact original request", exact: true }),
  ).toBeDisabled();
  expect(await rows(page)).toEqual(pending);
  expect(s.writes).toHaveLength(1);
  expect(s.resolves).toBe(0);
  s.currentReadError = false;
  await page.getByRole("button", { name: "Resolve original operation", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original committed save recovered" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic choices", exact: true })).toBeVisible();
  expect(await rows(page)).toEqual([]);
  expect(s.writes).toHaveLength(1);
  expect(s.reads).toBe(2);
  await expect(page.getByRole("button", { name: "Create Option Set", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save complete Draft", exact: true }),
  ).toBeDisabled();
});

const publicationPanel = (page: Page) =>
  page.getByRole("region", { name: "Option Set publication", exact: true });
async function confirmPublication(page: Page) {
  await publicationPanel(page)
    .getByLabel("I have reviewed the saved Draft and confirm the selected action", { exact: true })
    .check();
}
async function openSaved(page: Page, edit = false) {
  await page.goto("/app/commerce/option-sets/" + id(10) + (edit ? "/edit" : ""));
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeEnabled();
}
test("@production ordinary Option Validate → Submit → independent actor Approve → Publish successor", async ({
  page,
}) => {
  const s = await sources(page, seed());
  await openSaved(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Validate saved Draft", exact: true })
    .click();
  await expect(page.getByLabel("Actual publication validation", { exact: true })).toBeVisible();
  expect(s.publicationWrites).toEqual([]);
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Submit saved Draft for review", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText(
    "Original SubmitReview committed",
  );
  expect(s.publicationReview?.operationReference).not.toBe(s.publishingReviewOperationReference);
  await confirmPublication(page);
  await expect(
    publicationPanel(page).getByRole("button", {
      name: "Approve as independent actor",
      exact: true,
    }),
  ).toBeDisabled();
  expect(await publicationRows(page)).toEqual([]);
  s.actor = id(5);
  await page.reload();
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeEnabled();
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Approve as independent actor", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText(
    "Original Approve committed",
  );
  expect(s.publicationApproval?.approvedActorReference).toBe(id(5));
  expect(s.publicationApproval?.approvedActorReference).not.toBe(
    s.publicationReview?.actorReference,
  );
  s.actor = scope.actorReference;
  await page.reload();
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeEnabled();
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Publish saved Draft", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText(
    "Original Publish committed",
  );
  expect(s.publicationWrites.map((w) => w.action)).toEqual(["SubmitReview", "Approve", "Publish"]);
  expect(s.publicationLifecycle?.state).toBe("Published");
  expect(s.publicationRelease?.snapshotReference).toBe(id(11));
  expect(s.current?.content.sourceAggregate.aggregateVersion).toBe(2);
  expect(s.current?.content.sourceAggregate.draft.versionReference).not.toBe(id(11));
  await expect(publicationPanel(page)).toContainText("No Review recorded for this current Draft");
  expect(await publicationRows(page)).toEqual([]);
  expect(await rows(page)).toEqual([]);
});
for (const outcome of ["Committed", "Abandoned"] as const)
  test(
    "@production original publication " +
      outcome +
      " reload/denied Resolve retains durable identity",
    async ({ page }) => {
      const s = await sources(page, seed());
      await openSaved(page, true);
      s.publicationMode = outcome === "Committed" ? "CommitUnknown" : "AbsentUnknown";
      await confirmPublication(page);
      await publicationPanel(page)
        .getByRole("button", { name: "Submit saved Draft for review", exact: true })
        .click();
      await expect(publicationPanel(page).getByRole("status")).toContainText("OutcomeUnknown");
      const original = await publicationRows(page);
      expect(original).toHaveLength(1);
      await expect(
        page.getByRole("button", { name: "Save complete Draft", exact: true }),
      ).toBeDisabled();
      await page.reload();
      await expect(
        publicationPanel(page).getByRole("button", {
          name: "Resolve original publication",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        publicationPanel(page).getByRole("button", {
          name: "Retry exact original publication",
          exact: true,
        }),
      ).toBeDisabled();
      expect(s.publicationWrites).toHaveLength(1);
      expect(await publicationRows(page)).toEqual(original);
      s.publicationResolveDenied = true;
      await publicationPanel(page)
        .getByRole("button", { name: "Resolve original publication", exact: true })
        .click();
      await expect(publicationPanel(page).getByRole("status")).toContainText("Denied");
      expect(await publicationRows(page)).toEqual(original);
      const allocation = s.publicationAllocation;
      s.publicationResolveDenied = false;
      await publicationPanel(page)
        .getByRole("button", { name: "Resolve original publication", exact: true })
        .click();
      await expect(publicationPanel(page).getByRole("status")).toContainText(
        outcome === "Committed"
          ? "Original SubmitReview committed"
          : "Original operation permanently abandoned",
      );
      expect(s.publicationResolves).toHaveLength(2);
      expect(s.publicationResolves[0]).toBe(s.publicationResolves[1]);
      expect(s.publicationAllocation).toBe(allocation);
      expect(s.publicationWrites).toHaveLength(1);
      expect(await publicationRows(page)).toEqual([]);
      await expect(page.getByLabel("Option Set names en-CA", { exact: true })).toBeEnabled();
    },
  );
test("@production dirty Draft blocks publication; actual Disabled and conflict retain original", async ({
  page,
}) => {
  const s = await sources(page, seed());
  await openSaved(page, true);
  await page.getByLabel("Option Set names en-CA", { exact: true }).fill("Synthetic unsaved change");
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeDisabled();
  await expect(
    publicationPanel(page).getByRole("button", {
      name: "Submit saved Draft for review",
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Discard unsaved fields", exact: true }).click();
  await confirmPublication(page);
  s.publicationMode = "Disabled";
  await publicationPanel(page)
    .getByRole("button", { name: "Submit saved Draft for review", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText("Disabled");
  expect(s.publicationWrites).toEqual([]); // actual fresh action context denies before durable dispatch
  s.publicationMode = "Conflict";
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Submit saved Draft for review", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText("Conflict");
  expect(await publicationRows(page)).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Save complete Draft", exact: true }),
  ).toBeDisabled();
  expect(s.publicationReview).toBeNull();
  expect(s.publicationWrites).toHaveLength(1);
  const original = await publicationRows(page);
  s.publicationMode = "Denied";
  await publicationPanel(page)
    .getByRole("button", { name: "Retry exact original publication", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText("Denied");
  expect(s.publicationWrites).toHaveLength(2);
  expect(s.publicationWrites[0]?.body).toBe(s.publicationWrites[1]?.body);
  expect(await publicationRows(page)).toEqual(original);
});

test("@production unknown original Draft save also blocks publication through reload", async ({
  page,
}) => {
  const s = await sources(page, seed());
  await openSaved(page, true);
  await page.getByLabel("Option Set names en-CA", { exact: true }).fill("Synthetic pending Draft");
  await page.getByLabel("I reviewed this complete Draft", { exact: false }).check();
  s.createMode = "CommitUnknown";
  await page.getByRole("button", { name: "Save complete Draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "OutcomeUnknown" })).toBeVisible();
  expect(await rows(page)).toHaveLength(1);
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeDisabled();
  expect(s.publicationWrites).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resolve original operation", exact: true }),
  ).toBeEnabled();
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeDisabled();
  expect(s.publicationWrites).toEqual([]);
  expect(s.writes).toHaveLength(1);
});

test("@production ordinary created/edited Option Detail reads original Draft/Frozen, compares and distinguishes current Published from successor", async ({
  page,
}) => {
  const s = await sources(page);
  await page.goto("/app/commerce/option-sets/new");
  await fillCreate(page);
  await page.getByRole("button", { name: "Create Option Set", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original save confirmed" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open current detail", exact: true }).click();
  await page.getByRole("link", { name: "Edit current Draft", exact: true }).click();
  await page.getByLabel("Option Set names en-CA", { exact: true }).fill("Synthetic published edit");
  await page.getByLabel("I reviewed this complete Draft", { exact: false }).check();
  await page.getByRole("button", { name: "Save complete Draft", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Original save confirmed" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open current detail", exact: true }).click();
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeEnabled();
  await publicationPanel(page)
    .getByRole("button", { name: "Validate saved Draft", exact: true })
    .click();
  await expect(page.getByLabel("Actual publication validation", { exact: true })).toBeVisible();
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Submit saved Draft for review", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText(
    "Original SubmitReview committed",
  );
  await confirmPublication(page);
  await expect(
    publicationPanel(page).getByRole("button", {
      name: "Approve as independent actor",
      exact: true,
    }),
  ).toBeDisabled();
  s.actor = id(5);
  await page.reload();
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeEnabled();
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Approve as independent actor", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText(
    "Original Approve committed",
  );
  s.actor = scope.actorReference;
  await page.reload();
  await expect(
    publicationPanel(page).getByRole("button", { name: "Validate saved Draft", exact: true }),
  ).toBeEnabled();
  await confirmPublication(page);
  await publicationPanel(page)
    .getByRole("button", { name: "Publish saved Draft", exact: true })
    .click();
  await expect(publicationPanel(page).getByRole("status")).toContainText(
    "Original Publish committed",
  );
  const history = page.getByRole("region", {
      name: "Option Set history and comparison",
      exact: true,
    }),
    publication = page.getByRole("region", { name: "Current Option Set publication", exact: true });
  await expect(
    publication.getByRole("heading", { name: "Current Published version", exact: true }),
  ).toBeVisible();
  await expect(
    publication.getByRole("region", { name: "Current Published content", exact: true }),
  ).toContainText("Synthetic published edit");
  await expect(publication).toContainText("The editable Draft is separate");
  await expect(publicationPanel(page)).toContainText("No Review recorded for this current Draft");
  await expect(
    history.getByRole("button", { name: "Read revision 1 Draft", exact: true }),
  ).toBeVisible();
  await history.getByRole("button", { name: "Read revision 1 Draft", exact: true }).click();
  const recorded = history.getByRole("region", { name: "Recorded version content", exact: true });
  await expect(
    recorded.getByRole("heading", { name: "Recorded Draft content", exact: true }),
  ).toBeVisible();
  await expect(recorded).toContainText("Synthetic choices");
  await expect(recorded).not.toContainText("Synthetic published edit");
  await expect(recorded).toContainText("UTC");
  await history.getByRole("button", { name: "Read revision 3 Frozen", exact: true }).click();
  await expect(
    recorded.getByRole("heading", { name: "Recorded Frozen content", exact: true }),
  ).toBeVisible();
  await expect(recorded).toContainText("Synthetic published edit");
  await expect(recorded).toContainText(
    "Frozen content alone does not establish a Published release",
  );
  const left = history.getByRole("combobox", { name: "Left version", exact: true }),
    right = history.getByRole("combobox", { name: "Right version", exact: true });
  const leftValue = await left
      .locator("option")
      .filter({ hasText: "Revision 1 · Draft" })
      .getAttribute("value"),
    rightValue = await right
      .locator("option")
      .filter({ hasText: "Revision 3 · Frozen" })
      .getAttribute("value");
  if (!leftValue || !rightValue) throw Error("actual history choices absent");
  await left.selectOption(leftValue);
  await right.selectOption(rightValue);
  await history.getByRole("button", { name: "Compare selected versions", exact: true }).click();
  await expect(
    history.getByRole("region", { name: "Recorded content comparison", exact: true }),
  ).toContainText("Synthetic published edit");
  await expect(history).toContainText("SubmitReview");
  await expect(history).toContainText("Approve");
  await expect(history).toContainText("Publish");
  expect(s.current?.content.sourceAggregate.aggregateVersion).toBe(3);
  expect(s.frozen?.content.editorContent.sourceAggregate.aggregateVersion).toBe(2);
  expect(s.publicationWrites.map((w) => w.action)).toEqual(["SubmitReview", "Approve", "Publish"]);
  expect(await rows(page)).toEqual([]);
  expect(await publicationRows(page)).toEqual([]);
  // History failure cannot conceal independently authorized current publication.
  s.historyDenied = true;
  await history.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(history.getByRole("alert").first()).toContainText(
    "You do not have permission to read this history",
  );
  await expect(
    publication.getByRole("heading", { name: "Current Published version", exact: true }),
  ).toBeVisible();
  s.historyDenied = false;
  s.historyConflict = true;
  await history.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(history.getByRole("alert").first()).toContainText("The recorded source changed");
  s.historyConflict = false;
  await history.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(
    history.getByRole("button", { name: "Read revision 3 Frozen", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const refresh = history.getByRole("button", { name: "Refresh history", exact: true });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    history.getByRole("button", { name: "Read revision 3 Frozen", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("@production late original-Actor Option history response cannot refill newly authenticated Detail", async ({
  page,
}) => {
  const s = await sources(page, seed());
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false,
    delivered = false;
  await page.route("**/merchant/catalog/option-sets/history", async (route) => {
    const body = route.request().postDataJSON();
    if (!entered && body.action === "List") {
      entered = true;
      await pending;
      // This intentionally late closed denial belongs to the old identity.
      await send(route, { error: "request_denied" }, 403).catch(() => undefined);
      delivered = true;
      expect(body.action).toBe("List");
    } else await route.fallback();
  });
  await openSaved(page);
  await expect.poll(() => entered).toBe(true);
  s.actor = id(5);
  await page.reload();
  const history = page.getByRole("region", {
    name: "Option Set history and comparison",
    exact: true,
  });
  await expect(
    history.getByRole("button", { name: "Read revision 1 Draft", exact: true }),
  ).toBeVisible();
  release();
  await expect.poll(() => delivered).toBe(true);
  await expect(history.getByRole("alert")).toHaveCount(0);
  await history.getByRole("button", { name: "Read revision 1 Draft", exact: true }).click();
  await expect(
    history.getByRole("region", { name: "Recorded version content", exact: true }),
  ).toContainText("Synthetic full configuration");
  expect(s.writes).toEqual([]);
  expect(s.publicationWrites).toEqual([]);
});

// Controlled prior immutable history, not ordinary HTTP/IAM write evidence.
// Every row is produced by the same complete owning Edit materializer used above.
function appendSyntheticHistoricalDraft(s: Awaited<ReturnType<typeof sources>>, index: number) {
  const c = s.current;
  if (!c) throw Error("synthetic history baseline absent");
  const r = c.content.sourceAggregate,
    d = r.draft,
    codeFor = (reference: string) => {
      const option = d.options.find((o) => o.optionReference === reference);
      if (!option) throw Error("synthetic original conflict reference absent");
      return option.stableCode;
    };
  const at = parseCatalogInstant(new Date(Date.now() - 20_000 + index).toISOString()),
    op = id(3000 + index);
  const command = {
    optionSetReference: r.optionSetReference,
    expectedAggregateVersion: r.aggregateVersion,
    operationReference: op,
    occurredAt: at,
    reasonCode: "AUTHORIZED_OPERATION",
    archiveOptionReferences: [],
    draft: {
      defaultLocale: d.defaultLocale,
      localizedNames: { "en-CA": "Synthetic historical revision " + (r.aggregateVersion + 1) },
      localizedDescriptions: d.localizedDescriptions,
      displayStyle: d.displayStyle,
      minimumSelection: d.minimumSelection,
      maximumSelection: d.maximumSelection,
      allowRepeatedOption: d.allowRepeatedOption,
      perOptionMaximumQuantity: d.perOptionMaximumQuantity,
      maximumTotalQuantity: d.maximumTotalQuantity,
      options: d.options.map((o) => ({
        identity: { kind: "Existing", optionReference: o.optionReference },
        stableCode: o.stableCode,
        lifecycle: o.lifecycle,
        localizedNames: o.localizedNames,
        localizedDescriptions: o.localizedDescriptions,
        sortOrder: o.sortOrder,
        defaultEligible: o.defaultEligible,
        triggeredOptionSetReference: o.triggeredOptionSetReference,
        conflictOptionCodes: o.conflictOptionReferences.map(codeFor),
      })),
    },
    additionalContent: {
      profile: c.content.profile,
      optionDetails: c.content.optionDetails.map((detail) => {
        const { optionReference, ...fields } = detail;
        return { stableCode: codeFor(optionReference), ...fields };
      }),
      conditionalRules: c.content.conditionalRules,
      conflictRules: c.content.conflictRules,
      scopeSet: c.content.scopeSet,
      effectivePeriod: c.content.effectivePeriod,
    },
  };
  const source = materializeFullOptionSetEdit(command, c.content, {
    actorReference: s.actor,
    newOptions: [],
  });
  s.current = source;
  s.sourceOperationReference = op;
  s.draftHistory.set(op, {
    source,
    action: "ReplaceDraft",
    intentDigest: hash(command),
    occurredAt: at,
  });
}
test("@production actual immutable Option roster pagination rejects changed root and explicit Refresh resets anchor", async ({
  page,
}) => {
  const s = await sources(page, seed());
  for (let index = 0; index < 21; index++) appendSyntheticHistoricalDraft(s, index);
  await openSaved(page);
  const history = page.getByRole("region", {
    name: "Option Set history and comparison",
    exact: true,
  });
  await expect(
    history.getByRole("button", { name: "Read revision 22 Draft", exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("button", { name: "Read revision 1 Draft", exact: true }),
  ).toHaveCount(0);
  await history.getByRole("button", { name: "Load older versions", exact: true }).click();
  await expect(
    history.getByRole("button", { name: "Read revision 1 Draft", exact: true }),
  ).toBeVisible();
  const pageRequest = s.historyRequests
    .map((v) => JSON.parse(v))
    .find((v) => v.action === "List" && v.command.before);
  expect(pageRequest.command.expectedAggregateVersion).toBe(22);
  expect(pageRequest.command.before.resultAggregateVersion).toBe(3);
  await history.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(
    history.getByRole("button", { name: "Load older versions", exact: true }),
  ).toBeVisible();
  appendSyntheticHistoricalDraft(s, 22);
  await history.getByRole("button", { name: "Load older versions", exact: true }).click();
  await expect(history.getByRole("alert").first()).toContainText("The recorded source changed");
  await expect(
    history.getByRole("button", { name: "Read revision 1 Draft", exact: true }),
  ).toHaveCount(0);
  await history.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(
    history.getByRole("button", { name: "Read revision 23 Draft", exact: true }),
  ).toBeVisible();
  expect(s.writes).toEqual([]);
  expect(s.publicationWrites).toEqual([]);
  expect(await rows(page)).toEqual([]);
  expect(await publicationRows(page)).toEqual([]);
});
