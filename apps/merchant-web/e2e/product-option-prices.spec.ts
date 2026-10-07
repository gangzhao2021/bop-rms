import { expect, test, type Page, type Route } from "@playwright/test";
import {
  priceBrowserId as id,
  priceBrowserCsrf as csrf,
  priceBrowserScope as scope,
  priceBrowserCreatedAt as createdAt,
  priceBrowserEditor,
  priceBrowserCurrent,
  priceBrowserWindow,
  materializePriceBrowserCommand,
} from "../src/option-price-browser-test-fixtures.js";
import {
  parseOptionPriceAuthoringCommand,
  optionPriceIntentDigest,
  type OptionPriceAuthoringState,
} from "../../../packages/rms/pricing/src/index.js";
import { createOptionPriceAuthoringClient } from "../src/option-price-authoring-client.js";
import {
  createOptionPriceReviewClient,
  parseOptionPriceReviewCommand,
} from "../src/option-price-review-client.js";
import { parseOptionPricePendingOriginal } from "../src/option-price-pending-journal.js";
// Real production-built React, public client parsing and browser IndexedDB.
// Session/IAM/Feature/policy/approval/HTTP transports below are synthetic, not PG evidence.
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
interface Review {
  state: "InReview" | "Approved";
  submittedActor: string;
  approvedActor: string | null;
  validationUntil: string;
  approvalUntil: string | null;
  latestOperation: string;
  version: number;
}
async function install(page: Page) {
  const control = {
    actor: id(70),
    removed: false,
    editorUnavailable: false,
    contextDenied: false,
    scopeDenied: false,
    loseNext: false,
    scopeReads: 0,
    currentReads: 0,
    writeBodies: [] as string[],
    resolveBodies: [] as string[],
    reviewBodies: [] as string[],
    pageErrors: [] as string[],
    sequence: 100,
  };
  const states = new Map<string, OptionPriceAuthoringState>(),
    ledger = new Map<string, Record<string, unknown>>(),
    reviews = new Map<string, Review>();
  page.on("pageerror", (error) => control.pageErrors.push(error.message));
  await page.addInitScript(() => {
    const original = indexedDB.open.bind(indexedDB);
    Object.defineProperty(window, "priceJournalOpens", { value: 0, writable: true });
    indexedDB.open = function (name: string, version?: number) {
      if (name === "bop-option-price-pending-v1")
        Reflect.set(
          window,
          "priceJournalOpens",
          Number(Reflect.get(window, "priceJournalOpens")) + 1,
        );
      return version === undefined ? original(name) : original(name, version);
    };
  });
  await page.route("**/merchant/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(3),
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
      };
      return respond(route, {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: selected,
          authorizedStores: [selected],
          navigation: [
            {
              screenId: "CAT-PRODUCT-LIST",
              href: "/app/commerce/products",
              label: "Products",
              permission: "catalog.manage",
            },
          ],
          businessDate: "2026-10-05",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    if (path === "/merchant/store-capability") {
      const key = route.request().postDataJSON().capabilityKey;
      const controlKey =
        key === "pricing.price_book_editor"
          ? "pricing.pricebook.editor"
          : key === "catalog.cat_product_detail"
            ? "catalog.product.detail"
            : key === "catalog.cat_product_list"
              ? "catalog.product.list"
              : key === "catalog.cat_product_create"
                ? "catalog.product.create"
                : "catalog.product.edit";
      return respond(route, {
        brandReference: id(2),
        storeReference: id(3),
        capabilityKey: key,
        controlKey,
        backendExecution: "Allow",
        frontendVisibility: "Show",
        reason: "Enabled",
        source: "StoreOverride",
        controlReference: id(60),
        controlVersion: 1,
        observedAt: new Date().toISOString(),
      });
    }
    if (path === "/merchant/catalog/products") {
      const unavailable = { status: "Unavailable" };
      return respond(route, {
        projection: {
          name: "catalog_product_search_v1",
          version: 1,
          asOfUtc: new Date().toISOString(),
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
            internalCode: "SYNTH_PRICE",
            name: "Synthetic price Product",
            nameLocale: "en-CA",
            localeFallback: false,
            productType: "PreparedFood",
            lifecycle: "Draft",
            aggregateVersion: 7,
            createdAt,
            updatedAt: createdAt,
            source: { productVersionReference: id(6), configuration: "Draft" },
            skuCount: 1,
            activeSkuCount: 1,
            category: unavailable,
            menuCount: unavailable,
            availability: unavailable,
            storeCoverage: unavailable,
            tax: unavailable,
            updatedBy: unavailable,
          },
        ],
      });
    }
    if (path === "/merchant/catalog/products/editor")
      return control.editorUnavailable
        ? respond(route, { error: "product_editor_unavailable" }, 503)
        : respond(route, priceBrowserEditor(control.removed));
    if (path.startsWith("/merchant/pricing/option-prices")) {
      expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
      expect(
        JSON.parse(
          Buffer.from(
            route.request().headers()["x-bop-catalog-scope"] ?? "",
            "base64url",
          ).toString(),
        ),
      ).toEqual({ brandReference: id(2), storeReference: id(3) });
      const body = route.request().postDataJSON();
      if (path.endsWith("/scope")) {
        control.scopeReads++;
        expect(body).toEqual({});
        return control.scopeDenied
          ? respond(route, { error: "request_denied" }, 403)
          : respond(route, {
              profile: "MerchantOptionPriceScopeV1",
              ...scope,
              actorReference: control.actor,
              ...priceBrowserWindow(),
            });
      }
      if (path.endsWith("/review/current")) {
        const current = states.get(body.ruleReference);
        if (!current?.draft) return respond(route, { error: "option_price_conflict" }, 409);
        const original = reviews.get(current.draft.versionReference);
        return respond(route, {
          profile: "MerchantOptionPriceReviewCurrentV1",
          ...scope,
          actorReference: control.actor,
          ruleReference: current.ruleReference,
          aggregateVersion: current.aggregateVersion,
          draftVersionReference: current.draft.versionReference,
          draftSnapshotDigest: current.draft.snapshotDigest,
          draftAuthorActorReference: current.draftAuthorActorReference,
          policy: {
            familyReference: id(80),
            policyReference: id(81),
            policyVersion: 1,
            approvalPolicy: "Required",
            effectiveFrom: createdAt,
            effectiveUntil: null,
            currentPublicationReference: id(82),
          },
          review: original
            ? {
                outcome: "Recorded",
                lifecycle: {
                  lifecycleReference: id(83),
                  version: original.version,
                  state: original.state,
                  latestMutationOperationReference: original.latestOperation,
                },
                validationValidUntil: original.validationUntil,
                approvalValidUntil: original.approvalUntil,
                submittedActorReference: original.submittedActor,
                approvedActorReference: original.approvedActor,
                sourceAuthority: "RecordedHistory",
                qualification: "NotEvaluated",
              }
            : { outcome: "Absent" },
          ...priceBrowserWindow(),
        });
      }
      if (path.endsWith("/current")) {
        control.currentReads++;
        return control.contextDenied || control.removed
          ? respond(route, { error: "request_denied" }, 403)
          : respond(route, priceBrowserCurrent([...states.values()], control.actor));
      }
      if (path.endsWith("/resolve")) {
        control.resolveBodies.push(JSON.stringify(body));
        const old = ledger.get(body.command.operationReference);
        if (old) return respond(route, { ...old, ...priceBrowserWindow() });
        return respond(route, {
          profile: path.includes("/review/")
            ? "MerchantOptionPriceReviewResultV1"
            : "MerchantOptionPriceAuthoringResultV1",
          action: body.command.action,
          operationReference: body.command.operationReference,
          ...scope,
          actorReference: control.actor,
          outcome: "Abandoned",
          ...(path.includes("/review/") ? {} : { state: null }),
          occurredAt: new Date().toISOString(),
          ...priceBrowserWindow(),
        });
      }
      if (path.endsWith("/review/command")) {
        const c = parseOptionPriceReviewCommand(body.command),
          current = states.get(c.ruleReference);
        control.reviewBodies.push(JSON.stringify(body));
        expect(current?.draft?.versionReference).toBe(c.draftVersionReference);
        expect(current?.draft?.snapshotDigest).toBe(c.draftSnapshotDigest);
        if (c.action === "SubmitReview")
          reviews.set(c.draftVersionReference, {
            state: "InReview",
            submittedActor: control.actor,
            approvedActor: null,
            validationUntil: c.validationValidUntil,
            approvalUntil: null,
            latestOperation: c.operationReference,
            version: 2,
          });
        else {
          const prior = reviews.get(c.draftVersionReference);
          expect(prior?.submittedActor).not.toBe(control.actor);
          expect(current?.draftAuthorActorReference).not.toBe(control.actor);
          if (!prior) return respond(route, { error: "option_price_conflict" }, 409);
          reviews.set(c.draftVersionReference, {
            ...prior,
            state: "Approved",
            approvedActor: control.actor,
            approvalUntil: c.approvalValidUntil,
            latestOperation: c.operationReference,
            version: 3,
          });
        }
        const receipt = {
          profile: "MerchantOptionPriceReviewResultV1",
          action: c.action,
          operationReference: c.operationReference,
          ...scope,
          actorReference: control.actor,
          outcome: "Committed",
          occurredAt: new Date().toISOString(),
          ...priceBrowserWindow(),
        };
        ledger.set(c.operationReference, receipt);
        return respond(route, receipt);
      }
      if (path.endsWith("/command")) {
        const c = parseOptionPriceAuthoringCommand(body.command),
          current = states.get(c.ruleReference) ?? null;
        control.writeBodies.push(JSON.stringify(body));
        expect(body.context).toEqual({
          productReference: id(4),
          expectedProductAggregateVersion: 7,
        });
        expect(c.expectedAggregateVersion).toBe(current?.aggregateVersion ?? null);
        if (c.action === "Publish")
          expect(current?.draft && reviews.get(current.draft.versionReference)?.state).toBe(
            "Approved",
          );
        const result = materializePriceBrowserCommand(
          c,
          current,
          control.actor,
          id(++control.sequence),
        );
        states.set(c.ruleReference, result.state);
        ledger.set(c.operationReference, result.receipt);
        expect(result.intentDigest).toBe(optionPriceIntentDigest(c));
        if (control.loseNext) {
          control.loseNext = false;
          return route.abort("failed");
        }
        return respond(route, result.receipt);
      }
    }
    return respond(route, { error: "source_unavailable" }, 503);
  });
  return { control, states };
}
const panel = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Option choice prices", exact: true }) })
    .last();
