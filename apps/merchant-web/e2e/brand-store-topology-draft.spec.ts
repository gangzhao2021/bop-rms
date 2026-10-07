import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { canonicalizeRfc8785 } from "../../../packages/bop/audit/src/index.js";
import {
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyDraftRevision,
  parseBrandStoreTopologyCurrent,
  parseBrandStoreTopologyOperationReceipt,
  type BrandStoreTopologyDraftRevision,
  type BrandStoreTopologyOperationReceipt,
} from "../../../packages/bop/tenant/src/contracts/brand-store-topology-operation.js";
import { parseTenantStoreLabelReferenceSnapshot } from "../../../packages/bop/tenant/src/contracts/store-reference-source.js";
import { parseBrandStoreTopologyWorkbench } from "../../../apps/api/src/merchant-brand-store-topology-draft.js";
// Production App, public browser clients and real IndexedDB. HTTP, Session,
// Feature and permission facts here are explicitly controlled synthetic inputs;
// separate native acceptance supplies PG/owner proof, not this rendered fixture.
const id = (n: number) => `01902606-0030-7000-8000-${n.toString(16).padStart(12, "0")}`;
const href = `/app/organization/brands/${id(2)}`,
  prefix = "/merchant/organization/brands/topology/draft/",
  database = "bop-brand-store-topology-pending-v1";
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
const response = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
async function pending(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(new Error("Journal read failed"));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("originals")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          let result: unknown[] = [];
          request.onsuccess = () => {
            result = request.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onabort = () => reject(new Error("Journal read failed"));
        };
      }),
    database,
  );
}
async function fixture(page: Page) {
  const seededAt = new Date().toISOString(),
    history: BrandStoreTopologyDraftRevision[] = [],
    operations = new Map<string, BrandStoreTopologyOperationReceipt>();
  let serial = 100;
  const state = {
    actorReference: scope.actorReference,
    csrf: "A".repeat(43),
    lose: false,
    denyResolve: false,
    disabled: false,
    foreignReply: false,
    delayWorkspace: false,
    release: (): void => undefined,
    posts: [] as Record<string, unknown>[],
    resolutions: [] as Record<string, unknown>[],
    workspaceRequests: [] as Record<string, unknown>[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  const actualScope = () => ({ ...scope, actorReference: state.actorReference });
  const workspace = () => {
    const at = new Date().toISOString(),
      validUntil = new Date(Date.parse(at) + 5000).toISOString(),
      reader = actualScope(),
      latest = history[history.length - 1] ?? null;
    const current = parseBrandStoreTopologyCurrent(
      {
        profile: "BrandStoreTopologyCurrentV1",
        ...reader,
        current: latest,
        observedAt: at,
        validUntil,
      },
      at,
    );
    const stores = parseTenantStoreLabelReferenceSnapshot({
      profile: "TenantStoreLabelReferenceV1",
      brandReference: id(2),
      brandLifecycle: "Active",
      brandVersion: "1",
      generation: "2",
      referenceCount: "2",
      originalIntentDigest: hash({ scope: reader, at }),
      observedAt: at,
      references: [
        {
          storeReference: id(6),
          lifecycle: "Suspended",
          version: "1",
          createdAt: seededAt,
          updatedAt: seededAt,
          code: "STORE_ONE",
          displayName: "Synthetic Store One",
        },
        {
          storeReference: id(7),
          lifecycle: "Active",
          version: "1",
          createdAt: seededAt,
          updatedAt: seededAt,
          code: "STORE_TWO",
          displayName: "Synthetic Store Two",
        },
      ],
    });
    return parseBrandStoreTopologyWorkbench(
      {
        profile: "BrandStoreTopologyWorkbenchV1",
        ...reader,
        current,
        history: [...history],
        stores,
        observedAt: at,
        validUntil,
        status: "DraftOnly",
      },
      at,
    );
  };
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/merchant/organization/brands/session") {
      const reader = actualScope();
      return response(route, {
        authenticated: true,
        recentMfaRequired: false,
        csrf: state.csrf,
        workspace: {
          profile: "BrandAdministrationWorkspaceV1",
          selectedScope: {
            tenantReference: reader.brandReference,
            brandReference: reader.brandReference,
            actorReference: reader.actorReference,
          },
          brand: {
            brandReference: reader.brandReference,
            label: "Synthetic topology Brand",
            lifecycle: "Active",
            version: 1,
          },
          navigation: [
            {
              screenId: "ORG-BRAND-DETAIL",
              label: "Brand",
              href,
              permission: "organization.manage",
            },
          ],
        },
      });
    }
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(6),
        storeLabel: "Synthetic Store One",
        brandLabel: "Synthetic topology Brand",
      };
      return response(route, {
        authenticated: true,
        csrf: state.csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: selected,
          authorizedStores: [selected],
          navigation: [
            {
              screenId: "ORG-BRAND-DETAIL",
              href,
              label: "Brand administration",
              permission: "organization.manage",
            },
          ],
          businessDate: "2026-10-06",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    if (!path.startsWith(prefix)) return route.abort();
    if (request.method() !== "POST" || request.headers()["x-bop-csrf"] !== state.csrf)
      return response(route, { error: "request_denied" }, 403);
    const body = request.postDataJSON() as Record<string, unknown>,
      mode = path.slice(prefix.length),
      reader = actualScope();
    if (mode === "workspace") {
      expect(Object.keys(body).sort()).toEqual(
        body.expectedScope
          ? ["expectedBrandReference", "expectedScope"]
          : ["expectedBrandReference"],
      );
      if (
        body.expectedBrandReference !== reader.brandReference ||
        (body.expectedScope &&
          canonicalizeRfc8785(body.expectedScope) !== canonicalizeRfc8785(reader))
      )
        return response(route, { error: "request_denied" }, 403);
      state.workspaceRequests.push(body);
      if (state.disabled)
        return response(route, { error: "brand_store_topology_feature_disabled" }, 503);
      const packet = workspace();
      if (state.foreignReply)
        return response(route, {
          ...packet,
          actorReference: id(99),
          current: { ...packet.current, actorReference: id(99) },
        });
      if (state.delayWorkspace) {
        state.delayWorkspace = false;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        try {
          return await response(route, packet);
        } catch {
          return;
        }
      }
      return response(route, packet);
    }
    expect(Object.keys(body).sort()).toEqual(["command", "expectedScope"]);
    if (canonicalizeRfc8785(body.expectedScope) !== canonicalizeRfc8785(reader))
      return response(route, { error: "request_denied" }, 403);
    const command =
      mode === "save"
        ? parseBrandStoreTopologySave(body.command)
        : parseBrandStoreTopologyResolve(body.command);
    expect({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
    }).toEqual(reader);
    if (mode === "resolve") {
      state.resolutions.push(body);
      if (state.denyResolve) return response(route, { error: "request_denied" }, 403);
      const original = operations.get(command.operationReference);
      if (original) {
        if (
          original.actorReference !== reader.actorReference ||
          original.expectedRevision !== command.expectedRevision ||
          original.intentDigest !==
            ("intentDigest" in command ? command.intentDigest : hash(command))
        )
          return response(route, { error: "brand_store_topology_conflict" }, 409);
        return response(route, original);
      }
      const receipt = parseBrandStoreTopologyOperationReceipt({
        profile: "BrandStoreTopologyOperationV1",
        ...reader,
        operationReference: command.operationReference,
        expectedRevision: command.expectedRevision,
        intentDigest: "intentDigest" in command ? command.intentDigest : hash(command),
        outcome: "Abandoned",
        snapshot: null,
        auditReference: id(serial++),
        occurredAt: new Date().toISOString(),
        dataClassification: "ConfigurationMetadata",
      });
      operations.set(command.operationReference, receipt);
      return response(route, receipt);
    }
    if (mode !== "save" || !("content" in command))
      throw new Error("Unexpected controlled topology operation");
    const original = operations.get(command.operationReference);
    if (original) {
      if (
        original.actorReference !== reader.actorReference ||
        original.expectedRevision !== command.expectedRevision ||
        original.intentDigest !== hash(command)
      )
        return response(route, { error: "brand_store_topology_conflict" }, 409);
      return response(route, original);
    }
    const current = history[history.length - 1];
    if (command.expectedRevision !== (current?.revision ?? 0))
      return response(route, { error: "brand_store_topology_conflict" }, 409);
    const cursors = await pending(page),
      selectedCursors = cursors
        .map(parseBrandStoreTopologyResolve)
        .filter(
          (c) =>
            c.tenantReference === reader.tenantReference &&
            c.brandReference === reader.brandReference &&
            c.actorReference === reader.actorReference,
        );
    expect(selectedCursors).toHaveLength(1);
    expect(selectedCursors[0]).toEqual({
      profile: "BrandStoreTopologyResolveV1",
      ...reader,
      operationReference: command.operationReference,
      expectedRevision: command.expectedRevision,
      intentDigest: hash(command),
    });
    expect(JSON.stringify(cursors)).not.toContain("selectors");
    expect(JSON.stringify(cursors)).not.toContain(state.csrf);
    state.posts.push(body);
    const at = new Date().toISOString(),
      auditReference = id(serial++),
      snapshotBody = {
        profile: "BrandStoreTopologyDraftRevisionV1",
        ...reader,
        revision: command.expectedRevision + 1,
        content: command.content,
        operationReference: command.operationReference,
        auditReference,
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
        dataClassification: "ConfigurationMetadata",
      };
    const snapshot = parseBrandStoreTopologyDraftRevision({
        ...snapshotBody,
        snapshotDigest: hash(snapshotBody),
      }),
      receipt = parseBrandStoreTopologyOperationReceipt({
        profile: "BrandStoreTopologyOperationV1",
        ...reader,
        operationReference: command.operationReference,
        expectedRevision: command.expectedRevision,
        intentDigest: hash(command),
        outcome: "Committed",
        snapshot,
        auditReference,
        occurredAt: at,
        dataClassification: "ConfigurationMetadata",
      });
    history.push(snapshot);
    operations.set(command.operationReference, receipt);
    if (state.lose) {
      state.lose = false;
      return route.abort("timedout");
    }
    return response(route, receipt);
  });
  return { state, history, operations };
}
async function enter(page: Page) {
  await page.goto("/app");
  await page.getByRole("link", { name: "Brand administration", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(href + "$"));
  const panel = page.getByRole("region", { name: "Brand Store topology draft", exact: true });
  await expect(panel.getByRole("button", { name: "Add selector", exact: true })).toBeEnabled();
  return panel;
}
async function addRegion(page: Page) {
  const panel = await enter(page);
  await panel.getByLabel("Selector code", { exact: true }).fill("NORTH");
  await panel.getByLabel("Selector name", { exact: true }).fill("Synthetic North region");
  await panel.getByRole("button", { name: "Add selector", exact: true }).click();
  return panel;
}
test("@production ordinary Brand topology definitions assign real Store labels, save, edit and read immutable history", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await addRegion(page);
  await panel.getByLabel("Selector kind", { exact: true }).selectOption({ label: "Store Group" });
  await panel.getByLabel("Selector code", { exact: true }).fill("OPS");
  await panel.getByLabel("Selector name", { exact: true }).fill("Synthetic operations group");
  await panel.getByRole("button", { name: "Add selector", exact: true }).click();
  await panel
    .getByLabel("Registered Store", { exact: true })
    .selectOption({ label: "STORE_ONE — Synthetic Store One (Suspended)" });
  await panel
    .getByLabel("Assignment selector", { exact: true })
    .selectOption({ label: "Region — NORTH — Synthetic North region" });
  await panel.getByRole("button", { name: "Assign Store", exact: true }).click();
  await panel
    .getByLabel("Registered Store", { exact: true })
    .selectOption({ label: "STORE_TWO — Synthetic Store Two (Active)" });
  await panel
    .getByLabel("Assignment selector", { exact: true })
    .selectOption({ label: "StoreGroup — OPS — Synthetic operations group" });
  await panel.getByRole("button", { name: "Assign Store", exact: true }).click();
  await panel.getByRole("button", { name: "Save topology draft", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Topology draft saved");
  expect(f.history).toHaveLength(1);
  expect(f.history[0]?.content.assignments).toHaveLength(2);
  expect(await pending(page)).toEqual([]);
  await panel.getByLabel("Selector 1 name", { exact: true }).fill("Synthetic changed region");
  await panel
    .getByRole("button", {
      name: "Unassign Synthetic Store Two from Synthetic operations group",
      exact: true,
    })
    .click();
  await panel.getByRole("button", { name: "Save topology draft", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Topology draft saved");
  expect(f.history).toHaveLength(2);
  await panel.getByLabel("Saved topology history", { exact: true }).selectOption("1");
  const old = panel.getByRole("region", { name: "Historical topology draft" });
  await expect(old).toContainText("Synthetic North region");
  await expect(old).toContainText("Synthetic operations group");
  await expect(panel.getByLabel("Selector 1 name", { exact: true })).toHaveValue(
    "Synthetic changed region",
  );
  await page.reload();
  await expect(panel.getByLabel("Selector 1 name", { exact: true })).toHaveValue(
    "Synthetic changed region",
  );
  expect(f.state.posts).toHaveLength(2);
  expect(f.state.errors).toEqual([]);
  await panel.screenshot({ path: test.info().outputPath("brand-topology-draft-desktop.png") });
});
test("@production lost save reply persists payload-free original; denied recovery and another Manager cannot erase it", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await addRegion(page);
  f.state.lose = true;
  await panel.getByRole("button", { name: "Save topology draft", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("OutcomeUnknown");
  const original = (await pending(page))[0];
  expect(original).toBeTruthy();
  expect(f.history).toHaveLength(1);
  f.state.denyResolve = true;
  await page.reload();
  await panel.getByRole("button", { name: "Recover original topology save", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Denied");
  expect((await pending(page))[0]).toEqual(original);
  expect(f.history).toHaveLength(1);
  f.state.actorReference = id(30);
  f.state.csrf = "B".repeat(43);
  f.state.denyResolve = false;
  await page.reload();
  await expect(panel.getByLabel("Selector 1 name", { exact: true })).toHaveValue(
    "Synthetic North region",
  );
  await expect(
    panel.getByRole("button", { name: "Recover original topology save", exact: true }),
  ).toHaveCount(0);
  expect((await pending(page))[0]).toEqual(original);
  await panel.getByLabel("Selector 1 name", { exact: true }).fill("Synthetic other Manager edit");
  await panel.getByRole("button", { name: "Save topology draft", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Topology draft saved");
  expect(f.history).toHaveLength(2);
  expect((await pending(page))[0]).toEqual(original);
  f.state.actorReference = scope.actorReference;
  f.state.csrf = "A".repeat(43);
  await page.reload();
  await panel.getByRole("button", { name: "Recover original topology save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Original request recovered");
  await expect(panel.getByLabel("Selector 1 name", { exact: true })).toHaveValue(
    "Synthetic other Manager edit",
  );
  expect(await pending(page)).toEqual([]);
  expect(f.state.posts).toHaveLength(2);
  expect(f.operations.size).toBe(2);
  expect(f.state.errors).toEqual([]);
});
test("@production active foreign replies and Disabled stay finite; Brand topology reflows at 320px with keyboard controls", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await addRegion(page);
  f.state.foreignReply = true;
  await panel.getByRole("button", { name: "Save topology draft", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("ScopeChanged");
  expect(f.state.posts).toEqual([]);
  expect(await pending(page)).toEqual([]);
  f.state.foreignReply = false;
  f.state.disabled = true;
  await panel
    .getByRole("button", { name: "Reload saved draft (discard local changes)", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("FeatureDisabled");
  expect(f.state.posts).toEqual([]);
  f.state.disabled = false;
  await panel.getByRole("button", { name: "Refresh saved topology draft", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Add selector", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: "html {font-size:200%}" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const kind = panel.getByLabel("Selector kind", { exact: true });
  await kind.focus();
  await expect(kind).toBeFocused();
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await expect(kind).toHaveValue("StoreGroup");
  const code = panel.getByLabel("Selector code", { exact: true });
  await code.focus();
  await page.keyboard.type("MOBILE");
  await page.keyboard.press("Tab");
  await expect(panel.getByLabel("Selector name", { exact: true })).toBeFocused();
  await page.keyboard.type("Synthetic mobile group");
  await page.keyboard.press("Tab");
  const add = panel.getByRole("button", { name: "Add selector", exact: true });
  await expect(add).toBeFocused();
  await expect
    .poll(() => add.evaluate((e) => e.getBoundingClientRect().height))
    .toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Enter");
  await expect(panel.getByLabel("Selector 1 name", { exact: true })).toHaveValue(
    "Synthetic mobile group",
  );
  await expect
    .poll(() => page.locator(".bop-skip-link").evaluate((e) => e.getBoundingClientRect().bottom))
    .toBeLessThanOrEqual(0);
  await panel.screenshot({
    path: test.info().outputPath("brand-topology-draft-mobile-text-zoom.png"),
  });
  expect(f.state.errors).toEqual([]);
});
test("@production late original Actor workspace reply is discarded after actual session reload", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await addRegion(page);
  f.state.delayWorkspace = true;
  const outgoing = page.waitForRequest((r) => new URL(r.url()).pathname === prefix + "workspace");
  await panel.getByRole("button", { name: "Save topology draft", exact: true }).click();
  await outgoing;
  f.state.actorReference = id(31);
  f.state.csrf = "C".repeat(43);
  await page.reload();
  await expect(panel.getByRole("button", { name: "Add selector", exact: true })).toBeEnabled();
  f.state.release();
  await expect(panel.getByLabel("Selector 1 name", { exact: true })).toHaveCount(0);
  expect(f.state.posts).toEqual([]);
  expect(await pending(page)).toEqual([]);
  expect(f.state.errors).toEqual([]);
});
