import { canonicalizeRfc8785 } from "../../../packages/bop/audit/src/index.js";
import {
  materializeFullOptionSetCreation,
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogInstant,
  parseProductVersion as parseOwningProductVersion,
  parseCatalogOptionSetEditorContent,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createPublishingReleaseRecord,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parseReleaseSequence,
} from "../../../packages/bop/publishing/src/index.js";
import {
  digest as publicationDigest,
  seal as sealPublication,
  none as noReplacement,
} from "../src/product-publication-v2-test-fixtures.js";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
// WP-2423 pilot: /app/commerce/products and /app/commerce/option-sets are served by the Store
// back-office pages (ProductPages, StoreOptionSetPages). The WP-2421 pages this spec drives are not
// routed during the pilot; the spec returns with those pages on expansion (WP-2423 "可绕过").
test.skip(true, "WP-2423 pilot: the WP-2421 pages this spec drives are not routed");
const id = (n: number) => `01902439-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = "sha256:" + "1".repeat(64),
  store = { brandLabel: "Synthetic Brand", storeLabel: "Synthetic Store", storeReference: id(3) };
type Mode =
  | "Records"
  | "Empty"
  | "NoOverlaps"
  | "Denied"
  | "WrongScope"
  | "WrongRoot"
  | "Eligibility"
  | "Slow";
const publicationRoots = new WeakMap<Page, () => number>();
const publicationRecordCounts = new WeakMap<Page, () => number>();
function nativeLocalDateTime(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(value);
  if (!match?.[1]) throw Error("Synthetic local date-time must use the fixed supported shape");
  const seconds = match[2] ?? "00",
    fraction = (match[3] ?? "").replace(/0+$/u, "");
  return (
    match[1] +
    (seconds === "00" && fraction === "" ? "" : `:${seconds}${fraction ? "." + fraction : ""}`)
  );
}
// Browser API scopes and admissions below are controlled synthetic fixtures.
// Actual public Catalog creation/seal and Publishing release constructors supply
// all selected version/Option identities and digests; this is not native IAM/PG.
function bindingOptionSources() {
  const at = parseCatalogInstant(new Date(Date.now() - 1000).toISOString()),
    created = materializeFullOptionSetCreation(
      {
        internalCode: "SYNTH_EXTRAS",
        operationReference: id(500),
        occurredAt: at,
        reasonCode: "AUTHORIZED_OPERATION",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic available extras" },
          localizedDescriptions: {},
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 3,
          allowRepeatedOption: true,
          perOptionMaximumQuantity: 3,
          maximumTotalQuantity: 3,
          options: [
            {
              stableCode: "EXTRA",
              lifecycle: "Active",
              localizedNames: { "en-CA": "Synthetic extra" },
              localizedDescriptions: {},
              sortOrder: 0,
              defaultEligible: true,
              triggeredOptionSetReference: null,
              conflictOptionCodes: [],
            },
            {
              stableCode: "SECOND",
              lifecycle: "Active",
              localizedNames: { "en-CA": "Synthetic second extra" },
              localizedDescriptions: {},
              sortOrder: 1,
              defaultEligible: false,
              triggeredOptionSetReference: null,
              conflictOptionCodes: [],
            },
          ],
        },
        additionalContent: {
          profile: "CatalogOptionSetEditorContentV1",
          optionDetails: ["EXTRA", "SECOND"].map((stableCode) => ({
            stableCode,
            quantityRule: { minimumQuantity: 0, maximumQuantity: 3 },
            media: null,
            pricingRule: null,
            consumption: null,
            triggeredOptionSetVersionReference: null,
          })),
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
        brandReference: id(2),
        actorReference: id(5),
        allocations: {
          optionSetReference: id(43),
          versionReference: id(44),
          options: [
            { stableCode: "EXTRA", optionReference: id(501) },
            { stableCode: "SECOND", optionReference: id(502) },
          ],
        },
      },
    );
  const seal = (full: typeof created, operation: number, nextVersion: number, clock: typeof at) => {
    const { sourceAggregate, ...additional } = full.content;
    return createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, additional, {
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: sourceAggregate.optionSetReference,
      versionReference: sourceAggregate.draft.versionReference,
      sourceAggregateVersion: sourceAggregate.aggregateVersion,
      publicationOperationReference: id(operation),
      publicationIntentDigest:
        "sha256:" +
        createHash("sha256")
          .update(canonicalizeRfc8785({ operation, sourceDigest: full.sourceDigest }))
          .digest("hex"),
      successorDraftVersionReference: id(nextVersion),
      sealedAt: clock,
      sourceDigest: full.sourceDigest,
      contentDigest: full.contentDigest,
      configurationDigest: full.configurationDigest,
    });
  };
  const first = seal(created, 503, 504, at),
    secondAt = parseCatalogInstant(new Date(Date.parse(at) + 1).toISOString()),
    { sourceAggregate, ...additional } = first.successorEditorContent,
    next = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
  // The second version is the genuine owner-generated successor, not a changed
  // reference pasted into the first frozen snapshot.
  const second = createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, additional, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(43),
    versionReference: sourceAggregate.draft.versionReference,
    sourceAggregateVersion: sourceAggregate.aggregateVersion,
    publicationOperationReference: id(505),
    publicationIntentDigest:
      "sha256:" +
      createHash("sha256")
        .update(canonicalizeRfc8785({ syntheticSecond: sourceAggregate }))
        .digest("hex"),
    successorDraftVersionReference: id(506),
    sealedAt: secondAt,
    sourceDigest: next.sourceDigest,
    contentDigest: next.contentDigest,
    configurationDigest: next.configurationDigest,
  });
  return { first, second };
}
async function productOptionPickerSources(page: Page) {
  const fixture = bindingOptionSources(),
    state = {
      head: 0,
      denied: false,
      actor: id(5),
      requests: [] as { optionSetReference: string; versionReference: string | null }[],
      prepared: [] as { bindingReference: string; versionReference: string }[],
      allocated: 550,
    };
  const versions = [fixture.first, fixture.second];
  const reply = (route: import("@playwright/test").Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(body),
    });
  await page.route("**/merchant/catalog/products/option-binding-picker", (route) => {
    const command = route.request().postDataJSON();
    state.requests.push(command);
    expect(Object.keys(command).sort()).toEqual(["optionSetReference", "versionReference"].sort());
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    if (state.denied) return reply(route, { error: "request_denied" }, 403);
    const plan =
      command.versionReference === null
        ? versions[state.head]
        : versions.find(
            (v) => v.content.supportedContent.versionReference === command.versionReference,
          );
    if (!plan || command.optionSetReference !== id(43))
      return reply(route, { error: "product_option_picker_unavailable" }, 503);
    const content = plan.content,
      root = content.editorContent.sourceAggregate,
      d = root.draft,
      at = new Date().toISOString();
    const release = createPublishingReleaseRecord({
      releaseId: parsePublishingReference(id(520 + state.head)),
      familyReference: parsePublishingReference(id(43)),
      configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
      purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
      snapshotReference: parsePublishingReference(d.versionReference),
      snapshotDigest: parsePublishingDigest(content.digest),
      scope: createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null }),
      sequence: parseReleaseSequence(state.head + 1),
      sourceLifecycleId: parsePublishingReference(id(530 + state.head)),
      kind: "Publish",
      previousReleaseId: state.head ? parsePublishingReference(id(520)) : null,
      createdAt: parsePublishingInstant(content.supportedContent.sealedAt),
    });
    const bindingReference = id(++state.allocated);
    state.prepared.push({ bindingReference, versionReference: d.versionReference });
    return reply(route, {
      profile: "CatalogProductOptionBindingPickerV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: state.actor,
      optionSetReference: id(43),
      versionReference: d.versionReference,
      bindingReference,
      internalCode: root.internalCode,
      defaultLocale: d.defaultLocale,
      localizedNames: d.localizedNames,
      rootSelectionRule: {
        minimumSelection: d.minimumSelection,
        maximumSelection: d.maximumSelection,
        allowRepeatedOption: d.allowRepeatedOption,
        perOptionMaximumQuantity: d.perOptionMaximumQuantity,
        maximumTotalQuantity: d.maximumTotalQuantity,
        displayStyle: d.displayStyle,
      },
      options: d.options.map((option) => {
        const detail = content.editorContent.optionDetails.find(
          (v) => v.optionReference === option.optionReference,
        );
        if (!detail) throw Error("synthetic actual Option detail absent");
        return {
          optionReference: option.optionReference,
          stableCode: option.stableCode,
          lifecycle: option.lifecycle,
          localizedNames: option.localizedNames,
          sortOrder: option.sortOrder,
          defaultEligible: option.defaultEligible,
          quantityRule: detail.quantityRule,
          selectionDisabled: option.lifecycle === "Archived",
          disabledReason: option.lifecycle === "Archived" ? "OptionArchived" : null,
        };
      }),
      selectionDisabled: root.lifecycle === "Archived",
      disabledReason: root.lifecycle === "Archived" ? "OptionSetArchived" : null,
      originalRecordDigest: content.digest,
      sourceDigest: content.sourceDigest,
      contentDigest: content.contentDigest,
      configurationDigest: content.configurationDigest,
      sourceAuthority:
        command.versionReference === null
          ? "CurrentPublishingReleaseAndFrozenContent"
          : "RecordedFrozen",
      publicationReference: command.versionReference === null ? release.releaseId : null,
      referenceEligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      observedAt: at,
      validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    });
  });
  await page.route("**/merchant/catalog/option-sets/list", (route) => {
    const filters = route.request().postDataJSON(),
      at = new Date().toISOString(),
      plan = versions[state.head];
    if (!plan) throw Error("synthetic selected actual version absent");
    const r = plan.successorEditorContent.sourceAggregate,
      d = r.draft;
    const presence = { status: "Known", present: false };
    return reply(route, {
      projection: {
        name: "catalog_option_set_search_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
        sourceGeneration:
          "sha256:" + createHash("sha256").update(canonicalizeRfc8785(r)).digest("hex"),
      },
      scope: {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: state.actor,
      },
      locale: filters.locale,
      items: [
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
          recordedPricingReference: presence,
          recordedConsumptionReference: presence,
          recordedConflict: presence,
          publishingStatus: { status: "Unavailable" },
          referenceEligibility: "NotEvaluated",
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });
  return state;
}

async function sources(page: Page) {
  const picker = await productOptionPickerSources(page);
  const control = {
    picker,
    mode: "Records" as Mode,
    disabled: false,
    journals: 0,
    scopes: [] as unknown[],
    release: undefined as undefined | (() => void),
    relation: "IncomingSelectorPreferred" as
      "IncomingSelectorPreferred" | "ExistingSelectorPreferred" | "EqualPrecedenceOverlap",
  };
  await page.route("**/merchant/catalog/products/selling-units/context", async (route) => {
    const request = route.request().postDataJSON() as { action: string };
    const at = new Date().toISOString();
    await route.fulfill({
      status: control.disabled ? 403 : 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(
        control.disabled
          ? { error: "request_denied" }
          : {
              profile: "CatalogSellingUnitRegistrationContextV1",
              action: request.action,
              tenantReference: id(1),
              brandReference: id(2),
              storeReference: id(3),
              actorReference: id(5),
              observedAt: at,
              validUntil: new Date(Date.parse(at) + 5000).toISOString(),
            },
      ),
    });
  });
  await page.route("**/merchant/catalog/products/authoring-context", async (route) => {
    const request = route.request().postDataJSON() as { action: string };
    const at = new Date().toISOString();
    await route.fulfill({
      status: control.disabled ? 403 : 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(
        control.disabled
          ? { error: "request_denied" }
          : {
              profile: "CatalogProductAuthoringContextV1",
              action: request.action,
              tenantReference: id(1),
              brandReference: id(2),
              storeReference: id(3),
              actorReference: id(5),
              observedAt: at,
              validUntil: new Date(Date.parse(at) + 5000).toISOString(),
            },
      ),
    });
  });
  await page.route("**/merchant/session", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        authenticated: true,
        csrf: "c".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: store,
          authorizedStores: [store],
          navigation: [
            {
              screenId: "CAT-PRODUCT-LIST",
              href: "/app/commerce/products",
              label: "Products",
              permission: "catalog.manage",
            },
          ],
          businessDate: "2026-09-30",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      }),
    }),
  );
  await page.route("**/merchant/catalog/products", async (route) => {
    const unavailable = { status: "Unavailable" },
      at = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        projection: {
          name: "catalog_product_search_v1",
          version: 1,
          asOfUtc: at,
          stale: false,
          partial: true,
        },
        scope: { brandReference: id(2), storeReference: id(3) },
        locale: "en-CA",
        hasMore: false,
        nextCursor: null,
        items: [
          {
            productReference: id(4),
            internalCode: "SYNTH_TEA",
            name: "Synthetic tea",
            nameLocale: "en-CA",
            localeFallback: false,
            productType: "PreparedFood",
            lifecycle: "Active",
            aggregateVersion: publicationRoots.get(page)?.() ?? 7,
            updatedAt: at,
            createdAt: at,
            source: { productVersionReference: id(10), configuration: "Draft" },
            skuCount: 1,
            activeSkuCount: 0,
            category: unavailable,
            menuCount: unavailable,
            availability: unavailable,
            storeCoverage: unavailable,
            tax: unavailable,
            updatedBy: unavailable,
          },
        ],
      }),
    });
  });
  await page.route("**/merchant/store-capability", async (route) => {
    const body = route.request().postDataJSON() as { capabilityKey: string };
    expect(["catalog.cat_product_edit", "catalog.cat_product_create"]).toContain(
      body.capabilityKey,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        brandReference: id(2),
        storeReference: id(3),
        capabilityKey: body.capabilityKey,
        controlKey:
          body.capabilityKey === "catalog.cat_product_create"
            ? "catalog.product.create"
            : "catalog.product.edit",
        backendExecution: control.disabled ? "Deny" : "Allow",
        frontendVisibility: control.disabled ? "Hide" : "Show",
        reason: control.disabled ? "Disabled" : "Enabled",
        source: "StoreOverride",
        controlReference: id(20),
        controlVersion: 1,
        observedAt: new Date().toISOString(),
      }),
    });
  });
  await page.route("**/merchant/catalog/products/publication/scope-journals", async (route) => {
    control.journals++;
    if (publicationRoots.has(page))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "product_scope_journal_unavailable" }),
      });
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    control.scopes.push(
      JSON.parse(
        Buffer.from(route.request().headers()["x-bop-catalog-scope"] ?? "", "base64url").toString(),
      ),
    );
    expect(route.request().postDataJSON()).toEqual({
      productReference: id(4),
      expectedAggregateVersion: 7,
    });
    const mode = control.mode;
    if (mode === "Slow")
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
    if (mode === "Denied")
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      });
    const at = new Date().toISOString(),
      until = new Date(Date.parse(at) + 5000).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductScopeJournalManagementV1",
        tenantReference: id(1),
        brandReference: mode === "WrongScope" ? id(99) : id(2),
        productReference: id(4),
        aggregateVersion: mode === "WrongRoot" ? 8 : 7,
        sourceDigest: hash,
        observedAt: at,
        validUntil: until,
        coverage: "CompleteRecordedScopeJournalCoverage",
        eligibility: mode === "Eligibility" ? "Eligible" : "NotEvaluated",
        currentDisposition: "NotEvaluated",
        digest: hash,
        versions:
          mode === "Empty"
            ? []
            : [
                {
                  versionReference: id(10),
                  currentPublicationVersion: 2,
                  currentState: "Published",
                  originalPublicationOperationReference: id(11),
                  recordStatus: "Recorded",
                  journal: {
                    digest: hash,
                    sourceHeadDigest: hash,
                    sourceAggregateVersion: 3,
                    policyReference: id(5),
                    policyVersion: 1,
                    policyEvidenceReference: id(6),
                    recordedAt: "2026-09-29T12:00:00.000Z",
                    originalEvidenceValidUntil: "2026-09-29T12:00:05.000Z",
                    relations:
                      mode === "NoOverlaps"
                        ? []
                        : [
                            {
                              previousVersionReference: id(12),
                              previousOperationReference: id(13),
                              previousIntentDigest: hash,
                              previousScopeDigest: hash,
                              previousSelectorIndex: 0,
                              incomingSelectorIndex: 1,
                              storeReference: id(3),
                              channelCodes: [],
                              orderTypeCodes: ["PICKUP"],
                              effectiveFrom: "2026-09-29T12:00:00.000Z",
                              effectiveUntil: null,
                              relation: control.relation,
                            },
                          ],
                  },
                },
                {
                  versionReference: id(12),
                  currentPublicationVersion: 1,
                  currentState: "Superseded",
                  originalPublicationOperationReference: id(13),
                  recordStatus: "NotRecorded",
                  journal: null,
                },
                {
                  versionReference: id(14),
                  currentPublicationVersion: 1,
                  currentState: "Draft",
                  originalPublicationOperationReference: null,
                  recordStatus: "NotApplicable",
                  journal: null,
                },
              ],
      }),
    });
  });
  return control;
}
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh publication history" });
async function enter(page: Page) {
  await page.goto("/app/commerce/products");
  await expect(
    page.getByText("Synthetic tea", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  const root = publicationRoots.get(page),
    count = publicationRecordCounts.get(page);
  if (root && count) {
    await expect(page.locator("#publication-request-result")).toContainText(
      `Current publication records loaded · Revision ${root()}.`,
    );
    const history = page.getByRole("region", { name: "Publication scope history", exact: true });
    await expect(history.getByRole("status")).toHaveText(
      `Recorded publication history · Revision ${root()}. Current sale eligibility has not been evaluated.`,
    );
    await expect(history.getByRole("heading", { name: /^Version record /u })).toHaveCount(count());
    if (count() === 0)
      await expect(
        history.getByText("No publication history is recorded for this revision.", { exact: true }),
      ).toBeVisible();
  } else {
    await expect(page.getByText("3 version records loaded.")).toBeVisible();
  }
}
test("@production ordinary Product history entry, keyboard, responsive records and expiry recovery", async ({
  page,
  context,
}) => {
  const control = await sources(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await enter(page);
  await expect(page).toHaveURL(`/app/commerce/products/${id(4)}/edit`);
  await expect(
    page.getByText("Original scope record was not recorded for this publication."),
  ).toBeVisible();
  await expect(
    page.getByText("Scope recording is not applicable to this unpublished version."),
  ).toBeVisible();
  await expect(page.getByText(/Historical evidence/)).toBeVisible();
  const summary = page.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/against version record 2/)).toBeVisible();
  await expect(
    page.getByText(
      "Scope entry 2 in this version: this entry was preferred against version record 2, scope entry 1.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Recorded intersection:", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Product revision", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(refresh(page)).toBeFocused();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/private/tmp/wp2421-product-scope-history-${width}.png`,
      fullPage: true,
    });
  }
  const text = await page.locator("body").innerText();
  for (const privateValue of [id(1), id(2), id(4), id(5), id(6), id(10), id(11), hash])
    expect(text).not.toContain(privateValue);
  await expect(page.getByText("Publication history stale", { exact: true })).toBeVisible({
    timeout: 7000,
  });
  await expect(page.getByText("Original scope record available.")).toHaveCount(0);
  await refresh(page).click();
  await expect(page.getByText("3 version records loaded.")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "Offline", exact: true })).toBeVisible();
  await expect(page.getByText("Original scope record available.")).toHaveCount(0);
  await expect(refresh(page)).toBeDisabled();
  await context.setOffline(false);
  await expect(refresh(page)).toBeEnabled();
  await refresh(page).click();
  await expect(page.getByText("3 version records loaded.")).toBeVisible();
  control.mode = "Empty";
  await refresh(page).click();
  await expect(
    page.getByText("No publication history is recorded for this revision."),
  ).toBeVisible();
  control.mode = "NoOverlaps";
  await refresh(page).click();
  await expect(page.getByText("No overlaps were recorded at publication.")).toBeVisible();
  await expect(page.getByText("Original scope record available.")).toBeVisible();
  expect(
    control.scopes.every(
      (v) => JSON.stringify(v) === JSON.stringify({ brandReference: id(2), storeReference: id(3) }),
    ),
  ).toBe(true);
});
test("@production recorded overlap phone touch preserves exact scope entries and unresolved equal priority", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Production fixture URL is required");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage(),
      control = await sources(page),
      errors: string[] = [];
    let mutations = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/merchant/catalog/products/publication") mutations++;
    });
    await enter(page);
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    for (const [relation, copy, width] of [
      ["IncomingSelectorPreferred", "this entry was preferred", 390],
      ["ExistingSelectorPreferred", "the previous entry was preferred", 320],
      ["EqualPrecedenceOverlap", "equal priority overlap was recorded", 320],
    ] as const) {
      control.relation = relation;
      await page.setViewportSize({ width, height: 844 });
      if (relation === "EqualPrecedenceOverlap")
        await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      await refresh(page).tap();
      await expect(page.getByText("3 version records loaded.")).toBeVisible();
      const summary = page.locator("summary");
      expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await summary.tap();
      await expect(
        page.getByText(
          `Scope entry 2 in this version: ${copy} against version record 2, scope entry 1.`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Recorded intersection: Selected Store · Channels: All · Order types: PICKUP",
          {
            exact: true,
          },
        ),
      ).toBeVisible();
      await expect(
        page.getByText(/This intersection does not describe either version's remaining scope/),
      ).toBeVisible();
      if (relation === "EqualPrecedenceOverlap")
        await expect(
          page.getByText("No replacement decision is recorded in this relationship.", {
            exact: true,
          }),
        ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const text = await page.locator("body").innerText();
      for (const privateValue of [id(1), id(2), id(3), id(4), id(10), id(11), id(12), id(13), hash])
        expect(text).not.toContain(privateValue);
      await page.screenshot({
        path: `/private/tmp/wp2421-m129-recorded-overlap-${relation}-${width}.png`,
        fullPage: true,
      });
    }
    expect(mutations).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test("@production current permission and source failures clear Product records; disabled capability hides entry", async ({
  page,
}) => {
  const control = await sources(page);
  await enter(page);
  for (const [mode, heading] of [
    ["Denied", "Permission denied"],
    ["WrongScope", "Product scope changed"],
    ["WrongRoot", "Publication history stale"],
    ["Eligibility", "Publication history unavailable"],
  ] as const) {
    control.mode = mode;
    await refresh(page).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("Original scope record available.")).toHaveCount(0);
    control.mode = "Records";
    await refresh(page).click();
    await expect(page.getByText("3 version records loaded.")).toBeVisible();
  }
  control.disabled = true;
  const count = control.journals;
  await refresh(page).click();
  await expect(
    page.getByRole("heading", { name: "Product management disabled", exact: true }),
  ).toBeVisible();
  expect(control.journals).toBe(count);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await expect(page.getByText("Synthetic tea", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Publication history", exact: true })).toHaveCount(0);
  control.disabled = false;
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Publication history", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Publication history", exact: true })).toHaveCount(
    0,
    { timeout: 7000 },
  );
});
test("@production direct Product route requires revision; cancelled response cannot restore old records", async ({
  page,
}) => {
  const control = await sources(page);
  await page.goto(`/app/commerce/products/${id(4)}/edit`);
  await expect(
    page.getByRole("heading", { name: "Choose a Product revision", exact: true }),
  ).toBeVisible();
  expect(control.journals).toBe(0);
  const revision = page.getByRole("textbox", { name: "Product revision", exact: true });
  await revision.fill("0");
  await refresh(page).click();
  await expect(
    page.getByRole("heading", { name: "Invalid Product revision", exact: true }),
  ).toBeVisible();
  expect(control.journals).toBe(0);
  await revision.fill("7");
  await refresh(page).click();
  await expect(page.getByText("3 version records loaded.")).toBeVisible();
  control.mode = "Slow";
  await refresh(page).click();
  await expect.poll(() => Boolean(control.release)).toBe(true);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  control.release?.();
  await expect(page.getByText("Synthetic tea", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Original scope record available.")).toHaveCount(0);
  await page.goto(`/app/commerce/products/${id(99)}/edit`);
  await expect(
    page.getByRole("heading", { name: "Choose a Product revision", exact: true }),
  ).toBeVisible();
  expect(control.journals).toBe(2);
});

// Complete-current content presentation; all intercepted HTTP authorities are
// synthetic. Actual runtime/session/permissions/SQL is milestone42 evidence.
function currentEditorFixture(at: string, legacy = false) {
  const details = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: { "en-CA": "Synthetic short copy" },
    localizedDescriptions: { "en-CA": "Synthetic complete description\nSynthetic second line" },
    preparationNotes: { "en-CA": "Synthetic preparation note" },
    tagReferences: [id(31)],
    attributeValues: [
      { attributeReference: id(32), type: "Decimal", value: "1.25", unitCode: "KG" },
    ],
    media: [
      {
        mediaReference: id(33),
        assetReference: id(34),
        assetVersionReference: id(35),
        role: "Primary",
        altText: { "en-CA": "Synthetic image alt text" },
        sortOrder: 0,
        cropReference: null,
        focusReference: null,
      },
    ],
    variantDimensions: [
      {
        dimensionReference: id(36),
        code: "SIZE",
        localizedNames: { "en-CA": "Synthetic size" },
        sortOrder: 0,
        selectionRequirement: "Required",
        values: [
          {
            valueReference: id(37),
            code: "SMALL",
            localizedNames: { "en-CA": "Synthetic small" },
            sortOrder: 0,
            attributeReference: null,
            mediaReference: null,
          },
        ],
      },
    ],
    variantCombinations: [
      {
        selections: [{ dimensionReference: id(36), valueReference: id(37) }],
        disposition: "Valid",
        skuReference: id(38),
      },
    ],
    optionRules: [
      {
        bindingReference: id(39),
        versionResolution: "Pinned",
        pricingRule: null,
        conditionalRule: null,
        conflictRule: null,
        variantCondition: [],
      },
    ],
    allergenReferences: [id(40)],
    nutritionProfile: { reference: id(41), versionReference: id(42) },
  };
  return {
    profile: "CatalogProductEditorSnapshotV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: 7,
    aggregate: {
      productReference: id(4),
      brandReference: id(2),
      internalCode: "SYNTH_TEA",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 7,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(5),
      draft: {
        versionReference: id(14),
        baseVersionReference: id(10),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic full current Product" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        skus: [
          {
            skuReference: id(38),
            productReference: id(4),
            brandReference: id(2),
            skuCode: "SYNTH_SMALL",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Synthetic small SKU" },
            variantSelections: [{ dimensionReference: id(36), valueReference: id(37) }],
            unitOfSale: "EA",
            unitQuantity: "1",
            createdAt: at,
            createdByActorReference: id(5),
          },
        ],
        optionBindings: [
          {
            bindingReference: id(39),
            optionSetReference: id(43),
            optionSetVersionReference: id(44),
            purpose: "SELECT",
            sortOrder: 0,
            enabledOptionReferences: [],
            defaultSelections: [],
            minimumSelectionOverride: 0,
            maximumSelectionOverride: 1,
            includedSkuReferences: [],
            excludedSkuReferences: [],
            channelCodes: ["WEB"],
            storeOverrideAllowed: false,
          },
        ],
        ...(legacy ? {} : { editorContent: details }),
      },
    },
    contentDigest: hash,
    configurationDigest: hash,
    contentStatus: legacy ? "Unavailable" : "Present",
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  };
}
function editorCanonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(editorCanonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + editorCanonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
async function currentContentSource(page: Page) {
  const control = { mode: "Current", calls: 0, release: undefined as undefined | (() => void) };
  await page.route("**/merchant/catalog/products/editor", async (route) => {
    control.calls++;
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().postDataJSON()).toEqual({
      productReference: id(4),
      expectedAggregateVersion: 7,
    });
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(
      JSON.parse(
        Buffer.from(route.request().headers()["x-bop-catalog-scope"] ?? "", "base64url").toString(),
      ),
    ).toEqual({ brandReference: id(2), storeReference: id(3) });
    const mode = control.mode;
    if (mode === "Slow")
      await new Promise<void>((r) => {
        control.release = r;
      });
    if (mode === "Denied" || mode === "Missing")
      return route.fulfill({
        status: mode === "Denied" ? 403 : 503,
        headers: { "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({
          error: mode === "Denied" ? "request_denied" : "product_editor_unavailable",
        }),
      });
    const body = currentEditorFixture(new Date().toISOString(), mode === "Legacy");
    if (mode === "WrongScope") body.brandReference = id(99);
    if (mode === "WrongRoot") body.aggregateVersion = 8;
    if (mode === "Qualification") body.eligibility = "Eligible";
    const digest = "sha256:" + createHash("sha256").update(editorCanonical(body)).digest("hex");
    try {
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ ...body, digest: mode === "BadDigest" ? hash : digest }),
      });
    } catch {
      if (mode !== "Slow") throw Error("Synthetic editor route unexpectedly cancelled");
    }
  });
  return control;
}
const refreshContent = (page: Page) =>
  page.getByRole("button", { name: "Refresh current content", exact: true });
