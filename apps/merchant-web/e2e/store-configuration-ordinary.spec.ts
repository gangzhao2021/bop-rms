import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  createStoreSetupDraft,
  materializeStoreSetupConfigurationVersionV2,
} from "../../../packages/rms/store/src/contracts/store-setup-draft.js";
import { parseStoreSetupCurrent } from "../../../packages/rms/store/src/contracts/store-setup-operation.js";
import { createStoreConfigurationVersion } from "../../../packages/rms/store/src/contracts/store-configuration-administration.js";
import {
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  parseStoreConfigurationOrdinaryReceipt,
  type StoreConfigurationOrdinaryReceipt,
} from "../../../packages/rms/store/src/contracts/store-configuration-original.js";
import {
  parseMerchantStoreConfigurationHistoryPage,
  parseMerchantStoreConfigurationOrdinaryWorkspace,
} from "../../api/src/merchant-store-configuration-ordinary-values.js";
import { canonicalPublicationValue as canonical } from "../src/product-publication-command-client-v2.js";
// Actual production React/router/HTTP client/IndexedDB. HTTP, Session, eligibility,
// approvals and persistence below are explicitly synthetic controlled facts,
// not evidence of native IAM, professional qualification or live Store readiness.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const csrf = "A".repeat(43),
  href = `/app/organization/stores/${id(3)}/setup`;
const at = "2026-10-05T10:00:00.000Z";
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
const baseConfiguration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(20),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "SETUP_MATERIALIZATION",
  authoredByReference: id(4),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

