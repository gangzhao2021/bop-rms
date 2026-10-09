import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  parseDigitalReceiptTemplateArtifactSave,
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateArtifactReceipt,
  parseDigitalReceiptTemplateArtifactCurrent,
  type DigitalReceiptTemplateArtifactVersion,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-artifact.js";
import { canonicalPublicationValue } from "../src/product-publication-command-client-v2.js";
// Production App/client and real IndexedDB. HTTP facts are synthetic; no native
// IAM, PostgreSQL, template publication or professional review is claimed.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  href = `/app/organization/stores/${id(3)}/setup`;
const hash = (v: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalPublicationValue(v)).digest("hex");
const respond = (route: Route, v: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(v),
  });
async function cursors(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-receipt-template-artifact-pending-v1", 1);
        open.onerror = () => reject(new Error("journal unavailable"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            r = tx.objectStore("originals").getAll();
          let values: unknown[] = [];
          r.onsuccess = () => {
            values = r.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(values);
          };
          tx.onabort = () => reject(new Error("journal unavailable"));
        };
      }),
  );
}
async function install(page: Page) {
  const state = {
    lose: false,
    deny: false,
    conflict: false,
    posts: [] as Record<string, unknown>[],
    errors: [] as string[],
  };
  let layout: DigitalReceiptTemplateArtifactVersion | null = null,
    compliance: DigitalReceiptTemplateArtifactVersion | null = null;
  const ledger = new Map<string, ReturnType<typeof parseDigitalReceiptTemplateArtifactReceipt>>();
  page.on("pageerror", (e) => state.errors.push(e.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      at = new Date().toISOString(),
      until = new Date(Date.parse(at) + 5000).toISOString();
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
              screenId: "STORE-SETUP",
              href,
              label: "Store setup",
              permission: "organization.manage",
            },
          ],
          businessDate: "2026-10-05",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    if (path === "/merchant/store-setup" && request.method() === "GET")
      return respond(route, {
        profile: "StoreSetupWorkspaceV1",
        scope,
        store: {
          storeReference: id(3),
          code: "SYNTH_STORE",
          displayName: "Synthetic Store",
          locale: "en-CA",
          currencyCode: "CAD",
          timeZone: "America/Toronto",
          version: 1,
        },
        setup: {
          profile: "StoreSetupCurrentV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          readerActorReference: id(4),
          snapshot: null,
          observedAt: at,
          validUntil: until,
          businessReferenceValidation: "NotEvaluated",
        },
      });
    if (path === "/merchant/store-setup/references")
      return respond(route, {
        profile: "StoreSetupReferencesCurrentV1",
        ...scope,
        address: null,
        contact: null,
        observedAt: at,
        validUntil: until,
        businessReferenceValidation: "NotEvaluated",
      });
    if (path === "/merchant/store-setup/payment-configuration")
      return respond(route, {
        profile: "StorePaymentConfigurationCurrentV1",
        ...scope,
        snapshot: null,
        observedAt: at,
        validUntil: until,
        providerReadiness: "NotEvaluated",
      });
    if (path === "/merchant/store-setup/receipt-artifacts" && request.method() === "GET")
      return respond(
        route,
        parseDigitalReceiptTemplateArtifactCurrent({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...scope,
          layout,
          compliance,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    if (
      request.method() === "POST" &&
      [
        "/merchant/store-setup/receipt-artifacts/layout",
        "/merchant/store-setup/receipt-artifacts/compliance",
      ].includes(path)
    ) {
      const kind = path.endsWith("/layout") ? "Layout" : "Compliance",
        body: Record<string, unknown> = request.postDataJSON();
      state.posts.push(body);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(scope);
      expect(request.headers()["x-bop-csrf"]).toBe(csrf);
      const stored = await cursors(page);
      expect(stored).toContainEqual(
        expect.objectContaining({
          artifactKind: kind,
          operationReference: body.operationReference,
        }),
      );
      if (body.command === "ResolveOriginal") {
        if (state.deny) return respond(route, { error: "request_denied" }, 403);
        const r = ledger.get(String(body.operationReference));
        if (!r) throw new Error("missing original");
        expect(body.intentDigest).toBe(r.intentDigest);
        return respond(route, r);
      }
      if (state.conflict)
        return respond(route, { error: "receipt_template_artifact_conflict" }, 409);
      const command = parseDigitalReceiptTemplateArtifactSave({
        profile: "DigitalReceiptTemplateArtifactSaveV1",
        ...scope,
        artifactKind: kind,
        operationReference: body.operationReference,
        expectedArtifactReference: body.expectedArtifactReference,
        expectedRevision: body.expectedRevision,
        content: body.content,
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
      });
      const previous = kind === "Layout" ? layout : compliance;
      const snapshot = parseDigitalReceiptTemplateArtifactVersion({
        profile: "DigitalReceiptTemplateArtifactV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        artifactKind: kind,
        artifactReference: id(100 + state.posts.length),
        revision: command.expectedRevision + 1,
        authoredByReference: id(4),
        previousArtifactReference: command.expectedArtifactReference,
        content: command.content,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      if (kind === "Layout") layout = snapshot;
      else compliance = snapshot;
      const receipt = parseDigitalReceiptTemplateArtifactReceipt({
        profile: "DigitalReceiptTemplateArtifactReceiptV1",
        ...scope,
        artifactKind: kind,
        operationReference: command.operationReference,
        intentDigest: hash(command),
        expectedArtifactReference: command.expectedArtifactReference,
        expectedRevision: command.expectedRevision,
        outcome: "Committed",
        snapshot,
        auditReference: id(200 + state.posts.length),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      if (state.lose) {
        state.lose = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    return respond(route, { error: "fixture_unavailable" }, 503);
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/app");
  // On narrow screens the workspace navigation sits behind the Menu disclosure (WP-2423 M1).
  const compactMenu = page.locator(".workspace-sidebar__compact > summary");
  if (await compactMenu.isVisible()) await compactMenu.click();
  await page
    .getByRole("link", { name: "Store setup", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save receipt layout", exact: true }),
  ).toBeEnabled();
}
test("@production receipt presets save both kinds and reload current revisions", async ({
  page,
}) => {
  const state = await install(page);
  await open(page);
  for (const label of ["receipt layout", "required receipt fields"]) {
    await page.getByRole("button", { name: `Save ${label}`, exact: true }).click();
    await expect(
      page.getByRole("region", { name: label, exact: true }).getByText("Saved revision 1."),
    ).toBeVisible();
  }
  expect(await cursors(page)).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "receipt layout", exact: true })
      .getByText("Saved revision 1."),
  ).toBeVisible();
  expect(state.errors).toEqual([]);
});
test("@production lost receipt reply reload retains denied original then resolves exact identity", async ({
  page,
}) => {
  const state = await install(page);
  await open(page);
  state.lose = true;
  await page.getByRole("button", { name: "Save receipt layout", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original receipt layout save", exact: true }),
  ).toBeVisible();
  const original = state.posts[0];
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  state.deny = true;
  await page
    .getByRole("button", { name: "Recover original receipt layout save", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "receipt layout", exact: true }).getByRole("alert"),
  ).toContainText("permission");
  expect((await cursors(page)).length).toBe(1);
  state.deny = false;
  await page
    .getByRole("button", { name: "Recover original receipt layout save", exact: true })
    .click();
  await expect.poll(() => cursors(page)).toEqual([]);
  expect(state.posts.at(-1)).toEqual({
    command: "ResolveOriginal",
    operationReference: original?.operationReference,
    expectedArtifactReference: original?.expectedArtifactReference,
    expectedRevision: original?.expectedRevision,
    intentDigest: expect.stringMatching(/^sha256:/u),
  });
  expect(state.errors).toEqual([]);
});
test("@production mobile keyboard conflict keeps original protected", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page);
  await open(page);
  state.conflict = true;
  const save = page.getByRole("button", { name: "Save required receipt fields", exact: true });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "required receipt fields", exact: true }).getByRole("alert"),
  ).toContainText("changed");
  expect((await cursors(page)).length).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const recover = page.getByRole("button", {
    name: "Recover original required receipt fields save",
    exact: true,
  });
  await expect(recover).toBeVisible();
  await recover.focus();
  await expect(recover).toBeFocused();
  await page.screenshot({
    path: "/private/tmp/wp2421-receipt-artifacts-mobile.png",
    fullPage: true,
  });
});