test("@production ordinary current Product content: all groups, keyboard, responsive, expiry/offline and recovery", async ({
  page,
  context,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.name));
  await sources(page);
  await currentContentSource(page);
  await enter(page);
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  for (const text of [
    "Synthetic preparation note",
    "Synthetic image alt text",
    "Synthetic small SKU",
    "Dimension 1: SIZE",
    "Binding 1: SELECT",
    "Option rule 1: Pinned",
    "Attribute 1: Decimal · 1.25 KG",
  ])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText(/1 Safety references configured/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Draft", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Current content revision", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(refreshContent(page)).toBeFocused();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/private/tmp/wp2421-product-current-content-${width}.png`,
      fullPage: true,
    });
  }
  await page.locator("html").evaluate((el) => {
    el.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.locator("html").evaluate((el) => {
    el.style.fontSize = "";
  });
  const text = await page.locator("body").innerText();
  for (const n of [1, 2, 4, 5, 10, 14, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
    expect(text).not.toContain(id(n));
  expect(text).not.toContain(hash);
  await expect(
    page.getByRole("heading", { name: "Current content stale", exact: true }),
  ).toBeVisible({ timeout: 7000 });
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toHaveCount(0);
  await refreshContent(page).click();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByRole("heading", { name: "Current content offline", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toHaveCount(0);
  await expect(refreshContent(page)).toBeDisabled();
  await context.setOffline(false);
  await expect(refreshContent(page)).toBeEnabled();
  await refreshContent(page).click();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
});
test("@production current Product source failure clears full content, recovery/legacy/capability remain honest", async ({
  page,
}) => {
  const gate = await sources(page),
    control = await currentContentSource(page);
  await enter(page);
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  for (const [mode, heading] of [
    ["Denied", "Current content permission denied"],
    ["WrongScope", "Current content scope changed"],
    ["WrongRoot", "Current content stale"],
    ["Qualification", "Current content unavailable"],
    ["BadDigest", "Current content unavailable"],
    ["Missing", "Current content unavailable"],
  ] as const) {
    control.mode = mode;
    await refreshContent(page).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic full current Product", { exact: true })).toHaveCount(0);
    control.mode = "Current";
    await refreshContent(page).click();
    await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  }
  control.mode = "Legacy";
  await refreshContent(page).click();
  await expect(
    page.getByText(
      "Complete content was not recorded for this Draft. An empty editable form cannot be supplied.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Synthetic preparation note", { exact: true })).toHaveCount(0);
  control.mode = "Current";
  await refreshContent(page).click();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  // Controlled browser visibility event simulates timer-throttled background entry.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("heading", { name: "Current content stale", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await refreshContent(page).click();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  gate.disabled = true;
  const before = control.calls;
  await refreshContent(page).click();
  await expect(
    page.getByRole("heading", { name: "Current content disabled", exact: true }),
  ).toBeVisible();
  expect(control.calls).toBe(before);
});
test("@production current Product direct route revision and cancelled full source cannot restore old content", async ({
  page,
}) => {
  await sources(page);
  const control = await currentContentSource(page);
  await page.goto(`/app/commerce/products/${id(4)}/edit`);
  await expect(
    page.getByRole("heading", { name: "Choose a current content revision", exact: true }),
  ).toBeVisible();
  expect(control.calls).toBe(0);
  await page.getByRole("textbox", { name: "Current content revision", exact: true }).fill("0");
  await refreshContent(page).click();
  await expect(
    page.getByRole("heading", { name: "Invalid current content revision", exact: true }),
  ).toBeVisible();
  expect(control.calls).toBe(0);
  control.mode = "Slow";
  await page.getByRole("textbox", { name: "Current content revision", exact: true }).fill("7");
  await refreshContent(page).click();
  await expect.poll(() => Boolean(control.release)).toBe(true);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  control.release?.();
  await expect(page).toHaveURL("/app/commerce/products");
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toHaveCount(0);
});

test("@production current Product initially hidden performs no source read until explicit visible recovery", async ({
  page,
}) => {
  await sources(page);
  const content = await currentContentSource(page);
  await page.goto("/app/commerce/products");
  await expect(
    page.getByRole("link", { name: "Publication history", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  });
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Current content stale", exact: true }),
  ).toBeVisible();
  expect(content.calls).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await refreshContent(page).click();
  await expect(page.getByText("Synthetic full current Product", { exact: true })).toBeVisible();
  expect(content.calls).toBe(1);
});

// Ordinary local browser/HTTP only; these current sources and write receipts are synthetic.
async function completeDraftSources(page: Page, initial?: "EmptySku") {
  const gate = await sources(page);
  const createdAt = new Date().toISOString();
  const control = {
    mode: "Current",
    revision: 7,
    draft: null as null | Record<string, unknown>,
    baseline: null as null | ReturnType<typeof currentEditorFixture>["aggregate"]["draft"],
    bodies: [] as string[],
    originals: new Map<
      string,
      { body: string; draft: Record<string, unknown>; aggregateVersion: number }
    >(),
  };
  await page.route("**/merchant/catalog/products/editor", async (route) => {
    const raw = currentEditorFixture(createdAt);
    if (initial === "EmptySku") {
      raw.aggregate.draft.skus = [];
      if (raw.aggregate.draft.editorContent) {
        raw.aggregate.draft.editorContent.variantDimensions = [];
        raw.aggregate.draft.editorContent.variantCombinations = [];
      }
    }
    if (control.baseline === null) control.baseline = structuredClone(raw.aggregate.draft);
    raw.observedAt = new Date().toISOString();
    raw.validUntil = new Date(Date.parse(raw.observedAt) + 5000).toISOString();
    raw.aggregate.updatedAt =
      typeof control.draft?.updatedAt === "string" ? control.draft.updatedAt : createdAt;
    const requested = route.request().postDataJSON() as { expectedAggregateVersion: number };
    expect(requested.expectedAggregateVersion).toBe(control.revision);
    raw.aggregateVersion = control.revision;
    raw.aggregate.aggregateVersion = control.revision;
    if (control.draft) Object.assign(raw.aggregate.draft, control.draft);
    if (control.mode === "Drift")
      raw.aggregate.draft.localizedNames["en-CA"] = "Synthetic owner drift";
    const body = {
      ...raw,
      digest: "sha256:" + createHash("sha256").update(editorCanonical(raw)).digest("hex"),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(body),
    });
  });
  await page.route("**/merchant/catalog/products/draft", async (route) => {
    const text = route.request().postData() ?? "";
    control.bodies.push(text);
    const command = route.request().postDataJSON() as {
      productReference: string;
      operationReference: string;
      expectedAggregateVersion: number;
      draft: Record<string, unknown>;
    };
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(command.productReference).toBe(id(4));
    const prior = control.originals.get(command.operationReference);
    expect(command.expectedAggregateVersion).toBe(
      prior ? prior.aggregateVersion - 1 : control.revision,
    );
    if (prior) expect(text).toBe(prior.body);
    if (control.mode === "Denied") {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      });
      return;
    }
    if (!prior) {
      const next = { ...command.draft, updatedAt: new Date().toISOString() };
      // Actual public Product contract verifies the complete retained candidate.
      parseOwningProductVersion(next);
      control.draft = next;
      control.revision = command.expectedAggregateVersion + 1;
      control.originals.set(command.operationReference, {
        body: text,
        draft: next,
        aggregateVersion: control.revision,
      });
    }
    const receipt = control.originals.get(command.operationReference);
    if (!receipt) throw Error("synthetic original Product receipt absent");
    if (control.mode === "Unknown") {
      control.mode = "Current";
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        status: prior ? "AlreadyApplied" : "Applied",
        scope: { brandReference: id(2), storeReference: id(3) },
        productReference: id(4),
        operationReference: command.operationReference,
        aggregateVersion: receipt.aggregateVersion,
        draft: receipt.draft,
      }),
    });
  });
  await enter(page);
  await page.getByRole("button", { name: "Open Draft editor", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Product Option bindings", exact: true }),
  ).toContainText("Option binding intent is ready for server revalidation.");
  return Object.assign(control, { gate });
}
test("@production complete Draft ordinary text save preserves all tuples, keyboard/mobile and post-save current read", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  const control = await completeDraftSources(page);
  const name = page.getByRole("textbox", { name: "Product name · en-CA", exact: true });
  await expect(page.locator(".product-draft-result")).toBeFocused();
  await name.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("textbox", { name: "Short description · en-CA", exact: true }),
  ).toBeFocused();
  await name.fill("Synthetic intentionally edited");
  await page
    .getByRole("textbox", { name: "Description · en-CA", exact: true })
    .fill("Synthetic changed description");
  await page
    .getByRole("textbox", { name: "Attribute 1 · Decimal · KG", exact: true })
    .fill("-0.25");
  await page
    .getByRole("textbox", { name: "Media 1 alt text · en-CA", exact: true })
    .fill("Synthetic changed alt text");
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  await expect(name).toHaveCount(0);
  const command = JSON.parse(control.bodies[0] ?? "{}") as { draft: Record<string, unknown> };
  const expected = currentEditorFixture(new Date().toISOString()).aggregate.draft.editorContent;
  expect(command.draft.editorContent).toMatchObject({
    tagReferences: expected?.tagReferences,
    variantDimensions: expected?.variantDimensions,
    variantCombinations: expected?.variantCombinations,
    optionRules: expected?.optionRules,
    allergenReferences: expected?.allergenReferences,
    nutritionProfile: expected?.nutritionProfile,
  });
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(name).toHaveValue("Synthetic intentionally edited");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/private/tmp/wp2421-complete-draft-form-${width}.png`,
      fullPage: true,
    });
  }
  await page.locator("html").evaluate((el) => {
    el.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const text = await page.locator("body").innerText();
  for (const n of [1, 2, 4, 5, 10, 14, 31, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
    expect(text).not.toContain(id(n));
  expect(errors).toEqual([]);
});
test("@production complete Draft unknown save holds original bytes across expiry and explicit retry", async ({
  page,
}) => {
  const control = await completeDraftSources(page);
  control.mode = "Unknown";
  await page
    .getByRole("textbox", { name: "Product name · en-CA", exact: true })
    .fill("Synthetic uncertain edit");
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Save result is unknown. Retry the original request before editing or creating another save.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh editable Draft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Discard local edits and reload", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Current content stale", exact: true }),
  ).toBeVisible({ timeout: 7000 });
  await page.getByRole("button", { name: "Retry original Draft save", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies.length).toBe(2);
  expect(control.bodies[0]).toBe(control.bodies[1]);
});
test("@production complete Draft conflict and denial refuse confirmation; offline and expiry require explicit recovery", async ({
  page,
  context,
}) => {
  const control = await completeDraftSources(page);
  const name = page.getByRole("textbox", { name: "Product name · en-CA", exact: true });
  await name.fill("Synthetic local edit");
  control.mode = "Drift";
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Draft save not confirmed: Conflict. Refresh or discard local edits to recover.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(control.bodies).toEqual([]);
  await expect(name).toHaveCount(0);
  await page.getByRole("button", { name: "Discard local edits and reload", exact: true }).click();
  await expect(name).toHaveValue("Synthetic owner drift");
  control.mode = "Current";
  await page.getByRole("button", { name: "Discard local edits and reload", exact: true }).click();
  await name.fill("Synthetic denied edit");
  control.mode = "Denied";
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Draft save not confirmed: Denied. Resolve the stored original before editing or publishing.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(name).toHaveCount(0);
  expect(control.bodies).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Discard local edits and reload", exact: true }),
  ).toBeDisabled();
  const original = JSON.parse(control.bodies[0] ?? "null") as {
    operationReference: string;
    expectedAggregateVersion: number;
  };
  let resolutions = 0;
  await page.route("**/merchant/catalog/products/authoring-resolution", async (route) => {
    const request = route.request().postDataJSON() as {
      operationReference: string;
      expectedAggregateVersion: number;
    };
    expect(request.operationReference).toBe(original.operationReference);
    expect(request.expectedAggregateVersion).toBe(original.expectedAggregateVersion);
    resolutions += 1;
    const resolution = sealPublication({
      profile: "CatalogProductAuthoringResolutionV1",
      outcome: "Abandoned",
      command: {
        profile: "CatalogProductAuthoringResolutionCommandV1",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(5),
        action: "ReplaceDraft",
        operationReference: original.operationReference,
        productReference: id(4),
        expectedAggregateVersion: original.expectedAggregateVersion,
      },
      productReference: id(4),
      versionReference: null,
      aggregateVersion: null,
      originalIntentDigest: null,
      recordedAt: new Date().toISOString(),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductAuthoringResolutionResultV1",
        storeReference: id(3),
        resolution,
      }),
    });
  });
  control.mode = "Current";
  await page.getByRole("button", { name: "Resolve stored Draft save", exact: true }).click();
  await expect(
    page.getByText(
      "The original Draft save was permanently ended without applying. Reopen the current Product to edit.",
      { exact: false },
    ),
  ).toBeVisible();
  expect(resolutions).toBe(1);
  expect(control.bodies).toHaveLength(1);
  await enter(page);
  await page.getByRole("button", { name: "Open Draft editor", exact: true }).click();
  await expect(name).toBeVisible();
  await context.setOffline(true);
  await expect(name).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh editable Draft", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  await expect(name).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(name).toBeVisible();
  await expect(name).toHaveCount(0, { timeout: 7000 });
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(name).toBeVisible();
});