function savedSetup() {
  const c = baseConfiguration("Draft"),
    configured = (value: unknown) => ({ state: "Configured", value });
  const fields = [
    "source",
    "brandBaseVersionReference",
    "timeZone",
    "businessDayStartLocalTime",
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "capacityConfigurationReference",
    "enabledServiceModes",
    "weeklySchedule",
    "exceptions",
    "effectiveFrom",
    "effectiveUntil",
  ] as const;
  return createStoreSetupDraft(
    {
      profile: "StoreSetupDraftV2",
      setupDraftReference: id(30),
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authoredByReference: scope.actorReference,
      revision: 1,
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      baseConfigurationReference: null,
      content: {
        ...Object.fromEntries(fields.map((key) => [key, configured(c[key])])),
        feeContexts: configured([
          {
            chargeType: "ServiceCharge",
            state: "Enabled",
            taxClassificationReference: id(44),
            orderTypes: ["Pickup"],
          },
          { chargeType: "DeliveryFee", state: "Disabled" },
          { chargeType: "Tip", state: "Disabled" },
        ]),
      },
      createdAt: at,
      updatedAt: at,
      purposeCode: "STORE_SETUP_DRAFT",
      dataClassification: "ConfigurationMetadata",
    },
    { ...scope, defaultLocale: "en-CA", currencyCode: "CAD", baseConfigurationReference: null },
  );
}
interface OrdinaryFixtureControl {
  actor: string;
  loseNext: boolean;
  denyResolve: boolean;
  conflictResolve: boolean;
  failState: boolean;
  wrongWorkspace: boolean;
  denyHistory: boolean;
  wrongHistory: boolean;
  writes: string[];
  reads: string[];
  errors: string[];
}
async function install(page: Page) {
  // Explicitly omit actorReference from the owning snapshot (reader is envelope-only).
  const setupValue = savedSetup();
  const control: OrdinaryFixtureControl = {
    actor: scope.actorReference,
    loseNext: false,
    denyResolve: false,
    conflictResolve: false,
    failState: false,
    wrongWorkspace: false,
    denyHistory: false,
    wrongHistory: false,
    writes: [] as string[],
    reads: [] as string[],
    errors: [] as string[],
  };
  let latest: ReturnType<typeof createStoreConfigurationVersion> | null = null,
    current: ReturnType<typeof createStoreConfigurationVersion> | null = null;
  let allocation = 200;
  const ledger = new Map<string, StoreConfigurationOrdinaryReceipt>();
  const actualScope = () => ({ ...scope, actorReference: control.actor });
  const workspace = (original: StoreConfigurationOrdinaryReceipt | null = null) => {
    const observedAt = new Date().toISOString();
    return parseMerchantStoreConfigurationOrdinaryWorkspace(
      {
        profile: "StoreConfigurationOrdinaryWorkspaceV1",
        scope: actualScope(),
        latest,
        current,
        expectedHead: latest
          ? {
              configurationReference: latest.configurationReference,
              configurationVersion: latest.configurationVersion,
              contentDigest: hash(latest),
            }
          : { configurationReference: null, configurationVersion: 0, contentDigest: null },
        original,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        businessReferenceValidation: "NotEvaluated",
      },
      actualScope(),
    );
  };
  page.on("pageerror", (e) => control.errors.push(e.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
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
    if (path === "/merchant/store-setup" && request.method() === "GET") {
      const observedAt = new Date().toISOString();
      return respond(route, {
        profile: "StoreSetupWorkspaceV1",
        scope: actualScope(),
        store: {
          storeReference: id(3),
          code: "SYNTH_STORE",
          displayName: "Synthetic Store",
          locale: "en-CA",
          currencyCode: "CAD",
          timeZone: "America/Toronto",
          version: 1,
        },
        setup: parseStoreSetupCurrent({
          profile: "StoreSetupCurrentV1",
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          readerActorReference: control.actor,
          snapshot: setupValue,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        }),
      });
    }
    if (!path.startsWith("/merchant/store-configuration/ordinary"))
      return respond(route, { error: "fixture_unavailable" }, 503);
    expect(
      JSON.parse(
        Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(
          "utf8",
        ),
      ),
    ).toEqual(actualScope());
    if (path === "/merchant/store-configuration/ordinary") {
      expect(request.method()).toBe("GET");
      expect(url.searchParams.get("expectedStoreReference")).toBe(scope.storeReference);
      expect(request.postData()).toBeNull();
      control.reads.push("current");
      const value = workspace();
      return respond(
        route,
        control.wrongWorkspace
          ? { ...value, scope: { ...actualScope(), actorReference: id(99) } }
          : value,
      );
    }
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-bop-csrf"]).toBe(csrf);
    const body: Record<string, unknown> = request.postDataJSON();
    if (path === "/merchant/store-configuration/ordinary-history") {
      expect(Object.keys(body).sort()).toEqual(["beforeSequence", "expectedStoreReference"]);
      expect(body.expectedStoreReference).toBe(scope.storeReference);
      const beforeSequence = body.beforeSequence === null ? null : Number(body.beforeSequence);
      expect(
        beforeSequence === null || (Number.isSafeInteger(beforeSequence) && beforeSequence > 0),
      ).toBe(true);
      control.reads.push("history");
      if (control.denyHistory) return respond(route, { error: "request_denied" }, 403);
      const all = Array.from(ledger.values())
        .map((receipt, index) => {
          if (!receipt.operation) throw new Error("Controlled committed history absent");
          return {
            sequenceNumber: index + 1,
            operationReference: receipt.operationReference,
            command: receipt.operation.command,
            configuration: receipt.operation.configuration,
            intentDigest: receipt.operation.intentDigest,
            actorReference: receipt.actorReference,
            purposeCode: "STORE_CONFIGURATION",
            auditReference: receipt.auditReference,
            occurredAt: receipt.occurredAt,
            expectedVersion:
              receipt.operation.resultingVersion - (receipt.action === "Materialize" ? 1 : 0),
          };
        })
        .reverse()
        .filter((entry) => beforeSequence === null || entry.sequenceNumber < beforeSequence);
      const entries = all.slice(0, 2),
        observedAt = new Date().toISOString();
      const value = parseMerchantStoreConfigurationHistoryPage(
        {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          readerActorReference: control.actor,
          beforeSequence,
          entries,
          nextBeforeSequence: all.length > 2 ? entries.at(-1)?.sequenceNumber : null,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        },
        actualScope(),
        beforeSequence,
      );
      return respond(
        route,
        control.wrongHistory ? { ...value, readerActorReference: id(99) } : value,
      );
    }
    if (path === "/merchant/store-configuration/ordinary-state") {
      expect(Object.keys(body).sort()).toEqual(["expectedStoreReference", "original"]);
      expect(body.expectedStoreReference).toBe(scope.storeReference);
      const original = parseStoreConfigurationOrdinaryResolve(body.original);
      control.reads.push("original state");
      if (control.failState)
        return respond(route, { error: "store_configuration_unavailable" }, 503);
      const recorded = ledger.get(original.operationReference);
      if (!recorded) throw new Error("controlled original absent");
      expect(recorded.intentDigest).toBe(original.intentDigest);
      return respond(route, workspace(recorded));
    }
    expect(path).toBe("/merchant/store-configuration/ordinary-command");
    expect(Object.keys(body)).toEqual(["command"]);
    const raw = body.command;
    if (
      raw &&
      typeof raw === "object" &&
      "profile" in raw &&
      raw.profile === "StoreConfigurationOrdinaryResolveV1"
    ) {
      const original = parseStoreConfigurationOrdinaryResolve(raw);
      control.reads.push("resolve");
      if (control.denyResolve) return respond(route, { error: "request_denied" }, 403);
      if (control.conflictResolve)
        return respond(route, { error: "store_configuration_conflict" }, 409);
      const recorded = ledger.get(original.operationReference);
      if (!recorded) throw new Error("controlled original absent");
      expect(recorded.intentDigest).toBe(original.intentDigest);
      return respond(route, recorded);
    }
    const command = parseStoreConfigurationOrdinaryCommand(raw),
      before = workspace();
    expect(command.expectedHead).toEqual(before.expectedHead);
    expect(command.actorReference).toBe(control.actor);
    control.writes.push(command.action);
    const occurredAt = new Date().toISOString();
    if (command.action === "Materialize") {
      expect(command.setupSelector).toEqual({
        setupDraftReference: setupValue.setupDraftReference,
        sourceRevision: setupValue.revision,
        sourceSnapshotDigest: hash(setupValue),
      });
      latest = materializeStoreSetupConfigurationVersionV2(
        setupValue,
        {
          ...actualScope(),
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          baseConfigurationReference: null,
        },
        {
          configurationReference: id(allocation++),
          configurationVersion: 1,
          reasonCode: command.reasonCode,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        {
          canonicalize: canonical,
          hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        },
      );
    } else {
      if (!latest) throw new Error("controlled configuration absent");
      const lifecycle =
        command.action === "Submit"
          ? "PendingApproval"
          : command.action === "Approve"
            ? "Approved"
            : command.action === "Publish"
              ? "Published"
              : "Draft";
      if (command.action === "Approve") expect(control.actor).not.toBe(latest.authoredByReference);
      latest = createStoreConfigurationVersion({
        ...latest,
        lifecycle,
        updatedAt: occurredAt,
        ...(command.action === "Approve"
          ? { approvedByReference: control.actor, approvalEvidenceReference: id(allocation++) }
          : {}),
        ...(command.action === "Publish"
          ? { publicationReference: id(allocation++), liveGateEvidenceReference: id(allocation++) }
          : {}),
      });
    }
    const receipt = parseStoreConfigurationOrdinaryReceipt({
      ...command,
      profile: "StoreConfigurationOrdinaryReceiptV1",
      intentDigest: hash(command),
      outcome: "Committed",
      operation: {
        command: command.action === "Materialize" ? "SaveDraft" : command.action,
        operationReference: command.operationReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        intentDigest: "sha256:" + "b".repeat(64),
        resultingVersion: latest.configurationVersion,
        configuration: latest,
      },
      auditReference: id(allocation++),
      occurredAt,
      dataClassification: "ConfigurationMetadata",
    });
    ledger.set(command.operationReference, receipt);
    if (command.action === "Publish") current = latest;
    if (control.loseNext) {
      control.loseNext = false;
      await route.abort("failed");
      return;
    }
    return respond(route, receipt);
  });
  return Object.assign(control, {
    advanceHead() {
      if (!latest) throw new Error("No controlled head");
      latest = createStoreConfigurationVersion({
        ...latest,
        lifecycle: "PendingApproval",
        updatedAt: new Date().toISOString(),
      });
    },
    ledger,
  });
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Store configuration publication", exact: true });
async function enter(page: Page) {
  await page.goto("/app");
  // On narrow screens the workspace navigation sits behind the Menu disclosure (WP-2423 M1).
  const workspaceNav = page.getByRole("navigation", { name: "Workspace" });
  await workspaceNav.waitFor();
  const compactMenu = workspaceNav.locator(".workspace-sidebar__compact > summary");
  if (await compactMenu.isVisible()) await compactMenu.click();
  await page.getByRole("link", { name: "Store setup", exact: true }).click();
  await page.getByRole("button", { name: /^8\. Review$/u }).click();
  await expect(
    panel(page).getByRole("button", { name: "Create configuration from saved setup" }),
  ).toBeEnabled();
}
async function reloadReview(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /^8\. Review$/u }).click();
}
async function cursor(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-store-configuration-pending-v1", 1);
        open.onerror = () => reject(new Error("journal unavailable"));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("originals")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction("originals", "readonly"),
            read = tx.objectStore("originals").getAll();
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
          read.onerror = () => reject(new Error("journal read unavailable"));
        };
      }),
  );
}