async function enter(page: Page) {
  await page.goto("/app/commerce/products");
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Option choice prices", exact: true }),
  ).toBeVisible();
}
async function choose(page: Page) {
  const p = panel(page);
  await p.getByLabel("Saved price binding").selectOption(id(22));
  await p.getByLabel("Saved price option choice").selectOption(id(23));
  await expect(p.getByText("Currency: CAD. Source eligibility: Not evaluated.")).toBeVisible();
}
async function fillPrice(page: Page, amount = "125") {
  const p = panel(page);
  await p.getByLabel("Unit amount in minor units", { exact: true }).fill(amount);
  await p.getByLabel("Included quantity", { exact: true }).fill("1");
  await p
    .getByLabel("Effective from UTC", { exact: true })
    .fill(new Date(Date.now() + 3600000).toISOString());
  await p.getByRole("button", { name: "Refresh current option prices", exact: true }).click();
  await expect(
    p.getByRole("button", { name: /Create price Draft|Save price Draft/ }),
  ).toBeEnabled();
}
async function journalSize(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const r = indexedDB.open("bop-option-price-pending-v1", 1);
        r.onerror = () => reject(new Error("Synthetic IDB read failed"));
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("originals", "readonly"),
            count = tx.objectStore("originals").count();
          count.onsuccess = () => {
            resolve(count.result);
            db.close();
          };
        };
      }),
  );
}