test("@production complete Draft recorded SKU Variant Option configuration preserves identities and reflows", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  const control = await completeDraftSources(page);
  const field = (name: string) => page.getByRole("textbox", { name, exact: true });
  await field("SKU 1 code").focus();
  await page.keyboard.press("Tab");
  await expect(field("SKU 1 name · en-CA")).toBeFocused();
  await field("SKU 1 code").fill("SYNTH_RECORDED");
  await field("SKU 1 name · en-CA").fill("Synthetic recorded SKU edit");
  await expect(field("SKU 1 unit quantity")).toHaveAttribute("readonly", "");
  await expect(field("SKU 1 unit quantity")).toHaveValue("1");
  await expect(page.getByLabel("SKU 1 Draft lifecycle", { exact: true })).toBeDisabled();
  await field("Dimension 1 code").fill("PORTION_SIZE");
  await field("Dimension 1 name · en-CA").fill("Synthetic recorded dimension");
  await field("Dimension 1 value 1 code").fill("RECORDED_SMALL");
  await field("Dimension 1 value 1 name · en-CA").fill("Synthetic recorded value");
  await page
    .getByLabel("Dimension 1 selection requirement", { exact: true })
    .selectOption("Optional");
  await field("Option binding 1 purpose").fill("SELECT_RECORDED");
  await field("Option binding 1 minimum override").fill("");
  await field("Option binding 1 maximum override").fill("3");
  await page.getByLabel("Option binding 1 allow Store override", { exact: true }).check();
  await page
    .getByLabel("Option binding 1 version resolution", { exact: true })
    .selectOption("CurrentPublished");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
    await expect(field("SKU 1 name · en-CA")).toHaveValue("Synthetic recorded SKU edit");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `/private/tmp/wp2421-recorded-configuration-${width}.png`,
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  const command = JSON.parse(control.bodies[0] ?? "{}");
  const before = currentEditorFixture(String(command.draft.createdAt)).aggregate.draft;
  expect(command.draft.skus).toEqual(
    before.skus.map((sku) => ({
      ...sku,
      skuCode: "SYNTH_RECORDED",
      localizedNames: { "en-CA": "Synthetic recorded SKU edit" },
      unitQuantity: sku.unitQuantity,
      lifecycle: sku.lifecycle,
    })),
  );
  expect(command.draft.editorContent.variantDimensions).toEqual(
    before.editorContent?.variantDimensions.map((dimension) => ({
      ...dimension,
      code: "PORTION_SIZE",
      localizedNames: { "en-CA": "Synthetic recorded dimension" },
      selectionRequirement: "Optional",
      values: dimension.values.map((value) => ({
        ...value,
        code: "RECORDED_SMALL",
        localizedNames: { "en-CA": "Synthetic recorded value" },
      })),
    })),
  );
  expect(command.draft.editorContent.variantCombinations).toEqual(
    before.editorContent?.variantCombinations,
  );
  expect(command.draft.optionBindings).toEqual(
    before.optionBindings.map((binding) => ({
      ...binding,
      purpose: "SELECT_RECORDED",
      minimumSelectionOverride: null,
      maximumSelectionOverride: 3,
      storeOverrideAllowed: true,
    })),
  );
  expect(command.draft.editorContent.optionRules).toEqual(
    before.editorContent?.optionRules.map((rule) => ({
      ...rule,
      versionResolution: "CurrentPublished",
    })),
  );
  for (const key of [
    "media",
    "tagReferences",
    "attributeValues",
    "allergenReferences",
    "nutritionProfile",
  ] as const)
    expect(command.draft.editorContent[key]).toEqual(before.editorContent?.[key]);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(field("SKU 1 name · en-CA")).toHaveValue("Synthetic recorded SKU edit");
  expect(await page.locator("body").innerText()).not.toContain(id(36));
  expect(errors).toEqual([]);
});