test("ordinary Store Review materializes validates submits independently approves and publishes @production", async ({
  page,
}) => {
  const state = await install(page);
  await enter(page);
  await panel(page).getByRole("button", { name: "Create configuration from saved setup" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Materialize: Committed. Current configuration refreshed.",
  );
  await expect(
    panel(page).getByRole("region", { name: "Recorded fee configuration" }),
  ).toContainText("Service charge");
  await panel(page).getByRole("button", { name: "Validate configuration" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Validate: Committed. Current configuration refreshed.",
  );
  await panel(page).getByRole("button", { name: "Submit configuration for review" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Submit: Committed. Current configuration refreshed.",
  );
  await expect(
    panel(page).getByRole("button", { name: "Approve configuration independently" }),
  ).toBeDisabled();
  state.actor = id(80);
  await reloadReview(page);
  await expect(
    panel(page).getByRole("button", { name: "Approve configuration independently" }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "Approve configuration independently" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Approve: Committed. Current configuration refreshed.",
  );
  await panel(page).getByRole("button", { name: "Publish Store configuration" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Publish: Committed. Current configuration refreshed.",
  );
  await expect(
    panel(page).getByRole("region", { name: "Published fee configuration" }),
  ).toContainText("Service charge");
  await expect(panel(page)).toContainText("Current published configuration");
  expect(state.writes).toEqual(["Materialize", "Validate", "Submit", "Approve", "Publish"]);
  expect(await cursor(page)).toEqual([]);
  expect(state.errors).toEqual([]);
});
test("lost reply retains original through denied conflict and failed refresh then clears with successor head @production", async ({
  page,
}) => {
  const state = await install(page);
  await enter(page);
  state.loseNext = true;
  await panel(page).getByRole("button", { name: "Create configuration from saved setup" }).click();
  await expect(
    panel(page).getByRole("button", { name: "Recover original configuration request" }),
  ).toBeEnabled();
  const stored = await cursor(page);
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toMatch(
    /addressReference|contactReference|weeklySchedule|csrf|approvalEvidence/u,
  );
  state.advanceHead();
  state.denyResolve = true;
  const before = state.reads.length;
  await reloadReview(page);
  await expect(
    panel(page).getByRole("button", { name: "Recover original configuration request" }),
  ).toBeEnabled();
  expect(state.reads.slice(before)).not.toContain("current");
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("permission");
  expect(await cursor(page)).toEqual(stored);
  state.denyResolve = false;
  state.conflictResolve = true;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("changed");
  expect(await cursor(page)).toEqual(stored);
  state.conflictResolve = false;
  state.failState = true;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("unavailable");
  expect(await cursor(page)).toEqual(stored);
  state.failState = false;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("status")).toContainText("Original Materialize: Committed");
  await expect(panel(page)).toContainText("PendingApproval");
  expect(await cursor(page)).toEqual([]);
  expect(state.writes).toEqual(["Materialize"]);
  expect(state.errors).toEqual([]);
});
test("Review controls retain 320px 200 percent text keyboard and 44px targets @production", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await install(page);
  await enter(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const create = panel(page).getByRole("button", { name: "Create configuration from saved setup" });
  await create.focus();
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText("Materialize: Committed");
  for (const button of await panel(page).getByRole("button").all()) {
    const box = await button.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: "/private/tmp/wp2421-store-configuration-review-mobile.png",
    fullPage: true,
  });
});

test("actual immutable history paginates original authors and read refusal keeps pending @production", async ({
  page,
}) => {
  const state = await install(page);
  await enter(page);
  await panel(page).getByRole("button", { name: "Create configuration from saved setup" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Materialize: Committed. Current configuration refreshed.",
  );
  for (let i = 0; i < 2; i++) {
    await panel(page).getByRole("button", { name: "Validate configuration" }).click();
    await expect(panel(page).getByRole("status")).toHaveText(
      "Validate: Committed. Current configuration refreshed.",
    );
  }
  state.actor = id(80);
  await reloadReview(page);
  const history = page.getByRole("region", {
    name: "Store configuration operation history",
    exact: true,
  });
  await history.getByRole("button", { name: "Refresh configuration history" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await history.getByRole("button", { name: "Load older configuration operations" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(3);
  await expect(
    history.getByRole("button", { name: "Load older configuration operations" }),
  ).toHaveCount(0);
  await history.getByText("Recorded author and audit details", { exact: true }).first().click();
  await expect(history).toContainText(scope.actorReference);
  await expect(history).toContainText("SaveDraft");
  state.wrongHistory = true;
  await history.getByRole("button", { name: "Refresh configuration history" }).click();
  await expect(history.getByRole("alert")).toContainText("Actor changed");
  state.wrongHistory = false;
  state.loseNext = true;
  await panel(page).getByRole("button", { name: "Validate configuration" }).click();
  await expect(
    panel(page).getByRole("button", { name: "Recover original configuration request" }),
  ).toBeEnabled();
  const original = await cursor(page);
  expect(original).toHaveLength(1);
  state.denyHistory = true;
  await history.getByRole("button", { name: "Refresh configuration history" }).click();
  await expect(history.getByRole("alert")).toContainText("permission");
  expect(await cursor(page)).toEqual(original);
  state.denyHistory = false;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("status")).toContainText("Original Validate: Committed");
  expect(await cursor(page)).toEqual([]);
  expect(state.errors).toEqual([]);
});
