import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
} from "../../../packages/rms/pricing/src/contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialOperation,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialSummary,
  taxConfigMaterialIntentDigest,
  taxConfigMaterialContentDigest,
  type TaxConfigMaterialVersion,
  type TaxConfigMaterialOperation,
} from "../../../packages/rms/pricing/src/contracts/tax-config-material.js";
import { canonicalPublicationValue as canonical } from "../src/product-publication-command-client-v2.js";
// Production App/public clients and actual IndexedDB. All HTTP, registration,
// permission and Feature facts below are controlled synthetic inputs. This is
// rendered workflow proof, not native Session/IAM/PG or professional evidence.
const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  }),
  csrf = "A".repeat(43),
  href = "/app/commerce/tax",
  database = "bop-tax-config-material-pending-v1";
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
async function originals(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(Error("Journal read failed"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          let result: unknown[] = [];
          request.onsuccess = () => {
            result = request.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onabort = () => reject(Error("Journal read failed"));
        };
      }),
    database,
  );
}
async function install(page: Page) {
  let serial = 200;
  const versions = new Map<string, TaxConfigMaterialVersion>(),
    heads = new Map<string, TaxConfigMaterialVersion>(),
    ledger = new Map<string, TaxConfigMaterialOperation>();
  const state = {
    lose: false,
    denyResolve: false,
    denySource: false,
    failRefresh: false,
    failAfterWrite: false,
    actor: scope.actorReference,
    posts: [] as Record<string, unknown>[],
    resolves: [] as Record<string, unknown>[],
    reads: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      at = new Date().toISOString(),
      until = new Date(Date.parse(at) + 5000).toISOString(),
      selected = parseTaxConfigAuthoringScope({ ...scope, actorReference: state.actor });
    if (path === "/merchant/session") {
      const store = {
        storeReference: scope.storeReference,
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
      };
      return respond(route, {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: store,
          authorizedStores: [store],
          navigation: [
            {
              screenId: "TAX-CONFIG",
              href,
              label: "Tax Configuration",
              permission: "pricing.tax-config.manage",
            },
          ],
          businessDate: "2026-10-06",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    const prefix = "/merchant/tax-config/authoring/";
    if (!path.startsWith(prefix)) return route.abort();
    const action = path.slice(prefix.length);
    if (action === "candidates/current")
      return respond(route, {
        profile: "TaxConfigCandidateCurrentV1",
        ...selected,
        configurationReference: url.searchParams.get("configurationReference"),
        targetVersionReference: url.searchParams.get("targetVersionReference"),
        record: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    if (action === "candidates/roster")
      return respond(route, {
        profile: "TaxConfigCandidateRosterV1",
        ...selected,
        configurationReference: url.searchParams.get("configurationReference"),
        afterCandidate: url.searchParams.get("afterCandidate"),
        entries: [],
        nextAfterCandidate: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });

    if (action === "scope" || action === "current")
      return respond(
        route,
        parseTaxConfigAuthoringCurrent({
          profile: "TaxConfigAuthoringCurrentV1",
          ...selected,
          configurationReference: null,
          state: null,
          observedAt: at,
          validUntil: until,
          referenceEligibility: "NotEvaluated",
        }),
      );
    if (action === "roster")
      return respond(
        route,
        parseTaxConfigAuthoringRoster({
          profile: "TaxConfigAuthoringRosterV1",
          ...selected,
          afterConfiguration: null,
          entries: [],
          nextAfterConfiguration: null,
          observedAt: at,
          validUntil: until,
          referenceEligibility: "NotEvaluated",
        }),
      );
    if (action === "classifications")
      return respond(route, {
        profile: "TaxConfigClassificationChoicesV1",
        ...selected,
        registryReference: id(5),
        versionReference: id(6),
        registryVersion: 1,
        snapshotDigest: hash("synthetic classifications"),
        defaultLocale: "en-CA",
        choices: [
          {
            classificationReference: id(7),
            code: "SYNTHETIC",
            localizedNames: { "en-CA": "Synthetic classification" },
            lifecycle: "Active",
          },
        ],
        observedAt: at,
        validUntil: until,
        sourceQualification: "NotEvaluated",
      });
    if (!action.startsWith("materials/") && action !== "tax-registrant") return route.abort();
    const header = request.headers()["x-bop-store-setup-scope"];
    expect(header).toBeTruthy();
    const expected = parseTaxConfigAuthoringScope(
      JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")),
    );
    if (canonical(expected) !== canonical(selected))
      return respond(route, { error: "request_denied" }, 403);
    state.reads.push(action);
    if (action === "tax-registrant") {
      if (state.denySource) return respond(route, { error: "request_denied" }, 403);
      return respond(route, {
        profile: "TaxRegistrantCurrentSourceV1",
        ...selected,
        businessFunction: "TaxRegistrant",
        effectiveAt: at,
        assignmentReference: id(101),
        assignmentVersion: 1,
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        effectiveUntil: null,
        operatingEntityReference: id(102),
        entityVersion: 3,
        operatingEntityProfileVersionReference: id(103),
        profileVersion: 2,
        legalName: "Synthetic material registrant",
        jurisdictionCode: "CA-ON",
        registrationReference: id(104),
        taxRegistrationReference: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    }
    const current = (reference: string | null, version?: TaxConfigMaterialVersion | null) =>
      parseTaxConfigMaterialCurrent({
        profile: "TaxConfigMaterialCurrentV1",
        ...selected,
        materialReference: reference,
        materialKind: "RegistrationApplicability",
        version:
          version === undefined
            ? reference === null
              ? null
              : (heads.get(reference) ?? null)
            : version,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    if (action === "materials/current") {
      if (state.failRefresh) return route.abort();
      return respond(route, current(url.searchParams.get("materialReference")));
    }
    if (action === "materials/version") {
      const v = versions.get(url.searchParams.get("versionReference") ?? "");
      if (!v) return respond(route, { error: "tax_config_authoring_conflict" }, 409);
      return respond(route, current(String(v.materialReference), v));
    }
    if (action === "materials/roster")
      return respond(
        route,
        parseTaxConfigMaterialRoster({
          profile: "TaxConfigMaterialRosterV1",
          ...selected,
          materialKind: "RegistrationApplicability",
          afterMaterial: url.searchParams.get("afterMaterial"),
          entries: [...heads.values()]
            .sort((a, b) => String(a.materialReference).localeCompare(String(b.materialReference)))
            .map((v) =>
              parseTaxConfigMaterialSummary({
                tenantReference: v.tenantReference,
                brandReference: v.brandReference,
                storeReference: v.storeReference,
                materialReference: v.materialReference,
                versionReference: v.versionReference,
                revision: v.revision,
                materialKind: v.materialKind,
                contentDigest: v.contentDigest,
                recordedAt: v.recordedAt,
                status: "Recorded",
                qualification: "NotEvaluated",
              }),
            ),
          nextAfterMaterial: null,
          observedAt: at,
          validUntil: until,
          qualification: "NotEvaluated",
        }),
      );
    if (request.headers()["x-bop-csrf"] !== csrf)
      return respond(route, { error: "request_denied" }, 403);
    if (action === "materials/resolve-original") {
      if (state.denyResolve) return respond(route, { error: "request_denied" }, 403);
      const raw = request.postDataJSON(),
        c = parseTaxConfigMaterialResolve(raw);
      state.resolves.push(raw);
      expect(Object.keys(raw).sort()).toEqual(
        [
          "action",
          "operationReference",
          "materialReference",
          "expectedRevision",
          "materialKind",
          "intentDigest",
        ].sort(),
      );
      const prior = ledger.get(c.operationReference);
      if (prior) {
        if (
          prior.actorReference !== selected.actorReference ||
          prior.intentDigest !== c.intentDigest
        )
          return respond(route, { error: "request_denied" }, 403);
        return respond(route, prior);
      }
      const receipt = parseTaxConfigMaterialOperation({
        profile: "TaxConfigMaterialOperationV1",
        ...selected,
        action: c.action,
        operationReference: c.operationReference,
        materialReference: c.materialReference,
        expectedRevision: c.expectedRevision,
        materialKind: c.materialKind,
        command: null,
        intentDigest: c.intentDigest,
        outcome: "Abandoned",
        version: null,
        auditReference: id(++serial),
        eventReference: null,
        occurredAt: at,
      });
      ledger.set(c.operationReference, receipt);
      return respond(route, receipt);
    }
    if (action !== "materials/commands") return route.abort();
    const raw = request.postDataJSON(),
      command = parseTaxConfigMaterialCommand(raw);
    state.posts.push(raw);
    const stored = await originals(page);
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0] as Record<string, unknown>).sort()).toEqual(
      [
        "profile",
        "scope",
        "action",
        "operationReference",
        "materialReference",
        "expectedRevision",
        "materialKind",
        "intentDigest",
      ].sort(),
    );
    const encoded = JSON.stringify(stored);
    expect(encoded).not.toContain("content");
    expect(encoded).not.toContain("Synthetic material registrant");
    expect(encoded).not.toContain("sourceIssuedAt");
    expect(encoded).not.toContain(csrf);
    const prior = ledger.get(command.operationReference);
    if (prior) return respond(route, prior);
    const old = command.materialReference === null ? null : heads.get(command.materialReference);
    if (command.action === "ReplaceMaterial" && old?.revision !== command.expectedRevision)
      return respond(route, { error: "tax_config_authoring_conflict" }, 409);
    const version = parseTaxConfigMaterialVersion({
      profile: "TaxConfigMaterialVersionV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      materialReference: old?.materialReference ?? id(++serial),
      versionReference: id(++serial),
      revision: (old?.revision ?? 0) + 1,
      previousVersionReference: old?.versionReference ?? null,
      materialKind: command.materialKind,
      content: command.content,
      contentDigest: taxConfigMaterialContentDigest(command.content, command.materialKind),
      recordedByActorReference: selected.actorReference,
      createdAt: old?.createdAt ?? at,
      recordedAt: at,
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
    const receipt = parseTaxConfigMaterialOperation({
      profile: "TaxConfigMaterialOperationV1",
      ...selected,
      action: command.action,
      operationReference: command.operationReference,
      materialReference: command.materialReference,
      expectedRevision: command.expectedRevision,
      materialKind: command.materialKind,
      command,
      intentDigest: taxConfigMaterialIntentDigest(selected, command),
      outcome: "Committed",
      version,
      auditReference: id(++serial),
      eventReference: id(++serial),
      occurredAt: at,
    });
    versions.set(version.versionReference, version);
    heads.set(version.materialReference, version);
    ledger.set(command.operationReference, receipt);
    if (state.failAfterWrite) state.failRefresh = true;
    if (state.lose) {
      state.lose = false;
      return route.abort();
    }
    return respond(route, receipt);
  });
  return { state, versions, heads, ledger };
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Tax registration materials", exact: true });
async function fill(page: Page, applicability = "NotApplicable") {
  const p = panel(page);
  await expect(
    p.getByRole("button", { name: "Refresh registration source", exact: true }),
  ).toBeEnabled();
  await expect(
    p.getByText("Legal name: Synthetic material registrant", { exact: true }),
  ).toBeVisible();
  await expect(
    p.getByText("Tax registration reference: Not recorded", { exact: true }),
  ).toBeVisible();
  const issued = new Date(Date.now() - 1000).toISOString();
  await p.getByLabel("Declared applicability", { exact: true }).selectOption(applicability);
  await p.getByLabel("Source issued at (UTC)", { exact: true }).fill(issued);
  await p.getByLabel("Effective from (UTC)", { exact: true }).fill(issued);
}
test("@production registration materials save and replace actual sources, then read the original immutable version", async ({
  page,
}) => {
  const f = await install(page);
  await page.goto(href);
  await fill(page);
  await panel(page)
    .getByRole("button", { name: "Save registration material", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Registration material recorded. Qualification remains not evaluated.",
  );
  await expect.poll(() => f.versions.size).toBe(1);
  await expect.poll(() => originals(page)).toEqual([]);
  const original = [...f.versions.values()][0];
  if (!original) throw Error("Missing original material");
  await panel(page)
    .getByLabel("Declared applicability", { exact: true })
    .selectOption("Applicable");
  await panel(page)
    .getByRole("button", { name: "Save registration material", exact: true })
    .click();
  await expect.poll(() => f.versions.size).toBe(2);
  await expect.poll(() => originals(page)).toEqual([]);
  expect(f.state.posts).toHaveLength(2);
  await panel(page).getByRole("button", { name: "Previous saved version", exact: true }).click();
  const history = panel(page).getByRole("region", {
    name: "Historical registration material",
    exact: true,
  });
  await expect(
    history.getByRole("heading", { name: "Saved revision 1", exact: true }),
  ).toBeVisible();
  await expect(history.getByText("Not applicable", { exact: true })).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Save registration material", exact: true }),
  ).toBeDisabled();
  expect(f.versions.get(original.versionReference)).toEqual(original);
  await panel(page).getByRole("button", { name: "Reload current material", exact: true }).click();
  await expect(panel(page).getByLabel("Declared applicability", { exact: true })).toHaveValue(
    "Applicable",
  );
  await page.reload();
  await expect(
    panel(page).getByLabel("Saved registration material", { exact: true }),
  ).toBeEnabled();
  await panel(page)
    .getByLabel("Saved registration material", { exact: true })
    .selectOption(String(original.materialReference));
  await expect(panel(page).getByLabel("Declared applicability", { exact: true })).toHaveValue(
    "Applicable",
  );
  await page.screenshot({ path: "/private/tmp/wp2421-tax-material-desktop.png", fullPage: true });
  expect(f.state.errors).toEqual([]);
});
test("@production lost reply survives reload and Actor switch, resolving exact original before registration reads", async ({
  page,
}) => {
  const f = await install(page);
  f.state.lose = true;
  await page.goto(href);
  await fill(page);
  await panel(page)
    .getByRole("button", { name: "Save registration material", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material save", exact: true }),
  ).toBeEnabled();
  const original = await originals(page);
  expect(original).toHaveLength(1);
  f.state.denySource = true;
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material save", exact: true }),
  ).toBeEnabled();
  f.state.denyResolve = true;
  await panel(page)
    .getByRole("button", { name: "Recover original material save", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("permission");
  expect(await originals(page)).toEqual(original);
  f.state.actor = parseTaxConfigAuthoringScope({ ...scope, actorReference: id(90) }).actorReference;
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material save", exact: true }),
  ).toHaveCount(0);
  await expect(panel(page).getByRole("alert")).toContainText("permission");
  expect(await originals(page)).toEqual(original);
  f.state.actor = scope.actorReference;
  f.state.denyResolve = false;
  const start = f.state.reads.length;
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material save", exact: true }),
  ).toBeEnabled();
  await panel(page)
    .getByRole("button", { name: "Recover original material save", exact: true })
    .click();
  await expect.poll(() => originals(page)).toEqual([]);
  expect(f.state.reads.slice(start)).not.toContain("tax-registrant");
  expect(f.state.posts).toHaveLength(1);
  expect(f.state.resolves).toHaveLength(1);
  expect(f.state.resolves[0]?.operationReference).toBe(f.state.posts[0]?.operationReference);
  expect(f.state.errors).toEqual([]);
});
test("@production failed refresh retains original and the mobile declaration form stays keyboard usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await install(page);
  f.state.failAfterWrite = true;
  await page.goto(href);
  await fill(page);
  await panel(page)
    .getByRole("button", { name: "Save registration material", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material save", exact: true }),
  ).toBeEnabled();
  const original = await originals(page);
  expect(original).toHaveLength(1);
  expect(f.ledger.size).toBe(1);
  f.state.failAfterWrite = false;
  f.state.failRefresh = false;
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material save", exact: true }),
  ).toBeEnabled();
  await panel(page)
    .getByRole("button", { name: "Recover original material save", exact: true })
    .click();
  await expect.poll(() => originals(page)).toEqual([]);
  await panel(page)
    .getByRole("button", { name: "Refresh registration source", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Refresh registration source", exact: true }),
  ).toBeEnabled();
  await panel(page).getByLabel("Source issued at (UTC)", { exact: true }).focus();
  await expect(panel(page).getByLabel("Source issued at (UTC)", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel(page).getByLabel("Effective from (UTC)", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const button = await panel(page)
    .getByRole("button", { name: "Save registration material", exact: true })
    .boundingBox();
  expect(button?.height).toBeGreaterThanOrEqual(44);
  for (const label of [
    "Declared applicability",
    "Source issued at (UTC)",
    "Effective from (UTC)",
    "Effective until (UTC, optional)",
    "Declared source SHA-256 checksum (optional)",
  ]) {
    const box = await panel(page).getByLabel(label, { exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: "/private/tmp/wp2421-tax-material-mobile.png", fullPage: true });
  expect(
    await page
      .locator(".bop-skip-link")
      .evaluate((element) => element.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel(page).evaluate((element) => {
    (element as HTMLElement).style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(panel(page).getByLabel("Source issued at (UTC)", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/wp2421-tax-material-narrow-text.png",
    fullPage: true,
  });

  expect(f.state.posts).toHaveLength(1);
  expect(f.state.errors).toEqual([]);
});