test("@production complete Draft invalid integer survives offline refresh and original configuration retry", async ({
  page,
  context,
}) => {
  const control = await completeDraftSources(page);
  const maximum = page.getByRole("textbox", {
    name: "Option binding 1 maximum override",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save recorded Draft", exact: true });
  await maximum.fill("1.5");
  await expect(maximum).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter a non-negative whole number up to 2147483647, or leave blank.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  expect(control.bodies).toEqual([]);
  await context.setOffline(true);
  await expect(maximum).toHaveCount(0);
  await context.setOffline(false);
  await expect(maximum).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(maximum).toHaveValue("1.5");
  await expect(save).toBeDisabled();
  await maximum.fill("2147483648");
  await expect(maximum).toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeDisabled();
  await maximum.fill("3");
  await expect(maximum).not.toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeEnabled();
  control.mode = "Unknown";
  await save.click();
  await expect(
    page.getByRole("button", { name: "Retry original Draft save", exact: true }),
  ).toBeVisible();
  await expect(maximum).toHaveCount(0);
  await page.getByRole("button", { name: "Retry original Draft save", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(2);
  expect(control.bodies[0]).toBe(control.bodies[1]);
  expect(
    JSON.parse(control.bodies[0] ?? "{}").draft.optionBindings[0].maximumSelectionOverride,
  ).toBe(3);
});

// Milestone95: real Chromium/ordinary entry, explicitly synthetic owning projection and native-shaped receipts.
async function publicationSources(page: Page) {
  type Command =
    import("../src/product-publication-command-client-v2.js").ProductPublicationUserCommandV2;
  const control = {
    root: 7,
    draft: id(14),
    reads: 0,
    mode: "Current",
    loseNext: false,
    commandDenied: false,
    denyReadsAfterCommit: false,
    bodies: [] as string[],
    scopes: [] as string[],
    release: undefined as undefined | (() => void),
  };
  publicationRoots.set(page, () => control.root);
  const future = new Date(Date.now() + 3600000).toISOString(),
    now = new Date().toISOString(),
    replacementIntent = noReplacement();
  const period = {
    timeZone: "UTC",
    effectiveFrom: { instant: future, localDateTime: future.slice(0, -1), utcOffsetMinutes: 0 },
    effectiveUntil: null,
  };
  const initialScopes = [
    {
      level: "Store",
      reference: id(3) as string | null,
      channelCodes: [] as string[],
      orderTypeCodes: [] as string[],
    },
  ];
  const row = {
    profile: "CatalogProductPublicationVersionV2",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    versionReference: id(14),
    publicationVersion: 1,
    productAggregateVersion: 6,
    state: "Draft",
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: initialScopes,
    scopeDigest: publicationDigest(initialScopes),
    effectivePeriod: period as Command["effectivePeriod"],
    periodDigest: publicationDigest(period),
    validationEvidenceReference: id(40),
    validationDecision: "ApprovalPending",
    policyReference: id(41),
    policyVersion: 1,
    approvalPolicy: "Required",
    reviewReference: null as string | null,
    reviewVersion: null as number | null,
    submittedByActorReference: null as string | null,
    approvalEvidenceReference: null as string | null,
    scheduleReference: null as string | null,
    scheduleVersion: 0,
    publishedAt: null as string | null,
    supersededAt: null as string | null,
    supersededByVersionReference: null as string | null,
    successorDraftVersionReference: null as string | null,
    operationReference: id(42),
    intentDigest: hash,
    actorReference: id(43),
    actorKind: "User",
    occurredAt: now,
    reasonCode: "USER_REQUEST",
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  };
  type Row = typeof row;
  const rows = new Map<string, Row>([[row.versionReference, row]]),
    history: { publicationAction: string; publication: Row }[] = [
      { publicationAction: "Validate", publication: row },
    ],
    ledger = new Map<string, Record<string, unknown>>();
  publicationRecordCounts.set(page, () => rows.size);
  const header = (publicationAction: string, publication: Row) =>
    sealPublication({
      profile: "CatalogProductScopeRetirementHeaderV1",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(4),
      operationReference: publication.operationReference,
      versionReference: publication.versionReference,
      publicationVersion: publication.publicationVersion,
      publicationAction,
      sourceAggregateVersion: publication.productAggregateVersion,
      resultAggregateVersion: publication.productAggregateVersion + 1,
      publicationIntentDigest: publication.intentDigest,
      publicationSnapshotDigest: publicationDigest(publication),
      observedSourceRevision: String(publication.productAggregateVersion),
      observedSourceHeadDigest: hash,
      recordedAt: publication.occurredAt,
      retirements: [],
    });
  // The ordinary page must refresh the editor using the receipt root, including after recovery.
  await page.route("**/merchant/catalog/products/editor", async (route) => {
    if (control.denyReadsAfterCommit && control.root > 7)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      });
    const raw = currentEditorFixture(new Date().toISOString());
    const expected = route.request().postDataJSON().expectedAggregateVersion as number;
    if (expected !== control.root)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "product_editor_unavailable" }),
      });
    raw.aggregateVersion = control.root;
    raw.aggregate.aggregateVersion = control.root;
    raw.aggregate.draft.versionReference = control.draft;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(sealPublication(raw)),
    });
  });
  await page.route("**/merchant/catalog/products/publication/management/v2", async (route) => {
    control.reads++;
    expect(route.request().postDataJSON()).toEqual({
      productReference: id(4),
      expectedAggregateVersion: control.root,
    });
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(new URL(route.request().url()).search).toBe("");
    if (control.mode === "Slow")
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
    if (control.mode === "Denied" || (control.denyReadsAfterCommit && control.root > 7))
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      });
    const observedAt = new Date().toISOString(),
      versions = [...rows.values()].sort((a, b) =>
        a.versionReference.localeCompare(b.versionReference),
      ),
      headers = history.map((e) => header(e.publicationAction, e.publication));
    const coverage = {
      profile: "CatalogProductRetirementCoverageV1",
      coverage: "CompleteRecordedPublicationRetirements",
      sourceAuthority: "NotEvaluated",
      eligibility: "NotEvaluated",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(4),
      aggregateVersion: control.root,
      sourceRevision: String(control.root),
      observedAt,
      history,
      headers,
      latest: versions,
    };
    const body = sealPublication({
      profile: "CatalogProductPublicationManagementV2",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      productReference: id(4),
      aggregateVersion: control.root,
      observedAt,
      editorObservedAt: observedAt,
      sourceObservedAt: observedAt,
      validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
      sourceRevision: String(control.root),
      sourceDigest: publicationDigest(coverage),
      coverage: "CompleteRecordedPublicationManagement",
      eligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      draft: {
        versionReference: control.draft,
        contentDigest: hash,
        configurationDigest: hash,
        contentStatus: "Present",
      },
      versions,
      history,
      scopeRetirementHeaders: headers,
      noReplacementIntent: noReplacement(),
      replacementTargets: [],
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(body),
    });
  });
  await page.route("**/merchant/catalog/products/publication/v2", async (route) => {
    const text = route.request().postData() ?? "",
      command = JSON.parse(text) as Command;
    control.bodies.push(text);
    control.scopes.push(route.request().headers()["x-bop-catalog-scope"] ?? "");
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(command.productReference).toBe(id(4));
    expect(Object.keys(command)).toHaveLength(18);
    expect(command.profile).toBe("CatalogProductPublicationCommandV2");
    expect(command.replacementIntent).toEqual(noReplacement());
    expect(command.replacementIntentDigest).toBe(noReplacement().digest);
    expect(command.contentDigest).toBe(hash);
    expect(command.configurationDigest).toBe(hash);
    if (control.commandDenied)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      });
    const existing = ledger.get(command.operationReference);
    if (existing)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ ...existing, status: "Replayed" }),
      });
    expect(command.expectedProductAggregateVersion).toBe(control.root);
    const before = rows.get(command.versionReference);
    expect(command.expectedPublicationVersion).toBe(before?.publicationVersion ?? 0);
    const states = {
      Validate: "Draft",
      SubmitReview: "InReview",
      Approve: "Approved",
      Reject: "Draft",
      Publish: "Published",
      SchedulePublish: "Scheduled",
      ReschedulePublish: "Scheduled",
      CancelScheduledPublish: "Draft",
    };
    const state = states[command.action],
      occurredAt = new Date().toISOString(),
      resetting = state === "Draft";
    const next: Row = {
      ...row,
      ...before,
      versionReference: command.versionReference,
      publicationVersion: command.expectedPublicationVersion + 1,
      productAggregateVersion: control.root,
      state,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeSet: command.scopeSet.map((selector) => ({
        ...selector,
        channelCodes: [...selector.channelCodes],
        orderTypeCodes: [...selector.orderTypeCodes],
      })),
      scopeDigest: publicationDigest(command.scopeSet),
      effectivePeriod: command.effectivePeriod,
      periodDigest: publicationDigest(command.effectivePeriod),
      reviewReference: resetting ? null : (before?.reviewReference ?? id(44)),
      reviewVersion: resetting
        ? null
        : (before?.reviewVersion ?? command.expectedPublicationVersion + 1),
      submittedByActorReference: resetting ? null : id(43),
      approvalEvidenceReference: resetting || state === "InReview" ? null : id(45),
      validationDecision: resetting || state === "InReview" ? "ApprovalPending" : "Pass",
      scheduleReference: command.scheduleReference ?? before?.scheduleReference ?? null,
      scheduleVersion: command.scheduleReference
        ? (before?.scheduleVersion ?? 0) + 1
        : (before?.scheduleVersion ?? 0),
      publishedAt: state === "Published" ? occurredAt : null,
      successorDraftVersionReference: command.successorDraftVersionReference,
      operationReference: command.operationReference,
      intentDigest: publicationDigest(command),
      occurredAt,
      replacementIntent: command.replacementIntent,
      replacementIntentDigest: command.replacementIntentDigest,
    };
    rows.set(command.versionReference, next);
    history.push({ publicationAction: command.action, publication: next });
    control.root++;
    if (command.successorDraftVersionReference)
      control.draft = command.successorDraftVersionReference;
    const receipt = {
      profile: "CatalogProductPublicationCommandResultV2",
      replacementIntentDigest: command.replacementIntentDigest,
      status: "Applied",
      operationReference: command.operationReference,
      productReference: command.productReference,
      versionReference: command.versionReference,
      aggregateVersion: control.root,
      publicationVersion: next.publicationVersion,
      state: next.state,
      scheduleVersion: next.scheduleVersion,
      effectiveFrom: next.effectivePeriod.effectiveFrom.instant,
      successorDraftVersionReference: command.successorDraftVersionReference,
    };
    ledger.set(command.operationReference, receipt);
    if (control.loseNext) {
      control.loseNext = false;
      return route.abort("failed");
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(receipt),
    });
  });
  return Object.assign(control, {
    clearHistory: () => {
      rows.clear();
      history.splice(0);
    },
    setRecordedScopes: (scopes: Row["scopeSet"]) => {
      row.scopeSet = scopes;
      row.scopeDigest = publicationDigest(scopes);
    },
  });
}
async function openPublication(page: Page) {
  await expect(page.getByText(/Current publication records loaded/)).toBeVisible();
}
async function publicationAction(page: Page, name: string) {
  const status = page.locator("#publication-request-result"),
    before = await status.innerText(),
    match = /Revision ([0-9]+)/u.exec(before);
  if (!match?.[1]) throw new Error("Current publication revision must be visible before acting");
  await page.getByRole("button", { name, exact: true }).click();
  await expect(status).toContainText(`Revision ${Number(match[1]) + 1}.`);
}
async function reenterCurrentPublication(page: Page) {
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
}
test("@production publication ordinary requests validate review independent approval reject and publish now", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  for (const name of [
    "Validate publication",
    "Submit publication review",
    "Reject publication review",
    "Submit publication review",
    "Request independent approval",
    "Publish now",
  ])
    await publicationAction(page, name);
  expect(control.bodies.map((text) => JSON.parse(text).action)).toEqual([
    "Validate",
    "SubmitReview",
    "Reject",
    "SubmitReview",
    "Approve",
    "Publish",
  ]);
  const published = JSON.parse(control.bodies[5] ?? "null");
  expect(published.successorDraftVersionReference).not.toBe(id(14));
  expect(control.root).toBe(13);
  expect(new Set(control.bodies.map((text) => JSON.parse(text).operationReference)).size).toBe(6);
  expect(errors).toEqual([]);
});
test("@production publication acknowledged write stays confirmed when automatic current reads are denied", async ({
  page,
}) => {
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  control.denyReadsAfterCommit = true;
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(page.locator("#publication-request-result")).toHaveText(
    "Publication confirmed at revision 8. Current records unavailable: Denied. Refresh publication records to continue.",
  );
  await expect(
    page.getByText("Product change confirmed · Revision 8.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Current content permission denied", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry original publication request", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Current publication records loaded/)).toHaveCount(0);
  await expect(page.getByText(/Publication request not confirmed/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Submit publication review", exact: true }),
  ).toHaveCount(0);
  expect(control.root).toBe(8);
  expect(control.bodies).toHaveLength(1);
  expect(await pendingPublicationRecords(page)).toEqual([]);
  control.denyReadsAfterCommit = false;
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(page.locator("#publication-request-result")).toContainText(
    "Current publication records loaded · Revision 8.",
  );
  await expect(
    page.getByText("Product change confirmed · Revision 8.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
});
test("@production publication schedule reschedule cancel keyboard mobile narrow and zoom", async ({
  page,
}) => {
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  for (const name of [
    "Submit publication review",
    "Request independent approval",
    "Schedule publication",
  ])
    await publicationAction(page, name);
  const selectBox = await page.getByLabel("Publication version", { exact: true }).boundingBox();
  expect(selectBox?.height).toBeGreaterThanOrEqual(44);
  const original = JSON.parse(control.bodies[2] ?? "null");
  const nextFrom = new Date(Date.parse(original.effectivePeriod.effectiveFrom.instant) + 3600000);
  nextFrom.setUTCMilliseconds(0);
  await page
    .getByLabel("Effective from local time", { exact: true })
    .fill(nativeLocalDateTime(nextFrom.toISOString().slice(0, -1)));
  await page.getByLabel("Effective from UTC offset minutes", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByLabel("Effective until local time (optional)", { exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Reschedule publication", exact: true }),
  ).toHaveCount(0);
  // Cancel sends the recorded period; the new period is validated only after cancellation.
  await page
    .getByLabel("Effective from local time", { exact: true })
    .fill(nativeLocalDateTime(original.effectivePeriod.effectiveFrom.localDateTime));
  await publicationAction(page, "Cancel scheduled publication");
  await page
    .getByLabel("Effective from local time", { exact: true })
    .fill(nativeLocalDateTime(nextFrom.toISOString().slice(0, -1)));
  for (const action of [
    "Validate publication",
    "Submit publication review",
    "Request independent approval",
    "Schedule publication",
  ])
    await publicationAction(page, action);
  const rescheduled = JSON.parse(control.bodies[7] ?? "null");
  expect(JSON.parse(control.bodies[3] ?? "null").scheduleReference).toBe(
    original.scheduleReference,
  );
  expect(rescheduled.scheduleReference).not.toBe(original.scheduleReference);
  expect(rescheduled.effectivePeriod.effectiveFrom.instant).toBe(nextFrom.toISOString());
  expect(rescheduled.effectivePeriod.effectiveFrom.instant).not.toBe(
    original.effectivePeriod.effectiveFrom.instant,
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Cancel scheduled publication", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page
      .getByRole("region", { name: "Publication requests", exact: true })
      .screenshot({ path: `/private/tmp/wp2421-publication-${width}.png` });
  }
  await page.locator("html").evaluate((el) => {
    el.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.locator("html").evaluate((el) => {
    el.style.fontSize = "";
  });
  await publicationAction(page, "Cancel scheduled publication");
  expect(JSON.parse(control.bodies[8] ?? "null").scheduleReference).toBe(
    rescheduled.scheduleReference,
  );
  const text = await page
    .getByRole("region", { name: "Publication requests", exact: true })
    .innerText();
  expect(text).not.toContain(hash);
  for (const n of [1, 2, 3, 4, 14, 20]) expect(text).not.toContain(id(n));
});
test("@production publication unknown offline expiry denied original replay and context source recovery", async ({
  page,
  context,
}) => {
  const gate = await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  control.loseNext = true;
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  const reads = control.reads;
  await expect(
    page.getByRole("button", { name: "Refresh publication records", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Validate publication", exact: true })).toHaveCount(
    0,
  );
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Retry original publication request", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  gate.disabled = true;
  await page
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  gate.disabled = false;
  await page
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .click();
  await expect(page.getByText(/Current publication records loaded/)).toBeVisible();
  expect(control.bodies).toHaveLength(2);
  expect(control.bodies[1]).toBe(control.bodies[0]);
  expect(control.scopes[1]).toBe(control.scopes[0]);
  expect(control.reads).toBe(reads + 1);
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(page.getByText(/Current publication records loaded/)).toBeVisible();
  await expect(page.getByText(/Current publication records unavailable: Stale/)).toBeVisible({
    timeout: 7000,
  });
  await expect(
    page.getByRole("button", { name: "Submit publication review", exact: true }),
  ).toHaveCount(0);
  control.mode = "Denied";
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(page.getByText(/Publication request not confirmed: Denied/)).toBeVisible();
  control.mode = "Current";
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Submit publication review", exact: true }),
  ).toBeVisible();
  control.mode = "Slow";
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect.poll(() => Boolean(control.release)).toBe(true);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  control.release?.();
  await expect(
    page.getByRole("heading", { name: "Publication requests", exact: true }),
  ).toHaveCount(0);
});
test("@production publication initial scope proposal and invalid local period require explicit correction", async ({
  page,
}) => {
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  control.clearHistory();
  await enter(page);
  await openPublication(page);
  await expect(page.getByText(/Recorded state: No publication yet/)).toBeVisible();
  const zone = page.getByLabel("Time zone", { exact: true });
  await zone.fill("Invalid/Zone");
  await page.getByLabel("Effective from local time", { exact: true }).fill("2026-10-02T12:00");
  await page.getByLabel("Effective from UTC offset minutes", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(page.getByText(/Publication request not confirmed: Invalid/)).toBeVisible();
  await expect(zone).toHaveAttribute("aria-invalid", "true");
  expect(control.bodies).toEqual([]);
  await zone.fill("America/Toronto");
  await page.getByLabel("Effective from UTC offset minutes", { exact: true }).fill("-240");
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect.poll(() => control.bodies.length).toBe(1);
  await expect(page.locator("#publication-request-result")).toContainText(
    "Current publication records loaded · Revision 8.",
  );
  const command = JSON.parse(control.bodies[0] ?? "null");
  expect(command.expectedPublicationVersion).toBe(0);
  expect(command.scopeSet).toEqual([
    { level: "Store", reference: id(3), channelCodes: [], orderTypeCodes: [] },
  ]);
  expect(command.effectivePeriod).toEqual({
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: "2026-10-02T16:00:00.000Z",
      localDateTime: "2026-10-02T12:00:00.000",
      utcOffsetMinutes: -240,
    },
    effectiveUntil: null,
  });
});

async function pendingPublicationRecords(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const open = indexedDB.open("bop-publication-pending-v1", 1);
        open.onerror = () => reject(Error("Synthetic local storage inspection failed"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          let records: Record<string, unknown>[] = [];
          request.onsuccess = () => {
            records = request.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(records);
          };
          tx.onabort = () => {
            db.close();
            reject(Error("Synthetic local storage inspection aborted"));
          };
        };
      }),
  );
}
test("@production publication durable original survives reload navigation current denial and exact replay cleanup", async ({
  page,
  context,
}) => {
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  control.loseNext = true;
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  const original = control.bodies[0],
    reads = control.reads;
  const records = await pendingPublicationRecords(page);
  expect(records).toHaveLength(1);
  expect(records[0]?.body).toBe(original);
  expect(Object.keys(records[0] ?? {}).sort()).toEqual(
    [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
      "operationReference",
      "body",
      "digest",
    ].sort(),
  );
  expect(JSON.stringify(records)).not.toContain("c".repeat(43));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await reenterCurrentPublication(page);
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  expect(control.reads).toBe(reads);
  expect(control.bodies).toHaveLength(1);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Retry original publication request", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  control.commandDenied = true;
  await page
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  expect(await pendingPublicationRecords(page)).toEqual(records);
  control.commandDenied = false;
  await page
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Current publication records loaded/)).toBeVisible();
  expect(control.bodies).toEqual([original, original, original]);
  expect(new Set(control.scopes).size).toBe(1);
  expect(control.reads).toBe(reads + 1);
  expect(await pendingPublicationRecords(page)).toEqual([]);
});
test("@production publication explicit Brand scope requires validation and keeps recorded filtered scopes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  const recorded = [
    { level: "Store", reference: id(3), channelCodes: ["PICKUP"], orderTypeCodes: ["TAKEOUT"] },
    { level: "Store", reference: id(3), channelCodes: ["TABLE"], orderTypeCodes: ["DINEIN"] },
  ];
  control.setRecordedScopes(recorded);
  await enter(page);
  await openPublication(page);
  const scope = page.getByLabel("Publication scope", { exact: true });
  await expect(scope).toHaveValue("Recorded");
  await publicationAction(page, "Validate publication");
  expect(JSON.parse(control.bodies[0] ?? "null").scopeSet).toEqual(recorded);
  await scope.focus();
  await expect(scope).toBeFocused();
  await page.keyboard.press("e");
  await page.keyboard.press("Tab");
  await expect(scope).toHaveValue("Brand");
  await expect(page.getByLabel("Time zone", { exact: true })).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Submit publication review", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Scope proposal changed. Validate and refresh/)).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect((await scope.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .getByRole("region", { name: "Publication requests", exact: true })
      .screenshot({ path: `/private/tmp/wp2421-m128-publication-scope-${width}.png` });
  }
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "";
  });
  await publicationAction(page, "Validate publication");
  const brand = [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }];
  expect(JSON.parse(control.bodies[1] ?? "null").scopeSet).toEqual(brand);
  await expect(scope).toHaveValue("Recorded");
  await expect(
    page.getByRole("button", { name: "Submit publication review", exact: true }),
  ).toBeEnabled();
  await publicationAction(page, "Submit publication review");
  await expect(scope).toHaveCount(0);
  await expect(page.getByText(/Recorded scope: Brand/)).toBeVisible();
  await publicationAction(page, "Request independent approval");
  await publicationAction(page, "Schedule publication");
  await expect(scope).toHaveCount(0);
  for (const text of control.bodies.slice(1)) expect(JSON.parse(text).scopeSet).toEqual(brand);
  const text = await page
    .getByRole("region", { name: "Publication requests", exact: true })
    .innerText();
  expect(text).not.toContain(id(3));
  expect(errors).toEqual([]);
});
test("@production publication Brand proposal survives stale offline denial and exact durable recovery", async ({
  page,
  context,
}) => {
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  const scope = page.getByLabel("Publication scope", { exact: true });
  await scope.selectOption("Brand");
  await expect(scope).toHaveCount(0, { timeout: 7000 });
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(scope).toHaveValue("Brand");
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(scope).toHaveCount(0);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  control.mode = "Denied";
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(page.getByText(/Publication request not confirmed: Denied/)).toBeVisible();
  await expect(scope).toHaveCount(0);
  expect(control.bodies).toEqual([]);
  control.mode = "Current";
  await page.getByRole("button", { name: "Refresh publication records", exact: true }).click();
  await expect(scope).toHaveValue("Brand");
  control.loseNext = true;
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  const original = control.bodies[0],
    reads = control.reads;
  expect(JSON.parse(original ?? "null").scopeSet).toEqual([
    { level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] },
  ]);
  const records = await pendingPublicationRecords(page);
  expect(records).toHaveLength(1);
  expect(records[0]?.body).toBe(original);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await reenterCurrentPublication(page);
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  control.commandDenied = true;
  await page
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  expect(await pendingPublicationRecords(page)).toEqual(records);
  control.commandDenied = false;
  await page
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Current publication records loaded/)).toBeVisible();
  expect(control.bodies).toEqual([original, original, original]);
  expect(control.reads).toBe(reads + 1);
  expect(await pendingPublicationRecords(page)).toEqual([]);
});
test("@production publication phone touch Brand proposal keeps current scope and narrow reflow", async ({
  browser,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error("Configured local browser URL is required");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await sources(page);
    await currentContentSource(page);
    const control = await publicationSources(page);
    await enter(page);
    await openPublication(page);
    const scope = page.getByLabel("Publication scope", { exact: true });
    await scope.selectOption("Brand");
    expect(await page.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect((await scope.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole("region", { name: "Publication requests", exact: true }).screenshot({
        path: `/private/tmp/wp2421-m128-publication-phone-${width}.png`,
      });
    }
    await page.getByRole("button", { name: "Validate publication", exact: true }).tap();
    await expect(page.locator("#publication-request-result")).toContainText("Revision 8.");
    expect(JSON.parse(control.bodies[0] ?? "null").scopeSet).toEqual([
      { level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] },
    ]);
    await page.getByRole("button", { name: "Refresh publication records", exact: true }).tap();
    await expect(scope).toHaveValue("Recorded");
    await expect(page.getByText(/Recorded scope: Brand/)).toBeVisible();
  } finally {
    await context.close();
  }
});
test("@production publication corrupt or unavailable native journal refuses dispatch", async ({
  page,
}) => {
  await sources(page);
  await currentContentSource(page);
  const control = await publicationSources(page);
  await enter(page);
  await openPublication(page);
  control.loseNext = true;
  await page.getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(page.getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  await page.evaluate(
    async () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("bop-publication-pending-v1", 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readwrite"),
            table = tx.objectStore("originals"),
            get = table.openCursor();
          get.onsuccess = () => {
            const cursor = get.result;
            if (cursor) cursor.update({ ...cursor.value, body: "corrupt" });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(Error("Synthetic corrupt storage fixture failed"));
          };
        };
        open.onerror = () => reject(Error("Synthetic corrupt storage fixture failed"));
      }),
  );
  page.on("dialog", (dialog) => void dialog.accept());
  const reads = control.reads;
  await page.reload();
  await reenterCurrentPublication(page);
  await expect(page.getByText(/Publication request not confirmed: Unavailable/)).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  expect(control.reads).toBe(reads);
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, "indexedDB", { value: undefined }),
  );
  await page.reload();
  await reenterCurrentPublication(page);
  await expect(page.getByText(/Publication request not confirmed: Unavailable/)).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  expect(control.reads).toBe(reads);
});

