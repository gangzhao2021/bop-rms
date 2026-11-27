import { createHash } from "node:crypto";
import { establishedOpeningList, serveStoreSetupPanels } from "./store-setup-panels";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
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
import { followWorkspaceLink, openStoreSetupPlace } from "./workspace-navigation";
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

function savedSetup(
  unset: readonly string[] = [],
  /** b21 review: saved values that differ from the Store as it runs. */
  saved: Readonly<Record<string, unknown>> = {},
) {
  const c = { ...baseConfiguration("Draft"), ...saved },
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
        ...Object.fromEntries(
          fields.map((key) => [
            key,
            unset.includes(key) ? { state: "Unconfigured" } : configured(c[key]),
          ]),
        ),
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
  /** b21: a page of older changes fails as an outage (the v15 DEMO Store about 26 pages back). */
  olderHistoryDown: boolean;
  /** b21 review: a page of older changes carries a row the reader refuses (a later stamp). */
  olderHistoryRefusedRow: boolean;
  /** b22: older checks recorded before this test (a page of Earlier changes is 20 steps). */
  earlierSteps: number;
  wrongHistory: boolean;
  /** WP-2423 DEC-STORE-SETUP-PUBLICATION: publication checks the fixture reports as failing. */
  failing: string[] | null;
  /** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the sole-operator view the server reports to the Owner
   * who created or sent the configuration awaiting approval (null: none). */
  soleOperator: {
    status: "Effective" | "NotSet" | "OtherApprovers";
    otherApprovers: { displayName: string | null }[];
    verifiedUntil: string | null;
  } | null;
  /** Step-ups the fixture recorded (sole-operator approval needs one). */
  stepUps: number;
  /** WP-2423 (v15 D2/D3): the recorded withdrawal of the latest configuration. */
  withdrawal: {
    kind: "Withdrawn" | "Declined";
    actor: string;
    at: string;
    /** b20: the configuration withdrawn (its last step carries the withdrawal in the history). */
    configurationReference?: string;
  } | null;
  writes: string[];
  reads: string[];
  errors: string[];
}
async function install(
  page: Page,
  /** WP-2423 v15: settings the saved setup lacks, and whether a live (installed) Store runs. */
  options: {
    readonly unset?: readonly string[];
    readonly live?: boolean;
    readonly saved?: Readonly<Record<string, unknown>>;
  } = {},
) {
  // Explicitly omit actorReference from the owning snapshot (reader is envelope-only).
  const setupValue = savedSetup(options.unset, options.saved);
  const control: OrdinaryFixtureControl = {
    actor: scope.actorReference,
    loseNext: false,
    denyResolve: false,
    conflictResolve: false,
    failState: false,
    wrongWorkspace: false,
    denyHistory: false,
    olderHistoryDown: false,
    olderHistoryRefusedRow: false,
    earlierSteps: 0,
    wrongHistory: false,
    failing: null as string[] | null,
    soleOperator: null,
    stepUps: 0,
    withdrawal: null,
    writes: [] as string[],
    reads: [] as string[],
    errors: [] as string[],
  };
  let latest: ReturnType<typeof createStoreConfigurationVersion> | null = null,
    current: ReturnType<typeof createStoreConfigurationVersion> | null = options.live
      ? createStoreConfigurationVersion(baseConfiguration("Published"))
      : null;
  let allocation = 200;
  const ledger = new Map<string, StoreConfigurationOrdinaryReceipt>();
  const actualScope = () => ({ ...scope, actorReference: control.actor });
  const workspace = (original: StoreConfigurationOrdinaryReceipt | null = null) => {
    const observedAt = new Date().toISOString();
    // The server's head: the latest recorded configuration, else the published one.
    const head = latest ?? current;
    return parseMerchantStoreConfigurationOrdinaryWorkspace(
      {
        profile: "StoreConfigurationOrdinaryWorkspaceV1",
        scope: actualScope(),
        latest,
        current,
        expectedHead: head
          ? {
              configurationReference: head.configurationReference,
              configurationVersion: head.configurationVersion,
              contentDigest: hash(head),
            }
          : { configurationReference: null, configurationVersion: 0, contentDigest: null },
        original,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        businessReferenceValidation: "NotEvaluated",
        ...(control.failing !== null &&
        latest !== null &&
        ["Draft", "PendingApproval", "Approved"].includes(latest.lifecycle)
          ? {
              publicationChecks: {
                profile: "StoreConfigurationPublicationChecksV2",
                configurationReference: latest.configurationReference,
                checkedAt: observedAt,
                checks: [
                  "Tax",
                  "BrandSettings",
                  "TimeZone",
                  "BusinessDayStart",
                  "Hours",
                  "EffectiveDate",
                  "Fees",
                  "GoLive",
                  "StorePhone",
                ].map((code) => ({
                  code,
                  outcome: control.failing?.includes(code) ? "Fail" : "Pass",
                })),
              },
            }
          : {}),
        ...(control.soleOperator !== null &&
        latest !== null &&
        latest.lifecycle === "PendingApproval" &&
        latest.setupBasis !== undefined
          ? { soleOperator: control.soleOperator }
          : {}),
        ...(control.withdrawal !== null
          ? {
              latestWithdrawal: {
                kind: control.withdrawal.kind,
                withdrawnAt: control.withdrawal.at,
                byYou: control.withdrawal.actor === control.actor,
              },
            }
          : {}),
      },
      actualScope(),
    );
  };
  page.on("pageerror", (e) => control.errors.push(e.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    // Controlled second-factor check (synthetic; not native MFA evidence).
    if (path === "/merchant/identity/step-up") {
      if (request.method() === "GET") return respond(route, { validUntil: null });
      control.stepUps++;
      const now = Date.now();
      return respond(route, {
        status: "Verified",
        verifiedAt: new Date(now).toISOString(),
        validUntil: new Date(now + 15 * 60_000).toISOString(),
      });
    }
    // WP-2423 (v15 D2/D3): withdraw (own) or decline (someone else's) the latest configuration.
    if (path === "/merchant/store-configuration/withdrawal") {
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-bop-csrf"]).toBe(csrf);
      const body: Record<string, unknown> = request.postDataJSON();
      // A decline may carry the decliner's reason (fixed list); a withdrawal never does.
      const declining = latest?.authoredByReference !== control.actor;
      expect(Object.keys(body).sort()).toEqual(
        [
          "auditReference",
          "configurationReference",
          "configurationVersion",
          ...(declining && body.declineReason !== undefined ? ["declineReason"] : []),
        ].sort(),
      );
      if (!declining) expect(body.declineReason).toBeUndefined();
      if (!latest || body.configurationReference !== latest.configurationReference)
        return respond(route, { error: "store_configuration_conflict" }, 409);
      const kind = latest.authoredByReference === control.actor ? "Withdrawn" : "Declined";
      control.withdrawal = {
        kind,
        actor: control.actor,
        at: new Date().toISOString(),
        configurationReference: latest.configurationReference,
      };
      control.writes.push(kind);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ status: "Applied", kind }),
      });
    }
    if (path === "/merchant/store/opening-list") return respond(route, establishedOpeningList);
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(3),
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
        timeZone: "America/Toronto",
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
      if (control.olderHistoryDown && beforeSequence !== null)
        return respond(route, { error: "store_configuration_unavailable" }, 503);
      const recorded = Array.from(ledger.values()).map((receipt, index) => {
        if (!receipt.operation) throw new Error("Controlled committed history absent");
        return {
          sequenceNumber: control.earlierSteps + index + 1,
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
      });
      // b22: older checks of the first change, recorded before this test, so paging is real.
      const first = recorded.find((entry) => entry.command === "Validate") ?? recorded[0];
      const earlier =
        first === undefined
          ? []
          : Array.from({ length: control.earlierSteps }, (_, index) => ({
              ...first,
              command: "Validate" as const,
              expectedVersion: first.configuration.configurationVersion,
              sequenceNumber: index + 1,
              operationReference: id(70000 + index),
              auditReference: id(71000 + index),
            }));
      const all = [...earlier, ...recorded]
        .reverse()
        // b20: the withdrawn configuration's last step carries its withdrawal, as the server does.
        .map((entry, index, newestFirst) => {
          const w = control.withdrawal;
          return w !== null &&
            w.configurationReference === entry.configuration.configurationReference &&
            newestFirst.findIndex(
              (other) => other.configuration.configurationReference === w.configurationReference,
            ) === index
            ? {
                ...entry,
                withdrawal: { kind: w.kind, withdrawnAt: w.at, byYou: w.actor === control.actor },
              }
            : entry;
        })
        .filter((entry) => beforeSequence === null || entry.sequenceNumber < beforeSequence);
      const entries = all.slice(0, 20),
        observedAt = new Date().toISOString();
      const value = parseMerchantStoreConfigurationHistoryPage(
        {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          readerActorReference: control.actor,
          beforeSequence,
          entries,
          nextBeforeSequence: all.length > 20 ? entries.at(-1)?.sequenceNumber : null,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        },
        actualScope(),
        beforeSequence,
      );
      if (control.olderHistoryRefusedRow && beforeSequence !== null) {
        const [first, ...rest] = value.entries;
        if (!first) throw new Error("Controlled older history absent");
        const later = new Date(Date.parse(first.occurredAt) + 3_600_000).toISOString();
        return respond(route, {
          ...value,
          entries: [
            { ...first, configuration: { ...first.configuration, updatedAt: later } },
            ...rest,
          ],
        });
      }
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
    expect(["command", "approvalMode,command"]).toContain(Object.keys(body).sort().join(","));
    const sole = body.approvalMode === "SoleOperator";
    if (Object.hasOwn(body, "approvalMode")) expect(body.approvalMode).toBe("SoleOperator");
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
      if (command.action === "Approve" && !sole)
        expect(control.actor).not.toBe(latest.authoredByReference);
      // WP-2423: the Owner's own approval only as sole operator, in effect and re-verified.
      if (sole) {
        expect(command.action).toBe("Approve");
        expect(control.actor).toBe(latest.authoredByReference);
        if (control.soleOperator?.status !== "Effective")
          return respond(route, { error: "sole_operator_not_in_effect" }, 403);
        if (control.stepUps === 0)
          return respond(route, { error: "sole_operator_needs_verification" }, 403);
        control.writes.push("SoleOperator");
      }
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
  // The Menu drawer on phones, the closed navigation group on wider screens (UI refresh 2026-10-21).
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  await expect(
    panel(page).getByRole("button", { name: "Create the change from the saved setup" }),
  ).toBeEnabled();
}
async function reloadReview(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
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

test.beforeEach(({ page }) => serveStoreSetupPanels(page));
/** b20: screenshots for the design review at 1440, 1024 and 390, when BOP_B20_SHOTS names a folder. */
async function b20Shots(page: Page, name: string, env = "BOP_B20_SHOTS") {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const folder = process.env[env];
    if (folder) await page.screenshot({ path: `${folder}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("ordinary Store Review materializes validates submits independently approves and publishes @production", async ({
  page,
}) => {
  const state = await install(page);
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Change created from the saved setup, not yet sent for approval.",
  );
  // b19: one sentence on where it stands (what was just done said as that sentence, not repeated
  // under it); the one next step is offered alone.
  await expect(panel(page)).not.toContainText("Draft, not yet sent for approval.");
  await expect(panel(page).getByRole("button", { name: "Publish to the Store" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Check the settings again" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Settings checked, not yet sent for approval.",
  );
  await panel(page).getByRole("button", { name: "Send it for approval" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Sent for approval, waiting to be approved.",
  );
  // Your own change: another person approves it; no approve button for you.
  await expect(panel(page).getByRole("button", { name: "Approve this change" })).toHaveCount(0);
  state.actor = id(80);
  await reloadReview(page);
  await expect(panel(page).getByRole("button", { name: "Approve this change" })).toBeEnabled();
  await panel(page).getByRole("button", { name: "Approve this change" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Change approved, waiting to be published.",
  );
  await panel(page).getByRole("button", { name: "Publish to the Store" }).click();
  await expect(panel(page).getByRole("status")).toContainText(
    /^Published on .+\. Customers and staff see the new settings now\.$/u,
  );
  await expect(panel(page)).toContainText("Published on");
  await expect(panel(page)).not.toContainText(/Version \d/u);
  await expect(panel(page).getByRole("button", { name: "Publish to the Store" })).toHaveCount(0);
  await expectNoInternalText(page);
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
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
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
  await expect(panel(page).getByRole("alert")).toContainText("Your role can't save this change.");
  expect(await cursor(page)).toEqual(stored);
  state.denyResolve = false;
  state.conflictResolve = true;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("changed");
  expect(await cursor(page)).toEqual(stored);
  state.conflictResolve = false;
  state.failState = true;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("could not be loaded");
  expect(await cursor(page)).toEqual(stored);
  state.failState = false;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Change created from the saved setup.",
  );
  await expect(panel(page)).toContainText("Waiting for approval");
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
  const create = panel(page).getByRole("button", {
    name: "Create the change from the saved setup",
  });
  await create.focus();
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText(
    "Change created from the saved setup",
  );
  for (const button of await panel(page).getByRole("button").all()) {
    const box = await button.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath("wp2421-store-configuration-review-mobile.png"),
    fullPage: true,
  });
});

test("actual immutable history paginates original authors and read refusal keeps pending @production", async ({
  page,
}) => {
  const state = await install(page);
  // b22: 20 older checks, so a page (20 steps) leaves 3 to load.
  state.earlierSteps = 20;
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Change created from the saved setup, not yet sent for approval.",
  );
  for (let i = 0; i < 2; i++) {
    await panel(page).getByRole("button", { name: "Check the settings again" }).click();
    await expect(panel(page).getByRole("status")).toHaveText(
      "Settings checked, not yet sent for approval.",
    );
  }
  state.actor = id(80);
  await reloadReview(page);
  const history = page.getByRole("region", {
    name: "Store configuration operation history",
    exact: true,
  });
  // b19: earlier changes are folded; opening them reads them (again each time).
  const earlier = panel(page).getByText("Earlier changes", { exact: true });
  const reopen = async () => {
    await earlier.click();
    await earlier.click();
  };
  await earlier.click();
  await expect(history.getByRole("listitem")).toHaveCount(20);
  await history.getByRole("button", { name: "Load older changes" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(23);
  await expect(history.getByRole("button", { name: "Load older changes" })).toHaveCount(0);
  await expect(history).toContainText("Created from saved setup");
  await expect(history).not.toContainText(scope.actorReference);
  state.wrongHistory = true;
  await reopen();
  await expect(history.getByRole("alert")).toContainText("Actor changed");
  state.wrongHistory = false;
  // b19: checking again is offered to the person who made the draft (the server refuses anyone
  // else), so its author comes back for the lost reply.
  state.actor = scope.actorReference;
  await reloadReview(page);
  await earlier.click();
  await expect(history.getByRole("listitem")).toHaveCount(20);
  state.loseNext = true;
  await panel(page).getByRole("button", { name: "Check the settings again" }).click();
  await expect(
    panel(page).getByRole("button", { name: "Recover original configuration request" }),
  ).toBeEnabled();
  const original = await cursor(page);
  expect(original).toHaveLength(1);
  state.denyHistory = true;
  await reopen();
  await expect(history.getByRole("alert")).toContainText("Your role can't save this change.");
  expect(await cursor(page)).toEqual(original);
  state.denyHistory = false;
  await panel(page).getByRole("button", { name: "Recover original configuration request" }).click();
  // The open "Earlier changes" list reads again after the recovery and has its own loading
  // status beside the publication status; the publication status is the one that answers.
  await expect(
    panel(page).getByRole("status").filter({ hasText: "Settings checked" }),
  ).toBeVisible();
  expect(await cursor(page)).toEqual([]);
  expect(state.errors).toEqual([]);
});
test("a deployment without configuration publication hides the panel instead of an outage @production", async ({
  page,
}) => {
  const state = await install(page);
  // WP-2423 Q15/Q16 (v15): the pilot composes no Store configuration publication.
  await page.route(
    (url) => url.pathname === "/merchant/store-configuration/ordinary",
    (route) => respond(route, { error: "store_configuration_publication_not_offered" }, 404),
  );
  await page.goto("/app");
  // The Menu drawer on phones, the closed navigation group on wider screens (UI refresh 2026-10-21).
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  await expect(
    page.getByRole("heading", { name: "Review and publish", exact: true }),
  ).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("publication checks say what blocks publication and who must approve, at 1440, 1024 and 390 @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = ["Tax", "GoLive"];
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  const checks = panel(page).getByRole("region", { name: "Publication checks" });
  await expect(checks).toContainText("2 things need fixing");
  await expect(checks).toContainText("Tax settings are not the ones in force");
  await expect(checks).not.toContainText("Opening hours are complete.");
  await expect(panel(page)).toContainText("Approve and publish it by");
  await expect(panel(page).getByRole("button", { name: "Send it for approval" })).toBeDisabled();
  state.failing = [];
  await reloadReview(page);
  // b19: nothing to fix, so no checklist; the next step is open.
  await expect(checks).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Send it for approval" }).click();
  await expect(panel(page)).toContainText(
    "Another person with Owner access must approve it, because you made this change.",
  );
  await expect(panel(page).getByRole("button", { name: "Approve this change" })).toHaveCount(0);
  state.failing = ["GoLive"];
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await reloadReview(page);
    await expect(checks).toContainText("This Store's go-live check is not approved");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).include(".store-setup-draft-page").analyze();
    expect(
      axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious"),
      `axe at ${width}`,
    ).toEqual([]);
    await expectNoInternalText(page);
  }
  expect(state.errors).toEqual([]);
});

test("M109: a setup offering pickup can't be sent until the store has a phone, and says where to add it, at 1440, 1024 and 390 @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = ["StorePhone"];
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  const checks = panel(page).getByRole("region", { name: "Publication checks" });
  // Created and confirmed before the page is read again at each width.
  await expect(checks).toContainText("1 thing needs fixing");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await reloadReview(page);
    await expect(checks).toContainText("1 thing needs fixing");
    await expect(checks).toContainText(
      "This setup offers pickup, and pickup guests call the store about allergies or their order. Add the store's phone number in Store details, or take pickup out of the services this setup offers.",
    );
    await expect(panel(page).getByRole("button", { name: "Send it for approval" })).toBeDisabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).include(".store-setup-draft-page").analyze();
    expect(
      axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious"),
      `axe at ${width}`,
    ).toEqual([]);
    await expectNoInternalText(page);
  }
  // The phone published: the check passes and the setup can be sent.
  state.failing = [];
  await reloadReview(page);
  await expect(checks).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Send it for approval" })).toBeEnabled();
  expect(state.errors).toEqual([]);
});

test("the Owner approves their own configuration alone as sole operator, at 1440, 1024 and 390 @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = [];
  state.soleOperator = { status: "NotSet", otherApprovers: [], verifiedUntil: null };
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Change created from the saved setup, not yet sent for approval.",
  );
  await panel(page).getByRole("button", { name: "Send it for approval" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Sent for approval, waiting to be approved.",
  );
  const own = panel(page).getByRole("region", { name: "Approve your own change to the Store" });
  // Sole operator off: another person must approve, and how to change that.
  await expect(own).toContainText(
    "You made this change to the Store, so someone else who holds Owner access to this Store must approve it.",
  );
  await expect(own).toContainText("turn on Sole operator");
  await expect(own.getByRole("button", { name: "Approve this change on my own" })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Approve this change" })).toHaveCount(0);
  // On, but someone else also holds Owner access here: named.
  state.soleOperator = {
    status: "OtherApprovers",
    otherApprovers: [{ displayName: "Mia Chen" }],
    verifiedUntil: null,
  };
  await reloadReview(page);
  await expect(own).toContainText(
    "Sole operator is on, but Mia Chen also holds Owner access to this Store, so they must approve this.",
  );
  await expect(own.getByRole("button", { name: "Approve this change on my own" })).toHaveCount(0);
  // In effect: check, verify, confirm, approve alone; at every width.
  state.soleOperator = { status: "Effective", otherApprovers: [], verifiedUntil: null };
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await reloadReview(page);
    await expect(own).toContainText(
      "you are the only person who holds Owner access to this Store (sole operator), so you may approve it yourself",
    );
    await expect(own).toContainText("Every check passed.");
    await expect(own).toContainText("It will be recorded as approved by you alone.");
    await expect(own.getByRole("button", { name: "Approve this change on my own" })).toBeDisabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).include(".store-setup-draft-page").analyze();
    expect(
      axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious"),
      `axe at ${width}`,
    ).toEqual([]);
    await expectNoInternalText(page);
    await page.screenshot({
      path: test.info().outputPath(`wp2423-store-configuration-sole-operator-${width}.png`),
      fullPage: true,
    });
  }
  await own.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(own).toContainText("Verified until");
  await expect(own.getByRole("button", { name: "Approve this change on my own" })).toBeDisabled();
  await own.getByLabel("I checked this change to the Store and approve on my own").check();
  await own.getByRole("button", { name: "Approve this change on my own" }).click();
  await expect(
    panel(page).getByRole("status").filter({ hasText: "Approved by you alone" }),
  ).toHaveText("Approved by you alone as sole operator, waiting to be published.");
  await expect(own).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Publish to the Store" }).click();
  await expect(panel(page).getByRole("status")).toContainText(
    /^Published on .+\. Customers and staff see the new settings now\.$/u,
  );
  await expectNoInternalText(page);
  expect(state.writes).toEqual(["Materialize", "Submit", "Approve", "SoleOperator", "Publish"]);
  expect(state.stepUps).toBe(1);
  expect(await cursor(page)).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("someone else's open configuration is shown, cannot be replaced and can be declined, at 1440, 1024 and 390 @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = [];
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  await panel(page).getByRole("button", { name: "Send it for approval" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Sent for approval, waiting to be approved.",
  );
  // The author sees their own open change and may withdraw it.
  // b19: in one sentence, without version numbers; withdrawing is confirmed first.
  await expect(panel(page)).toContainText("Sent for approval, waiting to be approved.");
  await panel(page).getByRole("button", { name: "Withdraw this change" }).click();
  const withdraw = panel(page).getByRole("group", { name: "Withdraw this change" });
  await expect(withdraw).toContainText("The Store keeps running as it does today.");
  await withdraw.getByRole("button", { name: "Keep it" }).click();
  expect(state.writes).toEqual(["Materialize", "Submit"]);
  // Another Owner: it is shown as someone else's; creating is blocked; declining is offered.
  state.actor = id(80);
  const theirs = panel(page);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await reloadReview(page);
    await expect(theirs).toContainText("A change made by someone else: Waiting for approval.");
    await expect(theirs).toContainText(
      "A new change cannot be created until this one is approved and published, or declined.",
    );
    await expect(
      panel(page).getByRole("button", { name: "Create the change from the saved setup" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).include(".store-setup-draft-page").analyze();
    expect(
      axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious"),
      `axe at ${width}`,
    ).toEqual([]);
    await expectNoInternalText(page);
    await page.screenshot({
      path: test.info().outputPath(`wp2423-store-configuration-open-change-${width}.png`),
      fullPage: true,
    });
  }
  // WP-2423 v15: declining is confirmed first, with an optional reason.
  await theirs.getByRole("button", { name: "Decline this change" }).click();
  expect(state.writes).toEqual(["Materialize", "Submit"]);
  const confirm = theirs.getByRole("group", { name: "Decline this configuration" });
  await confirm.getByLabel("Reason (optional)").selectOption("TalkFirst");
  await confirm.getByRole("button", { name: "Decline this change" }).click();
  // WP-2423 (v15 D6): the result names only what happened; what to do next comes from the
  // current state (never "a new configuration can now be created" when it cannot).
  // b19 review: said once, as the status sentence.
  await expect(panel(page).getByRole("status")).toContainText("You declined the last change on");
  await expect(panel(page)).not.toContainText("Change declined.");
  // The saved setup was made before that change: it must be saved again first (said plainly).
  await expect(panel(page)).toContainText(
    "To make a new change, save as draft again (it then builds on the latest settings), then come back here.",
  );
  await expect(panel(page)).not.toContainText("changed after this setup was saved");
  await expect(panel(page).getByRole("button", { name: "Approve this change" })).toHaveCount(0);
  await expectNoInternalText(page);
  expect(state.writes).toEqual(["Materialize", "Submit", "Declined"]);
  expect(state.errors).toEqual([]);
});

test("WP-2423 v15: 'Use the live Store's settings' fills time zone, business day start, service modes and receipt; Review names each missing setting @production", async ({
  page,
}) => {
  const state = await install(page, {
    unset: ["timeZone", "businessDayStartLocalTime", "enabledServiceModes", "receiptReference"],
    live: true,
  });
  await page.goto("/app");
  // The Menu drawer on phones, the closed navigation group on wider screens (UI refresh 2026-10-21).
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  const missing = page.getByRole("region", { name: "Settings not set yet" });
  // b18 polish: the draft starts from the time zone and business day start the open Store runs on
  // (not saved until "Save as draft"), so only what the Store has no value for is missing.
  await expect(missing).not.toContainText("Time zone");
  await expect(missing).not.toContainText("Business day start");
  await expect(missing).toContainText("Service modes: set it in step 2, Services");
  await expect(missing).toContainText("Receipt template: set it in step 3, Fees, tax and payment");
  await expect(page.getByText("2 settings are not set yet.", { exact: false })).toBeVisible();
  // b18 review: Review says the two prefilled values are filled in but not saved, and why the
  // publication below still counts them, so the two never seem to disagree.
  const unsaved = page.getByRole("region", { name: "Filled in, not saved yet" });
  await expect(unsaved).toContainText("Time zone");
  await expect(unsaved).toContainText("Business day start");
  await expect(unsaved).toContainText("publishing below counts them as not set");
  // The publication panel names what the saved setup is missing instead of only disabling Create.
  await expect(panel(page)).toContainText(
    "Time zone (step 1, Time zone and business day); Business day start (step 1, Time zone and business day)",
  );
  await expect(
    panel(page).getByRole("button", { name: "Create the change from the saved setup" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Use the live Store’s settings" }).click();
  await expect(missing).toHaveCount(0);
  // b19: the summary compares with the Store as it runs today, in plain values without seconds.
  const summary = page.locator(".store-setup-summary");
  await expect(summary).toContainText("What changes when it is published");
  await expect(summary).toContainText(/Staying as they are: .*Business day start/u);
  await expect(summary).toContainText(/Staying as they are: .*Service modes/u);
  await expect(summary).not.toContainText("04:00:00");
  await expect(summary).not.toContainText("Already configured");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`wp2423-store-setup-live-settings-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Step 1 now holds the live Store's time zone (the inputs Save reads).
  await page.getByRole("button", { name: /^1\. Time zone and business day$/u }).click();
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toHaveValue(
    "America/Toronto",
  );
  await expect(page.getByLabel("Business day starts at (local time)")).toHaveValue("04:00");
  await expectNoInternalText(page);
  expect(state.errors).toEqual([]);
});
test("b20: a withdrawn change is listed in Earlier changes, and the Chinese status reads without stray spaces @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = [];
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  await panel(page).getByRole("button", { name: "Send it for approval" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Sent for approval, waiting to be approved.",
  );
  await panel(page).getByRole("button", { name: "Withdraw this change" }).click();
  await panel(page)
    .getByRole("group", { name: "Withdraw this change" })
    .getByRole("button", { name: "Withdraw this change" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("You withdrew the last change on");
  // The history never suggests the change is still waiting: the withdrawal is its newest row.
  await panel(page).getByText("Earlier changes", { exact: true }).click();
  const rows = panel(page).getByRole("region", { name: "Store configuration operation history" });
  await expect(rows.getByRole("listitem").first()).toContainText(/^Withdrawn by you /u);
  await expect(rows.getByRole("listitem").nth(1)).toContainText(/^Sent for approval /u);
  await b20Shots(page, "review-withdrawn-history-en");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.getByRole("button", { name: /^4\. 核对并发布$/u }).click();
  const zh = page.getByRole("region", { name: "门店配置发布", exact: true });
  await expect(zh.locator(".store-setup-publish__status")).toHaveText(
    /^你撤回了上一次修改（\d+月\d+日周. \d{2}:\d{2}），不会发布。$/u,
  );
  await zh.getByText("以前的修改", { exact: true }).click();
  await expect(zh.getByRole("listitem").first()).toContainText(/^已由你撤回 /u);
  await b20Shots(page, "review-withdrawn-history-zh-Hans");
  expect(state.writes).toEqual(["Materialize", "Submit", "Withdrawn"]);
  expect(state.errors).toEqual([]);
});
test("b20: an edit not saved yet reads from now to new on Review, and nothing says everything saved is published @production", async ({
  page,
}) => {
  const state = await install(page, { live: true });
  await page.goto("/app");
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^1\. Time zone and business day$/u }).click();
  // b22: an open Store keeps its business day start, so the unsaved edit here is the time zone.
  await page
    .getByRole("combobox", { name: "Time zone", exact: true })
    .selectOption("America/Vancouver");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  const summary = page.locator(".store-setup-summary");
  await expect(summary).toContainText("What changes when it is published");
  await expect(summary).toContainText(
    "Now Eastern time (Toronto, Ottawa, Montréal) → changes to Pacific time (Vancouver)",
  );
  await expect(summary).toContainText("Not saved yet");
  await expect(panel(page)).toContainText("Some changes on this page are not saved yet");
  await expect(panel(page)).not.toContainText("Everything saved in this setup is published.");
  await expectNoInternalText(page);
  await b20Shots(page, "review-unsaved-edit-en");
  // The language switch keeps the edit (and the step); the same summary reads in Chinese.
  await page.getByRole("button", { name: "切换到中文" }).click();
  const zh = page.locator(".store-setup-summary");
  await expect(zh).toContainText("发布后有哪些变化");
  await expect(zh).toContainText(
    "现在东部时间（多伦多、渥太华、蒙特利尔） → 改为太平洋时间（温哥华）",
  );
  await expect(zh).toContainText("尚未保存");
  await expect(
    page.getByText("切换语言后，还没保存的修改仍在这里。存为草稿后才会保留。"),
  ).toBeVisible();
  await b20Shots(page, "review-unsaved-edit-zh-Hans");
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("b21: a failed load of older changes keeps the rows and says so under the button, in both languages @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = [];
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  for (let i = 0; i < 2; i++) {
    await panel(page).getByRole("button", { name: "Check the settings again" }).click();
    await expect(panel(page).getByRole("status")).toHaveText(
      "Settings checked, not yet sent for approval.",
    );
  }
  state.olderHistoryDown = true;
  // b22: a page is 20 steps; older ones remain to load.
  state.earlierSteps = 20;
  const check = async (region: string, earlier: string, more: string, message: string) => {
    const where = page.getByRole("region", { name: region, exact: true });
    await where.getByText(earlier, { exact: true }).click();
    const history = where.locator(".store-setup-publish__history section");
    await expect(history.getByRole("listitem")).toHaveCount(20);
    await history.getByRole("button", { name: more }).click();
    const alert = history.getByRole("alert");
    await expect(alert).toHaveText(message);
    await expect(history.getByRole("listitem")).toHaveCount(20);
    // Right under the button just pressed, and in view at phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await history.getByRole("button", { name: more }).scrollIntoViewIfNeeded();
    await expect(alert).toBeInViewport();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(history).not.toContainText(/配置|仍在等待的请求会保留|更改/u);
  };
  await check(
    "Store configuration publication",
    "Earlier changes",
    "Load older changes",
    "Earlier changes could not be loaded just now. Check the connection and try again.",
  );
  await expectNoInternalText(page);
  await b20Shots(page, "history-load-older-failed-en", "BOP_B21_SHOTS");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.getByRole("button", { name: /^4\. 核对并发布$/u }).click();
  await check(
    "门店配置发布",
    "以前的修改",
    "加载更早的修改",
    "暂时无法加载以前的修改。请检查网络后再试。",
  );
  await b20Shots(page, "history-load-older-failed-zh-Hans", "BOP_B21_SHOTS");
  expect(state.errors).toEqual([]);
});
// b21 review: an older page the reader refuses is not an outage: it says that part cannot be shown
// and that work goes on, never "check the connection".
test("b21 review: older changes the page cannot read say so plainly, not as a connection problem, in both languages @production", async ({
  page,
}) => {
  const state = await install(page);
  state.failing = [];
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  for (let i = 0; i < 2; i++) {
    await panel(page).getByRole("button", { name: "Check the settings again" }).click();
    await expect(panel(page).getByRole("status")).toHaveText(
      "Settings checked, not yet sent for approval.",
    );
  }
  state.olderHistoryRefusedRow = true;
  // b22: a page is 20 steps; older ones remain to load.
  state.earlierSteps = 20;
  const check = async (region: string, earlier: string, more: string, message: string) => {
    const where = page.getByRole("region", { name: region, exact: true });
    await where.getByText(earlier, { exact: true }).click();
    const history = where.locator(".store-setup-publish__history section");
    await expect(history.getByRole("listitem")).toHaveCount(20);
    await history.getByRole("button", { name: more }).click();
    await expect(history.getByRole("alert")).toHaveText(message);
    await expect(history.getByRole("listitem")).toHaveCount(20);
    await expect(history).not.toContainText(/connection|try again|网络|再试/u);
  };
  await check(
    "Store configuration publication",
    "Earlier changes",
    "Load older changes",
    "This part of the earlier changes cannot be shown. Everything else keeps working as usual.",
  );
  await expectNoInternalText(page);
  await b20Shots(page, "history-older-refused-en", "BOP_B21_SHOTS");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.getByRole("button", { name: /^4\. 核对并发布$/u }).click();
  await check(
    "门店配置发布",
    "以前的修改",
    "加载更早的修改",
    "这部分以前的修改无法显示。其他操作不受影响，可以照常继续。",
  );
  await b20Shots(page, "history-older-refused-zh-Hans", "BOP_B21_SHOTS");
  expect(state.errors).toEqual([]);
});
test("b21: step 1 asks for the Time zone from the Canadian zones, and Review reads it from now to new @production", async ({
  page,
}) => {
  const state = await install(page, { live: true });
  await page.goto("/app");
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^1\. Time zone and business day$/u }).click();
  const zone = page.getByRole("combobox", { name: "Time zone", exact: true });
  await expect(zone.locator("optgroup")).toHaveCount(0);
  await expect(zone.locator("option")).toHaveCount(9);
  await zone.selectOption("America/Vancouver");
  await b20Shots(page, "step1-time-zone-en", "BOP_B21_SHOTS");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  const summary = page.locator(".store-setup-summary");
  await expect(summary).toContainText(
    "Now Eastern time (Toronto, Ottawa, Montréal) → changes to Pacific time (Vancouver)",
  );
  await expect(summary).toContainText("Not saved yet");
  await b20Shots(page, "review-time-zone-unsaved-en", "BOP_B21_SHOTS");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(page.locator(".store-setup-summary")).toContainText(
    "现在东部时间（多伦多、渥太华、蒙特利尔） → 改为太平洋时间（温哥华）",
  );
  await b20Shots(page, "review-time-zone-unsaved-zh-Hans", "BOP_B21_SHOTS");
  await page.getByRole("button", { name: /^1\. 时区和营业日$/u }).click();
  const zh = page.getByRole("combobox", { name: "时区", exact: true });
  await expect(zh).toHaveValue("America/Vancouver");
  await expect(zh.locator("option:checked")).toHaveText("太平洋时间（温哥华）");
  await expectNoInternalText(page);
  await b20Shots(page, "step1-time-zone-zh-Hans", "BOP_B21_SHOTS");
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
// b21 review: an edit not saved yet that puts a setting back to how the Store runs today names
// both values and stays marked not saved; in Chinese too.
test("b21 review: a setting put back to how the Store runs today names what is saved and what it goes back to @production", async ({
  page,
}) => {
  const state = await install(page, { live: true, saved: { timeZone: "America/Vancouver" } });
  await page.goto("/app");
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^1\. Time zone and business day$/u }).click();
  const zone = page.getByRole("combobox", { name: "Time zone", exact: true });
  await expect(zone).toHaveValue("America/Vancouver");
  await zone.selectOption("America/Toronto");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  const row = page.locator(".store-setup-summary__rows > div").filter({ hasText: "Time zone" });
  await expect(row).toContainText(
    "Now saved as Pacific time (Vancouver) → changes to Eastern time (Toronto, Ottawa, Montréal), as the Store runs today",
  );
  await expect(row).toContainText("Not saved yet");
  await expectNoInternalText(page);
  await b20Shots(page, "review-put-back-unsaved-en", "BOP_B21_SHOTS");
  await page.getByRole("button", { name: "切换到中文" }).click();
  const zh = page.locator(".store-setup-summary__rows > div").filter({ hasText: "时区" });
  await expect(zh).toContainText(
    "现在保存的是太平洋时间（温哥华） → 改为东部时间（多伦多、渥太华、蒙特利尔），和门店现在一样",
  );
  await expect(zh).toContainText("尚未保存");
  await b20Shots(page, "review-put-back-unsaved-zh-Hans", "BOP_B21_SHOTS");
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
// b22 (v15 live check of b21): an open Store keeps its business day start, so step 1 shows it as
// kept, and a saved setup that starts the day at another time is flagged in Review and never
// becomes a change that cannot be sent.
test("b22: an open Store's business day start is kept; a setup that changes it is flagged before a change is created @production", async ({
  page,
}) => {
  const state = await install(page, {
    live: true,
    saved: { businessDayStartLocalTime: "04:30:00" },
  });
  state.failing = [];
  await page.goto("/app");
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await page.getByRole("button", { name: /^4\. Review and publish$/u }).click();
  const fixes = page.getByRole("region", { name: "Needs fixing first", exact: true });
  await expect(fixes).toContainText(
    "Business day start: a change with 04:30 cannot be sent for approval. A Store that already runs keeps 04:00",
  );
  const row = page
    .locator(".store-setup-summary__rows > div")
    .filter({ hasText: "Business day start" });
  await expect(row).toContainText("Now 04:00 → changes to 04:30");
  await expect(row).toContainText("Cannot be sent for approval");
  await expect(
    panel(page).getByRole("button", { name: "Create the change from the saved setup" }),
  ).toHaveCount(0);
  await expect(panel(page)).toContainText(
    "A change cannot be created yet: the business day start in this saved setup cannot be sent for approval.",
  );
  await expectNoInternalText(page);
  await b20Shots(page, "review-business-start-cannot-send-en", "BOP_B22_SHOTS");
  await page.getByRole("button", { name: /^1\. Time zone and business day$/u }).click();
  const start = page.getByLabel("Business day starts at (local time)", { exact: true });
  await expect(start).toHaveValue("04:30");
  await expect(start).toHaveAttribute("readonly", "");
  await expect(page.locator("#setup-business-start-kept")).toContainText(
    "This setup starts the business day at 04:30. A Store that already runs keeps 04:00",
  );
  await b20Shots(page, "step1-business-start-differs-en", "BOP_B22_SHOTS");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.getByRole("button", { name: /^1\. 时区和营业日$/u }).click();
  await expect(page.locator("#setup-business-start-kept")).toContainText(
    "这份设置把营业日开始时间设为 04:30。已经营业的门店要保持 04:00",
  );
  await b20Shots(page, "step1-business-start-differs-zh-Hans", "BOP_B22_SHOTS");
  await page.getByRole("button", { name: "改回 04:00", exact: true }).click();
  await expect(page.getByLabel("营业日开始于（当地时间）", { exact: true })).toHaveValue("04:00");
  await expect(page.locator("#setup-business-start-kept")).toHaveText(
    "营业日开始时间保持门店现在的 04:00，这样过去的营业日和报表才能保持界限。",
  );
  await b20Shots(page, "step1-business-start-kept-zh-Hans", "BOP_B22_SHOTS");
  await page.getByRole("button", { name: /^4\. 核对并发布$/u }).click();
  await expect(page.getByRole("region", { name: "需要先改正", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "放弃未保存的修改", exact: true }).click();
  await expect(page.getByRole("region", { name: "需要先改正", exact: true })).toContainText(
    "营业日开始时间：设为 04:30 的修改无法提交审批。",
  );
  await expect(panel(page).locator("text=用已保存的设置生成修改")).toHaveCount(0);
  await b20Shots(page, "review-business-start-cannot-send-zh-Hans", "BOP_B22_SHOTS");
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
// b22 (v15 live check of b21): Earlier changes keep their rows through going offline and an edit
// not saved yet, say in plain words that loading more waits for the connection, and read again by
// themselves once it is back (before, the list was left with only its heading).
test("b22: earlier changes keep their rows offline and through an edit, and read again on reconnect @production", async ({
  page,
  context,
}) => {
  const state = await install(page);
  state.failing = [];
  state.earlierSteps = 20;
  await enter(page);
  await panel(page).getByRole("button", { name: "Create the change from the saved setup" }).click();
  for (let i = 0; i < 2; i++) {
    await panel(page).getByRole("button", { name: "Check the settings again" }).click();
    await expect(panel(page).getByRole("status")).toHaveText(
      "Settings checked, not yet sent for approval.",
    );
  }
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.getByRole("button", { name: /^4\. 核对并发布$/u }).click();
  const where = page.getByRole("region", { name: "门店配置发布", exact: true });
  await where.getByText("以前的修改", { exact: true }).click();
  const history = where.locator(".store-setup-publish__history section");
  await expect(history.getByRole("listitem")).toHaveCount(20);
  // b22 review: offline with older changes still to load, loading them waits for the connection.
  const historyReads = () => state.reads.filter((read) => read === "history").length;
  await context.setOffline(true);
  await expect(history).toContainText("已离线。网络恢复后，以前的修改会自动重新加载。");
  await expect(history.getByRole("button", { name: "加载更早的修改" })).toBeDisabled();
  await expect(history.getByRole("listitem")).toHaveCount(20);
  const offlineReads = historyReads();
  await context.setOffline(false);
  await expect.poll(historyReads).toBe(offlineReads + 1);
  await expect(history.getByRole("button", { name: "加载更早的修改" })).toBeEnabled();
  await history.getByRole("button", { name: "加载更早的修改" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(23);
  // b22 review: a step run here while the list is open shows on top, the older rows kept.
  const beforeCheck = historyReads();
  await where.getByRole("button", { name: "重新检查设置" }).click();
  await expect.poll(historyReads).toBe(beforeCheck + 1);
  await expect(history.getByRole("listitem")).toHaveCount(24);
  await context.setOffline(true);
  await expect(history).toContainText("已离线。网络恢复后，以前的修改会自动重新加载。");
  await expect(history.getByRole("listitem")).toHaveCount(24);
  await b20Shots(page, "history-offline-rows-kept-zh-Hans", "BOP_B22_SHOTS");
  const reads = historyReads();
  await context.setOffline(false);
  await expect.poll(historyReads).toBe(reads + 1);
  await expect(history).not.toContainText("已离线");
  await expect(history.getByRole("listitem")).toHaveCount(24);
  await expect(history.getByRole("alert")).toHaveCount(0);
  // An edit not saved yet keeps the rows too.
  await page.getByRole("button", { name: /^1\. 时区和营业日$/u }).click();
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("America/Vancouver");
  await page.getByRole("button", { name: /^4\. 核对并发布$/u }).click();
  // Before, an unsaved edit blocked the list from reading at all (it showed only its heading).
  await where.getByText("以前的修改", { exact: true }).click();
  await expect(history.getByRole("listitem")).toHaveCount(20);
  await expect(history.getByRole("button", { name: "加载更早的修改" })).toBeEnabled();
  await history.getByRole("button", { name: "加载更早的修改" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(24);
  await b20Shots(page, "history-rows-kept-unsaved-edit-zh-Hans", "BOP_B22_SHOTS");
  expect(state.errors).toEqual([]);
});