test("@production option choice price ordinary Draft review independent approval publication and successor retain current Published", async ({
  page,
}) => {
  const { control, states } = await install(page);
  await enter(page);
  await choose(page);
  await fillPrice(page);
  await panel(page).getByRole("button", { name: "Create price Draft", exact: true }).click();
  await expect(
    panel(page).getByText("Current Draft: 125 minor units.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(/Actual policy: Required. Review: No recorded review/),
  ).toBeVisible();
  await panel(page)
    .getByLabel("Validation valid until UTC", { exact: true })
    .fill(new Date(Date.now() + 7200000).toISOString());
  await panel(page)
    .getByRole("button", { name: "Refresh current option prices", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Submit price review", exact: true }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "Submit price review", exact: true }).click();
  await expect(panel(page).getByText(/Actual policy: Required. Review: InReview/)).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Approve price Draft", exact: true }),
  ).toBeDisabled();
  const rule = [...states.keys()][0];
  if (!rule) throw new Error("Expected created synthetic rule");
  control.actor = id(71);
  await page.reload();
  await choose(page);
  await panel(page).getByLabel("Current option price rule").selectOption(rule);
  await expect(panel(page).getByText(/Actual policy: Required. Review: InReview/)).toBeVisible();
  await panel(page)
    .getByLabel("Approval valid until UTC", { exact: true })
    .fill(new Date(Date.now() + 3600000).toISOString());
  await panel(page)
    .getByRole("button", { name: "Refresh current option prices", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Approve price Draft", exact: true }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "Approve price Draft", exact: true }).click();
  await expect(panel(page).getByText(/Actual policy: Required. Review: Approved/)).toBeVisible();
  await panel(page).getByRole("button", { name: "Publish price Draft", exact: true }).click();
  await expect(panel(page).getByText(/Current Published: 125 minor units/)).toBeVisible();
  await expect(panel(page).getByText("Current Draft: No Draft.", { exact: true })).toBeVisible();
  await fillPrice(page, "250");
  await panel(page).getByRole("button", { name: "Create price Draft", exact: true }).click();
  await expect(
    panel(page).getByText("Current Draft: 250 minor units.", { exact: true }),
  ).toBeVisible();
  await expect(panel(page).getByText(/Current Published: 125 minor units/)).toBeVisible();
  await expect(panel(page).getByText(/Review: No recorded review/)).toBeVisible();
  expect(states.get(rule)?.aggregateVersion).toBe(3);
  expect(control.writeBodies).toHaveLength(3);
  expect(control.reviewBodies).toHaveLength(2);
  expect(control.pageErrors).toEqual([]);
  expect(await journalSize(page)).toBe(0);
});

test("@production lost option price reply reload resolves exact original after Binding removal and unavailable Product without current context", async ({
  page,
}) => {
  const { control } = await install(page);
  await enter(page);
  await choose(page);
  await fillPrice(page);
  control.loseNext = true;
  await panel(page).getByRole("button", { name: "Create price Draft", exact: true }).click();
  await expect(
    panel(page).getByRole("button", { name: "Resolve original price operation 1", exact: true }),
  ).toBeVisible();
  const original = JSON.parse(control.writeBodies[0] ?? "null");
  expect(await journalSize(page)).toBe(1);
  control.removed = true;
  control.editorUnavailable = true;
  control.contextDenied = true;
  const before = control.currentReads;
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "Resolve original price operation 1", exact: true }),
  ).toBeVisible();
  expect(control.currentReads).toBe(before);
  await panel(page)
    .getByRole("button", { name: "Resolve original price operation 1", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Resolve original price operation 1", exact: true }),
  ).toHaveCount(0);
  expect(control.resolveBodies.map((v) => JSON.parse(v))).toEqual([{ command: original.command }]);
  expect(control.writeBodies).toHaveLength(1);
  expect(await journalSize(page)).toBe(0);
  expect(control.pageErrors).toEqual([]);
});

test("@production multiple retained price originals remain separate and current scope denial cannot open their journal or send writes", async ({
  page,
}) => {
  const { control } = await install(page);
  await enter(page);
  const noTransport: typeof fetch = async () => {
    throw new Error("No fixture transport");
  };
  const authoring = createOptionPriceAuthoringClient(noTransport).prepare({
    expectedScope: scope,
    context: { productReference: id(4), expectedProductAggregateVersion: 7 },
    command: {
      action: "CreateDraft",
      operationReference: id(201),
      ruleReference: id(202),
      expectedAggregateVersion: null,
      bindingReference: id(22),
      optionReference: id(23),
      content: {
        skuReference: null,
        scopeKind: "Brand",
        scopeReference: null,
        channelCode: null,
        orderType: null,
        unitAmountMinor: "125",
        includedQuantity: 1,
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: createdAt,
            localDateTime: createdAt.slice(0, 23),
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
      },
    },
  });
  const review = createOptionPriceReviewClient(noTransport).prepare({
    expectedScope: scope,
    context: {
      productReference: id(4),
      expectedProductAggregateVersion: 7,
      bindingReference: id(224),
      optionReference: id(225),
    },
    command: {
      action: "SubmitReview",
      operationReference: id(203),
      ruleReference: id(204),
      draftVersionReference: id(205),
      draftSnapshotDigest: `sha256:${"a".repeat(64)}`,
      expectedAggregateVersion: 1,
      validationValidUntil: new Date(Date.now() + 3600000).toISOString(),
      approvalValidUntil: null,
      expectedLifecycle: null,
    },
  });
  const originals = [
    {
      bindingReference: id(22),
      optionReference: id(23),
      original: parseOptionPricePendingOriginal({
        profile: "OptionPricePendingOriginalV1",
        kind: "Authoring",
        scope: authoring.scope,
        command: authoring.command,
        context: authoring.context,
      }),
    },
    {
      bindingReference: id(224),
      optionReference: id(225),
      original: parseOptionPricePendingOriginal({
        profile: "OptionPricePendingOriginalV1",
        kind: "Review",
        scope: review.scope,
        command: review.command,
        context: review.context,
      }),
    },
  ];
  await page.evaluate(
    ({ originals, scope, product }) =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("bop-option-price-pending-v1", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("originals");
        r.onerror = () => reject(new Error("Synthetic IDB write failed"));
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("originals", "readwrite");
          for (const item of originals)
            tx.objectStore("originals").put(
              item.original,
              JSON.stringify([
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                scope.actorReference,
                product,
                item.bindingReference,
                item.optionReference,
              ]),
            );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error("Synthetic IDB write failed"));
        };
      }),
    { originals, scope, product: id(4) },
  );
  control.scopeDenied = true;
  await page.reload();
  await expect(
    panel(page).getByText("You do not have permission to manage these prices.", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "priceJournalOpens"))).toBe(0);
  expect(control.writeBodies).toEqual([]);
  expect(control.resolveBodies).toEqual([]);
  control.scopeDenied = false;
  control.removed = true;
  control.editorUnavailable = true;
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "Resolve original price operation 1", exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Resolve original price operation 2", exact: true }),
  ).toBeVisible();
  expect(await journalSize(page)).toBe(2);
  await panel(page)
    .getByRole("button", { name: "Resolve original price operation 2", exact: true })
    .click();
  await expect.poll(() => journalSize(page)).toBe(1);
  await expect(
    panel(page).getByRole("button", { name: "Resolve original price operation 1", exact: true }),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Resolve original price operation 1", exact: true })
    .click();
  await expect.poll(() => journalSize(page)).toBe(0);
  expect(control.resolveBodies.map((v) => JSON.parse(v).command.operationReference)).toEqual([
    id(203),
    id(201),
  ]);
  expect(control.writeBodies).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});