test("@demo publication native journal concurrent scope reservation exact cleanup and malformed stored value", async ({
  page,
}) => {
  await page.goto("/app");
  const result = await page.evaluate(async () => {
    const journalModule = "/src/product-publication-pending-journal.ts",
      recordModule = "/src/product-publication-pending-record.ts";
    const { createPublicationPendingJournal } = await import(journalModule),
      { buildPublicationPendingRecord } = await import(recordModule);
    const ref = (n: number) => "01902443-0000-7000-8000-" + n.toString(16).padStart(12, "0");
    const scope = {
      tenantReference: ref(1),
      brandReference: ref(2),
      storeReference: ref(3),
      productReference: ref(4),
    };
    const time = "2026-10-02T16:00:00.000Z";
    const command = {
      operationReference: ref(10),
      productReference: ref(4),
      versionReference: ref(14),
      action: "Validate",
      expectedProductAggregateVersion: 7,
      expectedPublicationVersion: 0,
      contentDigest: "sha256:" + "1".repeat(64),
      configurationDigest: "sha256:" + "1".repeat(64),
      scopeSet: [{ level: "Store", reference: ref(3), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: time, localDateTime: time.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      successorDraftVersionReference: null,
      replacementVersionReference: null,
      occurredAt: time,
      reasonCode: "USER_REQUEST",
    };
    const first = await buildPublicationPendingRecord(command, scope),
      second = await buildPublicationPendingRecord(
        { ...command, operationReference: ref(11) },
        scope,
      );
    const a = createPublicationPendingJournal(scope),
      b = createPublicationPendingJournal(scope);
    const attempts = await Promise.allSettled([a.reserve(first), b.reserve(second)]);
    const winner = await a.load(),
      loser = winner.operationReference === first.operationReference ? second : first;
    let wrongCleanupRefused = false;
    try {
      await a.complete(loser);
    } catch {
      wrongCleanupRefused = true;
    }
    const retained = JSON.stringify(await a.load()) === JSON.stringify(winner);
    const otherScopeEmpty =
      (await createPublicationPendingJournal({ ...scope, productReference: ref(24) }).load()) ===
      null;
    await b.reserve(winner);
    await a.complete(winner);
    const completed = (await b.load()) === null;
    await a.reserve(first);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("bop-publication-pending-v1", 1);
      open.onsuccess = () => {
        const db = open.result,
          tx = db.transaction("originals", "readwrite"),
          table = tx.objectStore("originals"),
          request = table.openCursor();
        request.onsuccess = () => {
          if (request.result) request.result.update({ corrupt: 1n });
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(Error("Synthetic malformed journal fixture failed"));
        };
      };
      open.onerror = () => reject(Error("Synthetic malformed journal fixture failed"));
    });
    const malformed = await Promise.allSettled([a.reserve(first), b.complete(first), a.load()]);
    return {
      statuses: attempts.map((x) => x.status).sort(),
      wrongCleanupRefused,
      retained,
      otherScopeEmpty,
      completed,
      malformed: malformed.map((x) => x.status),
    };
  });
  expect(result).toEqual({
    statuses: ["fulfilled", "rejected"],
    wrongCleanupRefused: true,
    retained: true,
    otherScopeEmpty: true,
    completed: true,
    malformed: ["rejected", "rejected", "rejected"],
  });
});

test("@production complete Draft without SKU resolves current Brand and preserves unknown save under current denial", async ({
  page,
}) => {
  const control = await completeDraftSources(page, "EmptySku");
  await page
    .getByRole("textbox", { name: "Product name · en-CA", exact: true })
    .fill("Synthetic initial Product before SKU");
  control.mode = "Unknown";
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(page.getByText(/Save result is unknown\. Retry the original request/)).toBeVisible();
  const command = JSON.parse(control.bodies[0] ?? "null");
  expect(command.draft.skus).toEqual([]);
  expect(command.draft.editorContent.variantDimensions).toEqual([]);
  expect(command.draft.editorContent.variantCombinations).toEqual([]);
  control.gate.disabled = true;
  await page.getByRole("button", { name: "Retry original Draft save", exact: true }).click();
  await expect(page.getByText(/Save result is unknown\. Retry the original request/)).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  control.gate.disabled = false;
  await page.getByRole("button", { name: "Retry original Draft save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(2);
  expect(control.bodies[1]).toBe(control.bodies[0]);
});
test("@production complete Draft late initial capability cannot restore a departed context", async ({
  page,
}) => {
  await sources(page);
  const content = await currentContentSource(page);
  await enter(page);
  await expect(page.getByRole("button", { name: "Open Draft editor", exact: true })).toBeEnabled();
  let release: (() => void) | undefined;
  await page.route("**/merchant/store-capability", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fallback();
  });
  const reads = content.calls;
  await page.getByRole("button", { name: "Open Draft editor", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  release?.();
  await expect(
    page.getByRole("heading", { name: "Edit recorded Draft content", exact: true }),
  ).toHaveCount(0);
  expect(content.calls).toBe(reads);
});

async function initialCreation(page: Page) {
  const gate = await sources(page);
  const control = { mode: "Applied", bodies: [] as string[] };
  await page.route("**/merchant/catalog/products", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      internalCode?: string;
      operationReference: string;
    };
    if (!body.internalCode) return route.fallback();
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(new URL(route.request().url()).search).toBe("");
    expect(
      JSON.parse(
        Buffer.from(route.request().headers()["x-bop-catalog-scope"] ?? "", "base64url").toString(),
      ),
    ).toEqual({ brandReference: id(2), storeReference: id(3) });
    control.bodies.push(route.request().postData() ?? "");
    if (control.mode === "Lost") return route.abort("failed");
    const denied = control.mode === "Denied";
    await route.fulfill({
      status: denied ? 403 : 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(
        denied
          ? { error: "request_denied" }
          : {
              status: control.bodies.length > 1 ? "AlreadyApplied" : "Applied",
              scope: { brandReference: id(2), storeReference: id(3) },
              operationReference: body.operationReference,
              productReference: id(4),
              versionReference: id(10),
              aggregateVersion: 1,
              lifecycle: "Draft",
              skus: [],
            },
      ),
    });
  });
  return { gate, control };
}
async function enterCreation(page: Page) {
  await page.goto("/app/commerce/products");
  await page.getByRole("link", { name: "Create product", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create product", exact: true })).toBeVisible();
  await expect(
    page.getByText("Current creation access loaded. Review the proposed initial Draft."),
  ).toBeVisible();
}
async function fillCreation(page: Page) {
  await page.getByRole("textbox", { name: "Internal code", exact: true }).fill("SYNTH_NEW");
  await page
    .getByRole("combobox", { name: "Product type", exact: true })
    .selectOption("PreparedFood");
  await page
    .getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true })
    .fill("en-CA");
  await page
    .getByRole("textbox", { name: "Product name", exact: true })
    .fill("Synthetic new product");
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Explicit proposed description");
  await page
    .getByRole("checkbox", {
      name: "Start without SKUs or other content reference assignments",
      exact: true,
    })
    .check();
}
test("@production initial Product creation ordinary entry, explicit fields, keyboard and responsive native-shaped receipt", async ({
  page,
}) => {
  const { control } = await initialCreation(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await enterCreation(page);
  await fillCreation(page);
  await page.getByRole("textbox", { name: "Internal code", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Product type", exact: true })).toBeFocused();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page
        .getByRole("combobox", { name: "Product type", exact: true })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: `/private/tmp/wp2421-product-create-${width}.png`,
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).focus();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Original creation confirmed. The initial Draft has no SKUs and is not published.",
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  expect(JSON.parse(control.bodies[0] ?? "null")).toMatchObject({
    internalCode: "SYNTH_NEW",
    skus: [],
    taxClassificationReference: null,
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedDescriptions: { "en-CA": "Explicit proposed description" },
      variantDimensions: [],
      variantCombinations: [],
      optionRules: [],
    },
  });
  await expect(page.getByRole("link", { name: "Open created Draft", exact: true })).toHaveAttribute(
    "href",
    `/app/commerce/products/${id(4)}/edit`,
  );
  const text = await page.locator("body").innerText();
  for (const privateValue of [id(1), id(2), id(4), id(10)])
    expect(text).not.toContain(privateValue);
  await page.route("**/merchant/catalog/products/publication/scope-journals", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      productReference: id(4),
      expectedAggregateVersion: 1,
    });
    const at = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductScopeJournalManagementV1",
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(4),
        aggregateVersion: 1,
        sourceDigest: hash,
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
        coverage: "CompleteRecordedScopeJournalCoverage",
        eligibility: "NotEvaluated",
        currentDisposition: "NotEvaluated",
        digest: hash,
        versions: [],
      }),
    });
  });
  await page.getByRole("link", { name: "Open created Draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Product revision", exact: true })).toHaveValue(
    "1",
  );
  await expect(
    page.getByText("No publication history is recorded for this revision."),
  ).toBeVisible();
});
test("@production initial Product creation unknown barrier, withdrawn capability and original exact recovery", async ({
  page,
  context,
}) => {
  const { gate, control } = await initialCreation(page);
  await enterCreation(page);
  await fillCreation(page);
  control.mode = "Lost";
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Creation result is unknown. Keep this page open and retry the original request.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Product name", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Retry original creation", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  gate.disabled = true;
  await page.getByRole("button", { name: "Retry original creation", exact: true }).click();
  await expect(
    page.getByText(
      "Creation result is unknown. Keep this page open and retry the original request.",
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  gate.disabled = false;
  control.mode = "Denied";
  await page.getByRole("button", { name: "Retry original creation", exact: true }).click();
  await expect(
    page.getByText(
      "Creation result is unknown. Keep this page open and retry the original request.",
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(2);
  control.mode = "Applied";
  await page.getByRole("button", { name: "Retry original creation", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Original creation confirmed. The initial Draft has no SKUs and is not published.",
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(3);
  expect(new Set(control.bodies).size).toBe(1);
});
test("@production initial Product creation current unavailable, expiry, invalid association and correction", async ({
  page,
}) => {
  const { gate, control } = await initialCreation(page);
  gate.disabled = true;
  await page.goto("/app/commerce/products");
  await expect(
    page.getByRole("button", { name: "Create product · unavailable", exact: true }),
  ).toBeDisabled();
  await page.goto("/app/commerce/products/new");
  await expect(page.getByText("Product creation is disabled for the current Store.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Internal code", exact: true })).toBeDisabled();
  gate.disabled = false;
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await fillCreation(page);
  await expect(
    page.getByText("Creation access has expired. Refresh current access before creating."),
  ).toBeVisible({ timeout: 7000 });
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true })
    .fill("bad_locale");
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByText("Check the code, type, locale, name and initial configuration acknowledgement."),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true }),
  ).toHaveAttribute("aria-describedby", "product-create-result");
  expect(control.bodies).toHaveLength(0);
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true })
    .fill("en-CA");
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Original creation confirmed. The initial Draft has no SKUs and is not published.",
    ),
  ).toBeVisible();
});
test("@production initial Product creation late source cannot initialize a departed page", async ({
  page,
}) => {
  const { control } = await initialCreation(page);
  let release: (() => void) | undefined;
  await page.route("**/merchant/store-capability", async (route) => {
    if (new URL(page.url()).pathname !== "/app/commerce/products/new") return route.fallback();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fallback();
  });
  await page.goto("/app/commerce/products/new");
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  release?.();
  await expect(page.getByRole("heading", { name: "Create product", exact: true })).toHaveCount(0);
  expect(control.bodies).toHaveLength(0);
});
test("@production initial Product creation exact owner authoring bounds retain full proposed text", async ({
  page,
}) => {
  const { control } = await initialCreation(page);
  await enterCreation(page);
  await fillCreation(page);
  for (const [name, maximum] of [
    ["Internal code", 64],
    ["Product name", 120],
    ["Short description", 240],
    ["Description", 4096],
    ["Preparation notes", 1000],
  ] as const) {
    await expect(page.getByRole("textbox", { name, exact: true })).toHaveAttribute(
      "maxlength",
      String(maximum),
    );
  }
  await page.getByRole("textbox", { name: "Internal code", exact: true }).fill("A".repeat(64));
  await page.getByRole("textbox", { name: "Product name", exact: true }).fill("N".repeat(120));
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("D".repeat(4096));
  await page
    .getByRole("textbox", { name: "Preparation notes", exact: true })
    .fill("P".repeat(1000));
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Original creation confirmed. The initial Draft has no SKUs and is not published.",
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  const body = JSON.parse(control.bodies[0] ?? "null") as {
    internalCode: string;
    localizedNames: Record<string, string>;
    editorContent: {
      localizedDescriptions: Record<string, string>;
      preparationNotes: Record<string, string>;
    };
  };
  expect(body.internalCode).toBe("A".repeat(64));
  expect(body.localizedNames["en-CA"]).toBe("N".repeat(120));
  expect(body.editorContent.localizedDescriptions["en-CA"]).toBe("D".repeat(4096));
  expect(body.editorContent.preparationNotes["en-CA"]).toBe("P".repeat(1000));
});

async function initialCategoryCreation(page: Page) {
  const { gate, control } = await initialCreation(page);
  const category = {
    mode: "Allow",
    calls: 0,
    age: 0,
    release: undefined as (() => void) | undefined,
  };
  await page.route("**/merchant/catalog/products/category-lookup", async (route) => {
    category.calls++;
    expect(new URL(route.request().url()).search).toBe("");
    expect(
      JSON.parse(
        Buffer.from(
          route.request().headers()["x-bop-product-category-lookup"] ?? "",
          "base64url",
        ).toString(),
      ),
    ).toEqual({ parentScreenId: "CAT-PRODUCT-CREATE" });
    if (category.mode === "Slow")
      await new Promise<void>((resolve) => {
        category.release = resolve;
      });
    const at = new Date(Date.now() - category.age).toISOString();
    await route.fulfill({
      status:
        category.mode === "Denied"
          ? 403
          : ["Disabled", "Stale"].includes(category.mode)
            ? 409
            : 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(
        category.mode === "Denied"
          ? { error: "request_denied" }
          : category.mode === "Disabled"
            ? { error: "product_category_lookup_feature_disabled" }
            : category.mode === "Stale"
              ? { error: "product_category_lookup_stale" }
              : {
                  scope: { brandReference: id(2), storeReference: id(3) },
                  lookup: {
                    projection: {
                      name: "catalog_product_category_lookup_v1",
                      version: 1,
                      asOfUtc: at,
                      stale: false,
                      partial: true,
                    },
                    parentScreenId: "CAT-PRODUCT-CREATE",
                    brandReference: id(2),
                    locale: category.mode === "WrongLocale" ? "fr-CA" : "en-CA",
                    configuration: "Draft",
                    source: { revision: "3", digest: "sha256:" + "a".repeat(64), asOfUtc: at },
                    policy: { allowedLifecycles: ["Draft", "Active"] },
                    items: [0, 1].map((i) => ({
                      categoryReference: id(50 + i),
                      internalCode: i ? "CAT_B" : "CAT_A",
                      name: i ? "Synthetic Drinks" : "Synthetic Food",
                      nameLocale: "en-CA",
                      localeFallback: false,
                      lifecycle: "Draft",
                    })),
                  },
                },
      ),
    });
  });
  await page.route("**/merchant/catalog/products", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      categoryClassification?: unknown;
      operationReference: string;
    };
    if (body.categoryClassification === undefined) return route.fallback();
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(
      JSON.parse(
        Buffer.from(route.request().headers()["x-bop-catalog-scope"] ?? "", "base64url").toString(),
      ),
    ).toEqual({ brandReference: id(2), storeReference: id(3) });
    control.bodies.push(route.request().postData() ?? "");
    if (control.mode === "Lost") return route.abort("failed");
    await route.fulfill({
      status: control.mode === "Denied" ? 403 : 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(
        control.mode === "Denied"
          ? { error: "request_denied" }
          : {
              status: control.bodies.length > 1 ? "AlreadyApplied" : "Applied",
              scope: { brandReference: id(2), storeReference: id(3) },
              operationReference: body.operationReference,
              productReference: id(4),
              versionReference: id(10),
              aggregateVersion: 1,
              lifecycle: "Draft",
              categoryClassification: body.categoryClassification,
              skus: [],
            },
      ),
    });
  });
  return { gate, control, category };
}
const foodCategory = "Synthetic Food · CAT_A · Draft";
const drinksCategory = "Synthetic Drinks · CAT_B · Draft";
test("@production initial Product creation current Category keyboard multi-selection, primary and narrow reflow", async ({
  page,
}) => {
  const { control } = await initialCategoryCreation(page);
  await enterCreation(page);
  await fillCreation(page);
  await page.getByRole("button", { name: "Load current Categories", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("checkbox", { name: foodCategory, exact: true }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("checkbox", { name: drinksCategory, exact: true }).check();
  await page.getByRole("combobox", { name: "Primary Category", exact: true }).selectOption(id(51));
  await page.getByRole("textbox", { name: "Search Category choices", exact: true }).fill("Food");
  await expect(page.getByRole("checkbox", { name: drinksCategory, exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search Category choices", exact: true }).fill("");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 860 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  for (const label of ["Load current Categories", "Use no Categories"]) {
    const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const box = await page.getByRole("checkbox", { name: foodCategory, exact: true }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/private/tmp/wp2421-m102-categories-320.png" });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open created Draft", exact: true })).toBeVisible();
  expect(JSON.parse(control.bodies[0] ?? "null").categoryClassification).toEqual({
    categoryReferences: [id(50), id(51)],
    primaryCategoryReference: id(51),
  });
});
test("@production initial Product creation Category denial, locale and expiry retain proposal without empty fallback", async ({
  page,
}) => {
  const { category, control } = await initialCategoryCreation(page);
  await enterCreation(page);
  await fillCreation(page);
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await page.getByRole("checkbox", { name: foodCategory, exact: true }).check();
  category.mode = "Denied";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(
    page.getByText("Category access denied. Existing proposal retained; no assignment inferred."),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/1 proposed Categories/)).toBeVisible();
  category.mode = "Disabled";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(
    page.getByText(
      "Category configuration is disabled for the current Store. Existing proposal retained.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  category.mode = "Stale";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(
    page.getByText("Category source expired. Refresh current choices; existing proposal retained."),
  ).toBeVisible();
  category.mode = "WrongLocale";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(
    page.getByText(
      "Current Categories unavailable. Existing proposal retained; no assignment inferred.",
    ),
  ).toBeVisible();
  category.mode = "Allow";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(
    page.getByText(
      "Category choices expired or context changed. Refresh before configuring or creating.",
    ),
  ).toBeVisible({ timeout: 7000 });
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Use no Categories", exact: true }).click();
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open created Draft", exact: true })).toBeVisible();
  expect(JSON.parse(control.bodies[0] ?? "null").categoryClassification).toEqual({
    categoryReferences: [],
    primaryCategoryReference: null,
  });
});
test("@production initial Product creation selected Category Unknown retains original through offline and withdrawn access", async ({
  page,
  context,
}) => {
  const { category, gate, control } = await initialCategoryCreation(page);
  await enterCreation(page);
  await fillCreation(page);
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await page.getByRole("checkbox", { name: foodCategory, exact: true }).check();
  await page.getByRole("combobox", { name: "Primary Category", exact: true }).selectOption(id(50));
  control.mode = "Lost";
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry original creation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load current Categories", exact: true }),
  ).toBeDisabled();
  const calls = category.calls;
  category.mode = "Denied";
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Retry original creation", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  gate.disabled = true;
  await page.getByRole("button", { name: "Retry original creation", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry original creation", exact: true }),
  ).toBeEnabled();
  expect(control.bodies).toHaveLength(1);
  gate.disabled = false;
  control.mode = "Denied";
  await page.getByRole("button", { name: "Retry original creation", exact: true }).click();
  await expect.poll(() => control.bodies.length).toBe(2);
  await expect(
    page.getByRole("button", { name: "Retry original creation", exact: true }),
  ).toBeEnabled();
  control.mode = "Applied";
  await page.getByRole("button", { name: "Retry original creation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open created Draft", exact: true })).toBeVisible();
  expect(new Set(control.bodies).size).toBe(1);
  expect(category.calls).toBe(calls);
});

test("@production initial Product creation Category cancelled offline read and late locale source recover without assignment", async ({
  page,
  context,
}) => {
  const { category, control } = await initialCategoryCreation(page);
  await enterCreation(page);
  await fillCreation(page);
  category.mode = "Slow";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect.poll(() => Boolean(category.release)).toBe(true);
  await context.setOffline(true);
  category.release?.();
  await context.setOffline(false);
  category.mode = "Allow";
  await page.getByRole("button", { name: "Refresh current creation access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Load current Categories", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await page.getByRole("checkbox", { name: foodCategory, exact: true }).check();
  category.mode = "Slow";
  Object.assign(category, { release: undefined });
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect.poll(() => Boolean(category.release)).toBe(true);
  await page
    .getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true })
    .fill("fr-CA");
  category.release?.();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toHaveCount(0);
  await expect(page.getByText(/1 proposed Categories/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  category.mode = "Allow";
  await page
    .getByRole("textbox", { name: "Default locale (for example en-CA)", exact: true })
    .fill("en-CA");
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toBeChecked();
  expect(control.bodies).toHaveLength(0);
});

// Ordinary editor HTTP is real local browser traffic; Category policy/editor/receipts remain synthetic.
async function classifiedDraftCategories(page: Page) {
  const control = await completeDraftSources(page, "EmptySku");
  control.draft = {
    categoryClassification: { categoryReferences: [id(50)], primaryCategoryReference: id(50) },
  };
  await page.getByRole("button", { name: "Discard local edits and reload", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
  ).toBeVisible();
  const category = {
    mode: "Allow",
    calls: 0,
    age: 0,
    release: undefined as (() => void) | undefined,
  };
  await page.route("**/merchant/catalog/products/category-lookup", async (route) => {
    category.calls++;
    expect(new URL(route.request().url()).search).toBe("");
    expect(
      JSON.parse(
        Buffer.from(
          route.request().headers()["x-bop-product-category-lookup"] ?? "",
          "base64url",
        ).toString(),
      ),
    ).toEqual({ parentScreenId: "CAT-PRODUCT-EDIT" });
    if (category.mode === "Slow")
      await new Promise<void>((resolve) => {
        category.release = resolve;
      });
    const at = new Date(Date.now() - category.age).toISOString();
    await route.fulfill({
      status:
        category.mode === "Denied"
          ? 403
          : ["Disabled", "Stale"].includes(category.mode)
            ? 409
            : 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(
        category.mode === "Denied"
          ? { error: "request_denied" }
          : category.mode === "Disabled"
            ? { error: "product_category_lookup_feature_disabled" }
            : category.mode === "Stale"
              ? { error: "product_category_lookup_stale" }
              : {
                  scope: { brandReference: id(2), storeReference: id(3) },
                  lookup: {
                    projection: {
                      name: "catalog_product_category_lookup_v1",
                      version: 1,
                      asOfUtc: at,
                      stale: false,
                      partial: true,
                    },
                    parentScreenId:
                      category.mode === "WrongParent" ? "CAT-PRODUCT-CREATE" : "CAT-PRODUCT-EDIT",
                    brandReference: id(2),
                    locale: category.mode === "WrongLocale" ? "fr-CA" : "en-CA",
                    configuration: "Draft",
                    source: { revision: "3", digest: "sha256:" + "a".repeat(64), asOfUtc: at },
                    policy: { allowedLifecycles: ["Draft", "Active"] },
                    items: [0, 1].map((i) => ({
                      categoryReference: id(50 + i),
                      internalCode: i ? "CAT_B" : "CAT_A",
                      name: i ? "Synthetic Drinks" : "Synthetic Food",
                      nameLocale: "en-CA",
                      localeFallback: false,
                      lifecycle: "Draft",
                    })),
                  },
                },
      ),
    });
  });
  return { control, category };
}
test("@production classified Draft Category keyboard multi-selection primary mobile and ordinary Save", async ({
  page,
}) => {
  const { control, category } = await classifiedDraftCategories(page);
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toBeChecked();
  const drinks = page.getByRole("checkbox", { name: drinksCategory, exact: true });
  await drinks.focus();
  await page.keyboard.press("Space");
  await page.getByRole("combobox", { name: "Primary Category", exact: true }).selectOption(id(51));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  const box = await drinks.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/private/tmp/wp2421-m105-category-edit-320.png", fullPage: true });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  category.mode = "Slow";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect.poll(() => Boolean(category.release)).toBe(true);
  await page.getByRole("textbox", { name: "Attribute 1 · Decimal · KG", exact: true }).fill("2.50");
  await page
    .getByRole("checkbox", { name: "Option binding 1 allow Store override", exact: true })
    .check();
  category.release?.();
  await expect(page.getByRole("checkbox", { name: drinksCategory, exact: true })).toBeChecked();
  await expect(
    page.getByRole("textbox", { name: "Attribute 1 · Decimal · KG", exact: true }),
  ).toHaveValue("2.50");
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(JSON.parse(control.bodies[0] ?? "").draft.categoryClassification).toEqual({
    categoryReferences: [id(50), id(51)],
    primaryCategoryReference: id(51),
  });
  expect(JSON.parse(control.bodies[0] ?? "").draft.optionBindings[0].storeOverrideAllowed).toBe(
    true,
  );
  expect(JSON.parse(control.bodies[0] ?? "").draft.editorContent.attributeValues[0].value).toBe(
    "2.5",
  );
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(
    page.getByText("2 recorded Categories. Loading choices keeps existing assignments.", {
      exact: true,
    }),
  ).toBeVisible();
});
test("@production classified Draft Category refused sources preserve recorded classification and explicit empty is deliberate", async ({
  page,
}) => {
  const { control, category } = await classifiedDraftCategories(page);
  for (const mode of ["Denied", "Disabled", "WrongParent", "WrongLocale", "Stale"]) {
    category.mode = mode;
    await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toHaveCount(0);
    await expect(
      page.getByText("1 recorded Categories. Loading choices keeps existing assignments.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(control.bodies).toHaveLength(0);
  }
  category.mode = "Allow";
  category.age = 6000;
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  category.age = 0;
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await page.getByRole("button", { name: "Use no Categories", exact: true }).click();
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(JSON.parse(control.bodies[0] ?? "").draft.categoryClassification).toEqual({
    categoryReferences: [],
    primaryCategoryReference: null,
  });
});
test("@production classified Draft Category Unknown offline native denial original recovery", async ({
  page,
  context,
}) => {
  const { control, category } = await classifiedDraftCategories(page);
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await page.getByRole("checkbox", { name: drinksCategory, exact: true }).check();
  control.mode = "Unknown";
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry original Draft save", exact: true });
  await expect(retry).toBeVisible();
  const calls = category.calls;
  await context.setOffline(true);
  await expect(retry).toBeDisabled();
  await page.waitForTimeout(5100);
  await context.setOffline(false);
  control.mode = "Denied";
  await retry.click();
  await expect(page.getByText(/Save result is unknown/)).toBeVisible();
  await expect.poll(() => control.bodies.length).toBe(2);
  await expect(retry).toBeEnabled();
  control.mode = "Current";
  await retry.click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(3);
  expect(new Set(control.bodies).size).toBe(1);
  expect(category.calls).toBe(calls);
});
test("@production classified Draft Category offline cancelled lookup and expired proposal recover explicitly", async ({
  page,
  context,
}) => {
  const { control, category } = await classifiedDraftCategories(page);
  category.mode = "Slow";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect.poll(() => Boolean(category.release)).toBe(true);
  await context.setOffline(true);
  category.release?.();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toHaveCount(0);
  category.mode = "Allow";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await page.getByRole("checkbox", { name: drinksCategory, exact: true }).check();
  await page.waitForTimeout(5100);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save recorded Draft", exact: true }),
  ).toBeDisabled();
  expect(control.bodies).toHaveLength(0);
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: drinksCategory, exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
});

test("@production classified Draft Category departed late lookup never restores old choices", async ({
  page,
}) => {
  const { control, category } = await classifiedDraftCategories(page);
  category.mode = "Slow";
  await page.getByRole("button", { name: "Load current Categories", exact: true }).click();
  await expect.poll(() => Boolean(category.release)).toBe(true);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  category.release?.();
  await expect(
    page.getByRole("heading", { name: "Edit recorded Draft content", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: foodCategory, exact: true })).toHaveCount(0);
  expect(control.bodies).toHaveLength(0);
});

test("@production initial Product creation durable identity survives reload and resolves original receipt", async ({
  page,
}) => {
  const { control } = await initialCreation(page);
  let resolved = 0;
  await page.route("**/merchant/catalog/products/authoring-resolution", async (route) => {
    const request = route.request().postDataJSON() as {
      tenantReference: string;
      action: string;
      operationReference: string;
      productReference: null;
      expectedAggregateVersion: null;
    };
    expect(new URL(route.request().url()).search).toBe("");
    const original = JSON.parse(control.bodies[0] ?? "null") as {
      operationReference: string;
    } | null;
    expect(request.operationReference).toBe(original?.operationReference);
    resolved++;
    const command = {
        profile: "CatalogProductAuthoringResolutionCommandV1",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(5),
        action: "Create",
        operationReference: request.operationReference,
        productReference: null,
        expectedAggregateVersion: null,
      },
      resolution = sealPublication({
        profile: "CatalogProductAuthoringResolutionV1",
        outcome: "Committed",
        command,
        productReference: id(4),
        versionReference: id(10),
        aggregateVersion: 1,
        originalIntentDigest: hash,
        recordedAt: new Date().toISOString(),
      });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductAuthoringResolutionResultV1",
        storeReference: id(3),
        resolution,
      }),
    });
  });
  await enterCreation(page);
  await fillCreation(page);
  control.mode = "Lost";
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry original creation", exact: true }),
  ).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resolve stored creation", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Internal code", exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Resolve stored creation", exact: true }).click();
  await expect(
    page.getByText(
      "Original creation confirmed. Return to Products and reopen its current revision.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  expect(resolved).toBe(1);
  const retained = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("bop-product-authoring-pending-v1", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(Error("Synthetic IndexedDB read failed"));
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("originals", "readonly"),
          count = tx.objectStore("originals").count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(Error("Synthetic count failed"));
      });
    } finally {
      db.close();
    }
  });
  expect(retained).toBe(0);
});

test("@production complete Draft durable original recovery from current list revision", async ({
  page,
}) => {
  const control = await completeDraftSources(page);
  await page
    .getByRole("textbox", { name: "Product name · en-CA", exact: true })
    .fill("Synthetic recovery text not cached");
  control.mode = "Unknown";
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resolve stored Draft save", exact: true }),
  ).toBeVisible();
  const original = JSON.parse(control.bodies[0] ?? "null") as {
    operationReference: string;
    expectedAggregateVersion: number;
  };
  publicationRoots.set(page, () => control.revision);
  await page.route("**/merchant/catalog/products/authoring-resolution", async (route) => {
    const request = route.request().postDataJSON() as {
      operationReference: string;
      expectedAggregateVersion: number;
    };
    expect(request.operationReference).toBe(original.operationReference);
    expect(request.expectedAggregateVersion).toBe(7);
    const command = {
        profile: "CatalogProductAuthoringResolutionCommandV1",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(5),
        action: "ReplaceDraft",
        operationReference: original.operationReference,
        productReference: id(4),
        expectedAggregateVersion: 7,
      },
      resolution = sealPublication({
        profile: "CatalogProductAuthoringResolutionV1",
        outcome: "Committed",
        command,
        productReference: id(4),
        versionReference: id(10),
        aggregateVersion: 8,
        originalIntentDigest: hash,
        recordedAt: new Date().toISOString(),
      });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductAuthoringResolutionResultV1",
        storeReference: id(3),
        resolution,
      }),
    });
  });
  // Reopen from the actual current list row; a stale root7 reload is not a
  // manufactured current editor. Native server receipt coverage stays separate.
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/app/commerce/products");
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resolve stored Draft save", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Resolve stored Draft save", exact: true }).click();
  await expect(
    page.getByText("Original Draft save confirmed. Reopen the current Product before editing.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
});

// Synthetic owner HTTP records exercise the rendered ordinary entry and actual client/controller.
// They are not evidence of native IAM, persisted registry transactions or reload recovery.
async function sellingUnitAuthoringSources(page: Page) {
  const control = {
    inspections: 0,
    bodies: [] as string[],
    resolutions: [] as string[],
    lost: false,
    commit: true,
    denyResolution: false,
    version: 0,
  };
  let units: {
    unitReference: string;
    code: string;
    semanticDefinition: string;
    quantityDecimalPlaces: number;
    localizedNames: Record<string, string>;
    lifecycle: string;
  }[] = [];
  await page.route("**/merchant/catalog/products/selling-units/inspect", async (route) => {
    control.inspections++;
    const at = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductSellingUnitRegistryViewV1",
        brandReference: id(2),
        storeReference: id(3),
        presence: control.version ? "Present" : "Absent",
        registryVersion: control.version,
        defaultLocale: control.version ? "en-CA" : null,
        units,
        assignedHistory: [],
        historyDigest: hash,
        definitionsDigest: control.version ? hash : null,
        inspectionDigest: hash,
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      }),
    });
  });
  await page.route("**/merchant/catalog/products/selling-units/register", async (route) => {
    const text = route.request().postData() ?? "";
    control.bodies.push(text);
    const body = route.request().postDataJSON() as {
      operationReference: string;
      expectedRegistryVersion: number;
      units: typeof units;
    };
    expect(route.request().headers()["x-bop-csrf"]).toBe("c".repeat(43));
    expect(body.expectedRegistryVersion).toBe(0);
    expect(body.units[0]?.unitReference).toBeNull();
    if (control.bodies.length === 1) {
      if (control.commit) {
        units = body.units.map((unit, i) => ({ ...unit, unitReference: id(140 + i) }));
        control.version = 1;
      }
      if (control.lost) return route.abort("failed");
    } else expect(text).toBe(control.bodies[0]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogProductSellingUnitRegistryResultV1",
        status: control.bodies.length > 1 ? "Replayed" : "Applied",
        operationReference: body.operationReference,
        registryVersion: 1,
        snapshotDigest: hash,
      }),
    });
  });
  await page.route("**/merchant/catalog/products/selling-units/resolve", async (route) => {
    control.resolutions.push(route.request().postData() ?? "");
    if (control.denyResolution)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      });
    const request = route.request().postDataJSON() as {
      profile: string;
      tenantReference: string;
      actorReference: string;
      action: string;
      operationReference: string;
      expectedRegistryVersion: number;
    };
    const original = JSON.parse(control.bodies[0] ?? "{}");
    expect(request).toEqual({
      profile: "CatalogSellingUnitRegistrationResolutionRequestV1",
      tenantReference: id(1),
      actorReference: id(5),
      action: original.action,
      operationReference: original.operationReference,
      expectedRegistryVersion: original.expectedRegistryVersion,
    });
    const resolution = {
      profile: "CatalogSellingUnitRegistrationResolutionV1",
      outcome: control.commit ? "Committed" : "Abandoned",
      command: {
        profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(5),
        action: request.action,
        operationReference: request.operationReference,
        expectedRegistryVersion: request.expectedRegistryVersion,
      },
      registryReference: control.commit ? id(180) : null,
      versionReference: control.commit ? id(181) : null,
      registryVersion: control.commit ? 1 : null,
      originalIntentDigest: control.commit ? hash : null,
      snapshotDigest: control.commit ? hash : null,
      recordedAt: new Date().toISOString(),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        profile: "CatalogSellingUnitRegistrationResolutionResultV1",
        storeReference: id(3),
        resolution: {
          ...resolution,
          digest:
            "sha256:" + createHash("sha256").update(editorCanonical(resolution)).digest("hex"),
        },
      }),
    });
  });
  return control;
}
async function registerSyntheticUnit(page: Page, refreshAccess?: () => Promise<void>) {
  const units = page.getByRole("region", { name: "Registered selling units", exact: true });
  if (refreshAccess) await refreshAccess();
  await units
    .getByRole("button", { name: "Refresh registered selling units", exact: true })
    .click();
  await units.getByRole("button", { name: "Add unit definition", exact: true }).click();
  await units.getByRole("textbox", { name: "New unit 1 code", exact: true }).fill("PACK");
  await units
    .getByRole("textbox", { name: "New unit 1 name", exact: true })
    .fill("Synthetic package");
  await units
    .getByRole("textbox", { name: "New unit 1 meaning", exact: true })
    .fill("One synthetic package");
  await units.getByRole("textbox", { name: "New unit 1 decimal places", exact: true }).fill("2");
  if (refreshAccess) await refreshAccess();
  await units
    .getByRole("button", { name: "Refresh registered selling units", exact: true })
    .click();
  await expect(units.getByRole("textbox", { name: "New unit 1 meaning", exact: true })).toHaveValue(
    "One synthetic package",
  );
  await expect(
    units.getByRole("textbox", { name: "New unit 1 decimal places", exact: true }),
  ).toHaveValue("2");
  await units.getByRole("button", { name: "Register unit definitions", exact: true }).click();
}
async function fillSyntheticNewSku(page: Page) {
  await page.getByRole("button", { name: "Add new Draft SKU", exact: true }).click();
  await page.getByRole("textbox", { name: "New SKU 1 code", exact: true }).fill("SYNTH_PACK");
  await page
    .getByRole("textbox", { name: "New SKU 1 name · en-CA", exact: true })
    .fill("Synthetic package SKU");
  await page
    .getByRole("combobox", { name: "New SKU 1 selling unit", exact: true })
    .selectOption("PACK");
  await page.getByRole("textbox", { name: "New SKU 1 unit quantity", exact: true }).fill("0.001");
}
test("@production selling unit registration retains entered rows on refresh, exact unknown retry and ordinary new-SKU Create", async ({
  page,
}) => {
  const { control } = await initialCreation(page);
  const registry = await sellingUnitAuthoringSources(page);
  registry.lost = true;
  await page.route("**/merchant/catalog/products", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      internalCode?: string;
      operationReference: string;
      skus: { skuCode: string }[];
    };
    if (!body?.internalCode) return route.fallback();
    control.bodies.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        status: "Applied",
        scope: { brandReference: id(2), storeReference: id(3) },
        operationReference: body.operationReference,
        productReference: id(4),
        versionReference: id(10),
        aggregateVersion: 1,
        lifecycle: "Draft",
        skus: body.skus.map((sku, i) => ({
          skuReference: id(150 + i),
          skuCode: sku.skuCode,
          lifecycle: "Draft",
        })),
      }),
    });
  });
  await enterCreation(page);
  await fillCreation(page);
  const refreshAccess = async () => {
    await page
      .getByRole("button", { name: "Refresh current creation access", exact: true })
      .click();
    await expect(
      page.getByText("Current creation access loaded. Review the proposed initial Draft."),
    ).toBeVisible();
  };
  await registerSyntheticUnit(page, refreshAccess);
  await expect(
    page.getByText("Unit registration outcome is unknown.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  const beforeRetry = registry.inspections;
  await page.getByRole("button", { name: "Retry original unit registration", exact: true }).click();
  await expect(
    page.getByText("Original unit registration confirmed.", { exact: false }),
  ).toBeVisible();
  expect(registry.bodies).toHaveLength(2);
  expect(registry.bodies[1]).toBe(registry.bodies[0]);
  expect(registry.inspections).toBe(beforeRetry);
  await refreshAccess();
  await page.getByRole("button", { name: "Refresh registered selling units", exact: true }).click();
  await expect(
    page.getByText(/Synthetic package · PACK · Active · up to 2 decimal places/),
  ).toBeVisible();
  await fillSyntheticNewSku(page);
  await expect(
    page.getByRole("button", { name: "Create initial Draft", exact: true }),
  ).toBeDisabled();
  expect(control.bodies).toHaveLength(0);
  await page.getByRole("textbox", { name: "New SKU 1 unit quantity", exact: true }).fill("0.25");
  await refreshAccess();
  await page.getByRole("button", { name: "Create initial Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Original creation confirmed. New SKUs remain Draft; the Product is not published.",
    ),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  expect(JSON.parse(control.bodies[0] ?? "").skus).toEqual([
    {
      skuCode: "SYNTH_PACK",
      localizedNames: { "en-CA": "Synthetic package SKU" },
      variantSelections: [],
      unitOfSale: "PACK",
      unitQuantity: "0.25",
    },
  ]);
});
test("@production selling unit registration and first Draft SKU save followed by current owner read", async ({
  page,
}) => {
  const control = await completeDraftSources(page, "EmptySku");
  const registry = await sellingUnitAuthoringSources(page);
  const refresh = async () => {
    await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
    ).toBeVisible();
  };
  await registerSyntheticUnit(page, refresh);
  await expect(
    page.getByText("Original unit registration confirmed.", { exact: false }),
  ).toBeVisible();
  await refresh();
  await page.getByRole("button", { name: "Refresh registered selling units", exact: true }).click();
  await fillSyntheticNewSku(page);
  await expect(
    page.getByRole("button", { name: "Save recorded Draft", exact: true }),
  ).toBeDisabled();
  expect(control.bodies).toHaveLength(0);
  await page.getByRole("textbox", { name: "New SKU 1 unit quantity", exact: true }).fill("0.25");
  await refresh();
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft."),
  ).toBeVisible();
  expect(registry.bodies).toHaveLength(1);
  expect(control.bodies).toHaveLength(1);
  const saved = JSON.parse(control.bodies[0] ?? "").draft.skus;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    productReference: id(4),
    brandReference: id(2),
    skuCode: "SYNTH_PACK",
    lifecycle: "Draft",
    unitOfSale: "PACK",
    unitQuantity: "0.25",
    variantSelections: [],
  });
  await refresh();
  await expect(page.getByRole("textbox", { name: "SKU 1 unit quantity", exact: true })).toHaveValue(
    "0.25",
  );
  await expect(
    page.getByRole("textbox", { name: "SKU 1 unit quantity", exact: true }),
  ).toHaveAttribute("readonly", "");
});
test("@production new Draft SKU explicitly selects an unused owner-recorded variant combination and retains existing SKU identities", async ({
  page,
}) => {
  const control = await completeDraftSources(page);
  await sellingUnitAuthoringSources(page);
  // This additional synthetic owner record is observed through the current editor endpoint.
  // The UI may choose its explicit NotGenerated combination; it cannot create Variant values.
  const at = new Date().toISOString();
  const seeded = currentEditorFixture(at);
  const details = seeded.aggregate.draft.editorContent;
  if (!details || !details.variantDimensions[0])
    throw Error("Synthetic editor fixture missing recorded Variant dimension");
  details.variantDimensions[0].values.push({
    valueReference: id(160),
    code: "PACK",
    localizedNames: { "en-CA": "Synthetic package size" },
    sortOrder: 1,
    attributeReference: null,
    mediaReference: null,
  });
  Object.assign(details, {
    variantCombinations: [
      ...details.variantCombinations,
      {
        selections: [{ dimensionReference: id(36), valueReference: id(160) }],
        disposition: "NotGenerated",
        skuReference: null,
      },
    ],
  });
  await page.route("**/merchant/catalog/products/editor", async (route) => {
    const raw = structuredClone(seeded);
    raw.aggregateVersion = control.revision;
    raw.aggregate.aggregateVersion = control.revision;
    if (control.draft) Object.assign(raw.aggregate.draft, control.draft);
    raw.aggregate.updatedAt =
      typeof control.draft?.updatedAt === "string" ? control.draft.updatedAt : at;
    raw.observedAt = new Date().toISOString();
    raw.validUntil = new Date(Date.parse(raw.observedAt) + 5000).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        ...raw,
        digest: "sha256:" + createHash("sha256").update(editorCanonical(raw)).digest("hex"),
      }),
    });
  });
  const refresh = async () => {
    await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
    ).toBeVisible();
  };
  await registerSyntheticUnit(page, refresh);
  await expect(
    page.getByText("Original unit registration confirmed.", { exact: false }),
  ).toBeVisible();
  await refresh();
  await page.getByRole("button", { name: "Refresh registered selling units", exact: true }).click();
  await fillSyntheticNewSku(page);
  const combinations = page.getByRole("combobox", {
    name: "New SKU 1 recorded combination",
    exact: true,
  });
  await expect(combinations).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save recorded Draft", exact: true }),
  ).toBeDisabled();
  await expect(combinations.locator("option")).toHaveCount(2);
  await combinations.selectOption("1");
  await page.getByRole("textbox", { name: "New SKU 1 unit quantity", exact: true }).fill("0.25");
  await refresh();
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft."),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(1);
  const saved = JSON.parse(control.bodies[0] ?? "").draft;
  expect(saved.skus[0]).toEqual(seeded.aggregate.draft.skus[0]);
  expect(saved.skus[1]).toMatchObject({
    skuCode: "SYNTH_PACK",
    variantSelections: [{ dimensionReference: id(36), valueReference: id(160) }],
    unitOfSale: "PACK",
    unitQuantity: "0.25",
  });
  expect(saved.editorContent.variantCombinations[0]).toEqual(details.variantCombinations[0]);
  expect(saved.editorContent.variantCombinations[1]).toEqual({
    selections: [{ dimensionReference: id(36), valueReference: id(160) }],
    disposition: "Valid",
    skuReference: saved.skus[1].skuReference,
  });
  await refresh();
  await expect(page.getByRole("textbox", { name: "SKU 2 unit quantity", exact: true })).toHaveValue(
    "0.25",
  );
});
test("@production late selling unit observation cannot populate a replacement ordinary entry", async ({
  page,
}) => {
  await initialCreation(page);
  await sellingUnitAuthoringSources(page);
  let release: (() => void) | undefined;
  const captured = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  let admitted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  await page.route("**/merchant/catalog/products/selling-units/inspect", async (route) => {
    if (!first) return route.fallback();
    first = false;
    admitted?.();
    await captured;
    const at = new Date().toISOString();
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          profile: "CatalogProductSellingUnitRegistryViewV1",
          brandReference: id(2),
          storeReference: id(3),
          presence: "Present",
          registryVersion: 1,
          defaultLocale: "en-CA",
          units: [
            {
              unitReference: id(170),
              code: "OLD",
              semanticDefinition: "Synthetic old scope meaning",
              quantityDecimalPlaces: 2,
              localizedNames: { "en-CA": "Synthetic late old unit" },
              lifecycle: "Active",
            },
          ],
          assignedHistory: [],
          historyDigest: hash,
          definitionsDigest: hash,
          inspectionDigest: hash,
          observedAt: at,
          validUntil: new Date(Date.parse(at) + 5000).toISOString(),
        }),
      });
    } catch {
      /* The owning component may already have aborted its old request. */
    }
  });
  await enterCreation(page);
  await page.getByRole("button", { name: "Refresh registered selling units", exact: true }).click();
  await started;
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await page.getByRole("link", { name: "Create product", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create product", exact: true })).toBeVisible();
  release?.();
  await expect(page.getByText("Synthetic late old unit", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh registered selling units", exact: true }).click();
  await expect(page.getByText("No registered unit dictionary.", { exact: false })).toBeVisible();
  await expect(page.getByText("Synthetic late old unit", { exact: false })).toHaveCount(0);
});
async function storedSellingUnitCursors(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-selling-unit-registration-pending-v1", 1);
        open.onerror = () => reject(Error("Synthetic browser cursor read failed"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(request.result as unknown[]);
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(Error("Synthetic browser cursor transaction failed"));
          };
        };
      }),
  );
}
for (const outcome of ["Committed", "Abandoned"] as const)
  test(`@production unit registration durable reload ${outcome} retains identity-only barrier until exact original resolution`, async ({
    page,
  }) => {
    await initialCreation(page);
    const registry = await sellingUnitAuthoringSources(page);
    registry.lost = true;
    registry.commit = outcome === "Committed";
    await enterCreation(page);
    await fillCreation(page);
    const refreshAccess = async () => {
      await page
        .getByRole("button", { name: "Refresh current creation access", exact: true })
        .click();
      await expect(
        page.getByText("Current creation access loaded. Review the proposed initial Draft."),
      ).toBeVisible();
    };
    await registerSyntheticUnit(page, refreshAccess);
    await expect(
      page.getByText("Unit registration outcome is unknown.", { exact: false }),
    ).toBeVisible();
    const cursors = await storedSellingUnitCursors(page);
    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toEqual({
      profile: "CatalogSellingUnitRegistrationCursorV1",
      scope: {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: id(5),
      },
      action: "Create",
      operationReference: JSON.parse(registry.bodies[0] ?? "{}").operationReference,
      expectedRegistryVersion: 0,
    });
    expect(JSON.stringify(cursors)).not.toContain("synthetic package");
    page.on("dialog", (dialog) => dialog.accept());
    if (outcome === "Committed") await page.reload();
    else await completeDraftSources(page, "EmptySku");
    await expect(
      page.getByRole("button", { name: "Resolve stored unit registration", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry original unit registration", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh registered selling units", exact: true }),
    ).toBeDisabled();
    if (outcome === "Committed")
      await expect(
        page.getByRole("button", { name: "Create initial Draft", exact: true }),
      ).toBeDisabled();
    else
      await expect(
        page.getByRole("button", { name: "Save recorded Draft", exact: true }),
      ).toBeDisabled();
    registry.denyResolution = true;
    await page
      .getByRole("button", { name: "Resolve stored unit registration", exact: true })
      .click();
    await expect(
      page.getByText("Unit registration not confirmed: Denied.", { exact: false }),
    ).toBeVisible();
    expect(await storedSellingUnitCursors(page)).toEqual(cursors);
    expect(registry.bodies).toHaveLength(1);
    registry.denyResolution = false;
    await page
      .getByRole("button", { name: "Resolve stored unit registration", exact: true })
      .click();
    await expect(
      page.getByText(
        outcome === "Committed"
          ? "Original unit registration confirmed by its recorded receipt."
          : "The original unit registration was permanently ended without applying.",
        { exact: false },
      ),
    ).toBeVisible();
    expect(await storedSellingUnitCursors(page)).toEqual([]);
    expect(registry.bodies).toHaveLength(1);
    expect(registry.resolutions).toHaveLength(2);
    if (outcome === "Committed") await refreshAccess();
    else {
      await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Product name · en-CA", exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "Refresh registered selling units", exact: true })
      .click();
    if (outcome === "Committed")
      await expect(
        page.getByText(/Synthetic package · PACK · Active · up to 2 decimal places/),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("button", { name: "Add unit definition", exact: true }),
      ).toBeEnabled();
  });

const bindingPanel = (page: Page) =>
  page.getByRole("region", { name: "Product Option bindings", exact: true });
async function chooseExtraBinding(page: Page) {
  const panel = bindingPanel(page);
  await panel
    .getByRole("textbox", { name: "Search Option Sets", exact: true })
    .fill("SYNTH_EXTRAS");
  await panel
    .getByRole("button", { name: "Select Synthetic available extras", exact: true })
    .click();
  const group = panel.getByRole("group", { name: "Option binding 2", exact: true });
  await group
    .getByRole("textbox", { name: "Option binding 2 purpose", exact: true })
    .fill("EXTRAS");
  await group.getByRole("checkbox", { name: "Enable Synthetic extra", exact: true }).check();
  await group.getByRole("checkbox", { name: "Default EXTRA", exact: true }).check();
  await group.getByRole("textbox", { name: "Default EXTRA quantity", exact: true }).fill("2");
  await group
    .getByRole("textbox", { name: "Option binding 2 minimum override", exact: true })
    .fill("0");
  await group
    .getByRole("textbox", { name: "Option binding 2 maximum override", exact: true })
    .fill("3");
  await group.getByRole("combobox", { name: /Synthetic small SKU/u }).selectOption("Include");
  await group
    .getByRole("textbox", { name: "Option binding 2 channel codes (comma separated)", exact: true })
    .fill("WEB,POS");
  await group
    .getByRole("checkbox", { name: "Option binding 2 allow Store override", exact: true })
    .check();
  await expect(panel).toContainText("Option binding intent is ready for server revalidation.");
}
test("@production Product binding ordinary picker Add/configure/order/save/current-refresh/remove retains complete existing rules", async ({
  page,
}) => {
  const control = await completeDraftSources(page),
    before = control.baseline,
    panel = bindingPanel(page);
  if (!before) throw Error("actual initial editable Product response baseline absent");
  await chooseExtraBinding(page);
  const prepared = control.gate.picker.prepared.at(-1);
  if (!prepared) throw Error("actual controlled picker prepared identity absent");
  await panel.getByRole("button", { name: "Move binding 2 up", exact: true }).click();
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  const first = JSON.parse(control.bodies[0] ?? "{}").draft,
    binding = first.optionBindings.find((b: { purpose: string }) => b.purpose === "EXTRAS");
  expect(binding).toMatchObject({
    bindingReference: prepared.bindingReference,
    optionSetReference: id(43),
    optionSetVersionReference: id(44),
    purpose: "EXTRAS",
    sortOrder: 0,
    enabledOptionReferences: [id(501)],
    defaultSelections: [{ optionReference: id(501), quantity: 2 }],
    minimumSelectionOverride: 0,
    maximumSelectionOverride: 3,
    includedSkuReferences: [id(38)],
    excludedSkuReferences: [],
    channelCodes: ["WEB", "POS"],
    storeOverrideAllowed: true,
  });
  expect(
    first.editorContent.optionRules.find(
      (r: { bindingReference: string }) => r.bindingReference === id(39),
    ),
  ).toEqual(before.editorContent?.optionRules[0]);
  expect(
    first.editorContent.optionRules.find(
      (r: { bindingReference: string }) => r.bindingReference === prepared.bindingReference,
    ),
  ).toMatchObject({
    versionResolution: "CurrentPublished",
    pricingRule: null,
    conditionalRule: null,
    conflictRule: null,
    variantCondition: [],
  });
  expect(first.editorContent.nutritionProfile).toEqual(before.editorContent?.nutritionProfile);
  expect(first.skus).toEqual(before.skus);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  const group = panel.getByRole("group", { name: "Option binding 1", exact: true });
  await expect(
    group.getByRole("textbox", { name: "Default EXTRA quantity", exact: true }),
  ).toHaveValue("2");
  await group.getByRole("button", { name: "Remove binding 1", exact: true }).click();
  await expect(group).toContainText("Recorded history remains unchanged");
  await group.getByRole("button", { name: "Confirm binding removal", exact: true }).click();
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  const removed = JSON.parse(control.bodies[1] ?? "{}").draft;
  expect(removed.optionBindings).toHaveLength(1);
  expect(removed.optionBindings[0].bindingReference).toBe(id(39));
  expect(removed.editorContent.optionRules).toEqual(before.editorContent?.optionRules);
  expect(removed.editorContent.nutritionProfile).toEqual(before.editorContent?.nutritionProfile);
  expect(control.revision).toBe(9);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(panel.getByRole("group", { name: "Option binding 2", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const refresh = panel.getByRole("button", { name: "Refresh all Option choices", exact: true });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Option binding intent is ready for server revalidation.");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  // The current authoring context stays Actor 5; a foreign Actor in a selected
  // source packet is not an identity change that may overwrite recorded fields.
  control.gate.picker.actor = id(99);
  await refresh.click();
  await expect(panel.getByRole("alert").first()).toContainText(
    "Your identity or selected scope changed",
  );
  await expect(
    page.getByRole("button", { name: "Save recorded Draft", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("textbox", { name: "Option binding 1 purpose", exact: true }),
  ).toHaveValue("SELECT");
  expect(control.bodies).toHaveLength(2);
  control.gate.picker.actor = id(5);
  await refresh.click();
  await expect(panel).toContainText("Option binding intent is ready for server revalidation.");
});
test("@production Product CurrentPublished binding head change refuses silent version upgrade until explicit replacement", async ({
  page,
}) => {
  const control = await completeDraftSources(page),
    panel = bindingPanel(page),
    group = panel.getByRole("group", { name: "Option binding 1", exact: true });
  await group
    .getByRole("combobox", { name: "Option binding 1 version resolution", exact: true })
    .selectOption("CurrentPublished");
  control.gate.picker.head = 1;
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(panel.getByRole("alert").first()).toContainText("The selected version changed");
  expect(control.bodies).toHaveLength(0);
  await expect(group).toContainText("Synthetic available extras");
  // Existing selection stays on the actual original Frozen version after its
  // current Published head changes. The next request never silently replaces it.
  expect(control.gate.picker.requests.filter((r) => r.versionReference === null)).toHaveLength(1);
  await group
    .getByRole("button", { name: "Choose replacement for binding 1", exact: true })
    .click();
  await panel
    .getByRole("checkbox", {
      name: "Replace this binding’s selected version and clear its enabled Options, defaults and overrides",
      exact: true,
    })
    .check();
  await panel
    .getByRole("textbox", { name: "Search Option Sets", exact: true })
    .fill("SYNTH_EXTRAS");
  await panel
    .getByRole("button", { name: "Select Synthetic available extras", exact: true })
    .click();
  await expect(panel).toContainText("Option binding intent is ready for server revalidation.");
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  const saved = JSON.parse(control.bodies[0] ?? "{}").draft;
  expect(saved.optionBindings[0]).toMatchObject({
    bindingReference: id(39),
    optionSetVersionReference: id(504),
    enabledOptionReferences: [],
    defaultSelections: [],
  });
  expect(saved.editorContent.optionRules[0].versionResolution).toBe("CurrentPublished");
});
test("@production Product new binding Unknown exact original retries preserve server prepared reference and all configuration", async ({
  page,
}) => {
  const control = await completeDraftSources(page);
  await chooseExtraBinding(page);
  control.mode = "Unknown";
  await page.getByRole("button", { name: "Save recorded Draft", exact: true }).click();
  await expect(
    page.getByText(
      "Save result is unknown. Retry the original request before editing or creating another save.",
      { exact: true },
    ),
  ).toBeVisible();
  const calls = control.gate.picker.requests.length,
    original = control.bodies[0];
  await page.getByRole("button", { name: "Retry original Draft save", exact: true }).click();
  await expect(
    page.getByText("Original save confirmed. Refresh to read the current Draft.", { exact: true }),
  ).toBeVisible();
  expect(control.bodies).toHaveLength(2);
  expect(control.bodies[1]).toBe(original);
  expect(control.gate.picker.requests).toHaveLength(calls);
  expect(control.originals.size).toBe(1);
  await page.getByRole("button", { name: "Refresh editable Draft", exact: true }).click();
  await expect(
    bindingPanel(page).getByRole("textbox", { name: "Option binding 2 purpose", exact: true }),
  ).toHaveValue("EXTRAS");
  await expect(
    bindingPanel(page).getByRole("textbox", { name: "Default EXTRA quantity", exact: true }),
  ).toHaveValue("2");
});
test("@production late Product Option selection after navigation cannot reattach an abandoned editor response", async ({
  page,
}) => {
  const control = await completeDraftSources(page),
    panel = bindingPanel(page);
  let release: () => void = () => undefined,
    entered = false,
    delivered = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/merchant/catalog/products/option-binding-picker", async (route) => {
    if (route.request().postDataJSON().versionReference !== null) return route.fallback();
    entered = true;
    await pending;
    await route
      .fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: "request_denied" }),
      })
      .catch(() => undefined);
    delivered = true;
  });
  await panel
    .getByRole("textbox", { name: "Search Option Sets", exact: true })
    .fill("SYNTH_EXTRAS");
  await panel
    .getByRole("button", { name: "Select Synthetic available extras", exact: true })
    .click();
  await expect.poll(() => entered).toBe(true);
  await page.goto("/app/commerce/products");
  await expect(
    page.getByText("Synthetic tea", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  release();
  await expect.poll(() => delivered).toBe(true);
  await expect(bindingPanel(page)).toHaveCount(0);
  expect(control.bodies).toEqual([]);
});
