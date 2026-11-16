// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StoreConfigurationHistoryView,
  StoreConfigurationOrdinaryPanel,
} from "./StoreConfigurationOrdinaryPanel.js";
import { parseStoreConfigurationOrdinaryHistory } from "./store-configuration-ordinary-client.js";
import {
  createUnconfiguredStoreSetupContentV2,
  StoreSetupClientError,
} from "./store-setup-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";
import { MemoryRouter } from "react-router";

/**
 * b20 (v15 live check of b19): Store setup's step 4 after creating, sending and withdrawing a
 * change, with edits not saved yet, and in Chinese.
 */
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-11-15T17:32:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const csrf = "a".repeat(43);
const basis = {
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(1),
  setupDraftReference: id(30),
  sourceRevision: 1,
  sourceSnapshotDigest: "sha256:" + "a".repeat(64),
  feeContexts: [],
};
const configuration = (lifecycle: string, extra: Record<string, unknown> = {}) => ({
  configurationReference: id(20),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  enabledServiceModes: ["DineIn"],
  weeklySchedule: [],
  authoredByReference: id(4),
  createdAt: at,
  updatedAt: at,
  setupBasis: basis,
  ...extra,
});
const saved = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  setupDraftReference: id(30),
  revision: 1,
  baseConfigurationReference: id(20),
  content: createUnconfiguredStoreSetupContentV2(),
};
const head = { configurationReference: id(20), configurationVersion: 1, contentDigest: null };
const workspaceOf = (extra: Record<string, unknown>) => ({
  profile: "StoreConfigurationOrdinaryWorkspaceV1",
  scope,
  latest: null,
  current: null,
  expectedHead: head,
  original: null,
  observedAt: at,
  validUntil: at,
  businessReferenceValidation: "NotEvaluated",
  ...extra,
});
const journal = () => ({
  load: vi.fn(async () => null),
  reserve: vi.fn(async () => undefined),
  complete: vi.fn(async () => undefined),
});
const clientOf = (workspace: unknown) => ({
  invalidate: vi.fn(),
  load: vi.fn(async () => workspace),
  prepare: vi.fn(async (command: Record<string, unknown>) => ({
    command,
    cursor: { action: command.action, operationReference: command.operationReference },
  })),
  execute: vi.fn(async () => ({ outcome: "Committed" })),
  refreshOriginal: vi.fn(async () => workspace),
  resolve: vi.fn(),
  history: vi.fn(),
});
const panel = async (workspace: unknown, extra: Record<string, unknown> = {}) => {
  const client = clientOf(workspace);
  const mounted = await mount(
    <MemoryRouter>
      <StoreConfigurationOrdinaryPanel
        scope={scope}
        csrf={csrf}
        saved={saved as never}
        setupLayout="Open"
        client={client as never}
        journalFactory={journal as never}
        {...extra}
      />
    </MemoryRouter>,
  );
  await settle();
  return { ...mounted, client };
};
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
});

it("b20: with edits not saved yet, step 4 never says everything saved is published", async () => {
  const published = configuration("Published");
  const ws = workspaceOf({ latest: published, current: published });
  const plain = await panel(ws);
  expect(plain.container.textContent).toContain("Everything saved in this setup is published.");
  document.body.replaceChildren();
  const { container } = await panel(ws, { unsavedEdits: true, freshDisabled: true });
  const text = container.textContent ?? "";
  expect(text).not.toContain("Everything saved in this setup is published.");
  expect(text).toContain("Some changes on this page are not saved yet");
  expect(text).toContain("Save as draft first");
  // b20 review: one sentence asks to save; the outdated-setup sentence waits until it is saved.
  document.body.replaceChildren();
  const outdated = { latest: published, current: published };
  const stale = await panel(workspaceOf(outdated), {
    saved: { ...saved, baseConfigurationReference: id(19), revision: 2 },
    unsavedEdits: true,
  });
  expect(stale.container.textContent).not.toContain("Save as draft again");
  expect(stale.container.textContent).toContain("Some changes on this page are not saved yet");
});

it("b20: a step that changes where the change stands tells the page, so its notice clears", async () => {
  const onChanged = vi.fn();
  const { container, client } = await panel(workspaceOf({ latest: configuration("Draft") }), {
    onChanged,
  });
  expect(onChanged).not.toHaveBeenCalled();
  await click(buttonNamed(container, "Check the settings again"));
  await settle();
  expect(client.execute).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("b20: Chinese status sentences put no space inside the brackets or before the date", async () => {
  setLanguageForTest("zh-Hans");
  const withdrawn = await panel(
    workspaceOf({
      latest: configuration("Draft"),
      latestWithdrawal: { kind: "Withdrawn", withdrawnAt: at, byYou: true },
    }),
  );
  const status = withdrawn.container.querySelector(".store-setup-publish__status")?.textContent;
  expect(status).toMatch(/^你撤回了上一次修改（\S.*），不会发布。$/u);
  document.body.replaceChildren();
  const open = await panel(workspaceOf({ latest: configuration("Draft") }));
  const text = open.container.textContent ?? "";
  expect(text).toMatch(/请在\d+月\d+日 \d{2}:\d{2}( UTC)?前批准并发布/u);
  document.body.replaceChildren();
  const published = configuration("Published");
  const live = await panel(workspaceOf({ latest: published, current: published }));
  expect(live.container.querySelector(".store-setup-publish__status")?.textContent).toMatch(
    /^已发布于\d/u,
  );
});

it("b20: the sole-operator text says 修改, the word the rest of the step uses", async () => {
  setLanguageForTest("zh-Hans");
  const { container } = await panel(
    workspaceOf({
      latest: configuration("PendingApproval"),
      soleOperator: { status: "Effective", otherApprovers: [], verifiedUntil: null },
    }),
  );
  const text = container.textContent ?? "";
  expect(text).toContain("这次修改是你做的");
  expect(text).toContain("我已核对这次修改，并自行批准");
  expect(buttonNamed(container, "自行批准这次修改")).toBeDefined();
  expect(text).not.toMatch(/此更改|此门店配置|自行批准配置/u);
});

const historyEntry = (n: number, command: string, lifecycle: string, extra = {}) => ({
  sequenceNumber: n,
  operationReference: id(200 + n),
  command,
  configuration: {
    ...Object.fromEntries(
      Object.entries(configuration(lifecycle)).filter(([key]) => key !== "setupBasis"),
    ),
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "SETUP_MATERIALIZATION",
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
    dataClassification: "ConfigurationMetadata",
  },
  intentDigest: "sha256:" + "b".repeat(64),
  actorReference: id(4),
  purposeCode: "STORE_CONFIGURATION",
  auditReference: id(300 + n),
  occurredAt: at,
  expectedVersion: command === "SaveDraft" ? 0 : 1,
  ...extra,
});
it("b20: Earlier changes lists each withdrawal and decline after the step it ended", () => {
  const entry = historyEntry;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const page = parseStoreConfigurationOrdinaryHistory(
    {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      readerActorReference: scope.actorReference,
      beforeSequence: null,
      entries: [
        entry(2, "Submit", "PendingApproval", {
          withdrawal: { kind: "Withdrawn", withdrawnAt: at, byYou: true },
        }),
        entry(1, "SaveDraft", "Draft"),
      ],
      nextBeforeSequence: null,
      observedAt: at,
      validUntil: "2026-11-15T17:32:05.000Z",
    },
    scope,
    null,
  );
  expect(page.entries[0]?.withdrawal).toEqual({ kind: "Withdrawn", withdrawnAt: at, byYou: true });
  const rows = (html: string) =>
    [...html.matchAll(/<li>(.*?)<\/li>/gu)].map((m) => (m[1] ?? "").replace(/<[^>]+>/gu, ""));
  const listed = rows(
    renderToStaticMarkup(<StoreConfigurationHistoryView entries={page.entries} />),
  );
  expect(listed).toHaveLength(3);
  expect(listed[0]).toMatch(/^Withdrawn by you /u);
  expect(listed[1]).toMatch(/^Sent for approval /u);
  expect(listed[2]).toMatch(/^Created from saved setup /u);
  const declined = {
    ...page.entries[0],
    withdrawal: { kind: "Declined", withdrawnAt: at, byYou: false },
  };
  expect(
    rows(renderToStaticMarkup(<StoreConfigurationHistoryView entries={[declined as never]} />))[0],
  ).toMatch(/^Declined /u);
});

// b21 (v15 DEMO Store, about 26 pages back): a failed "load older" keeps the rows already shown
// and says so in plain words right under the button, not at the top of the list.
it("b21: a failed load of older changes keeps the rows and says so beside the button", async () => {
  setLanguageForTest("zh-Hans");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const first = parseStoreConfigurationOrdinaryHistory(
    {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      readerActorReference: scope.actorReference,
      beforeSequence: null,
      entries: [historyEntry(3, "Submit", "PendingApproval"), historyEntry(2, "Validate", "Draft")],
      nextBeforeSequence: 2,
      observedAt: at,
      validUntil: "2026-11-15T17:32:05.000Z",
    },
    scope,
    null,
  );
  const { container, client } = await panel(workspaceOf({ latest: configuration("Draft") }));
  // Opening the list may read the first page more than once (jsdom fires its own toggle too);
  // every first-page read answers, every older-page read meets an outage.
  client.history.mockImplementation(async (_scope, options: { beforeSequence: number | null }) => {
    if (options.beforeSequence === null) return first;
    throw new StoreSetupClientError("Unavailable");
  });
  const details = container.querySelector("details.store-setup-publish__history");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("history absent");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await settle();
  expect(details.querySelectorAll("li")).toHaveLength(2);
  await click(buttonNamed(container, "加载更早的修改"));
  await settle();
  expect(details.querySelectorAll("li")).toHaveLength(2);
  const alerts = [...details.querySelectorAll('[role="alert"]')];
  expect(alerts.map((node) => node.textContent)).toEqual([
    "暂时无法加载以前的修改。请检查网络后再试。",
  ]);
  // Right after the button, so it stays in view where the person pressed.
  expect(alerts[0]?.previousElementSibling?.textContent).toBe("加载更早的修改");
  expect(details.textContent).not.toMatch(/配置|仍在等待的请求会保留|更改/u);
});

// b21 review: only an outage asks to check the connection. A refused or unreadable answer (a row
// the reader refuses, Invalid, Conflict) says that part cannot be shown and that work goes on.
it.each([
  ["Unavailable", "暂时无法加载以前的修改。请检查网络后再试。"],
  ["Invalid", "这部分以前的修改无法显示。其他操作不受影响，可以照常继续。"],
  ["Conflict", "这部分以前的修改无法显示。其他操作不受影响，可以照常继续。"],
] as const)("b21 review: a history read failing with %s says what it is", async (code, text) => {
  setLanguageForTest("zh-Hans");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const { container, client } = await panel(workspaceOf({ latest: configuration("Draft") }));
  client.history.mockRejectedValue(new StoreSetupClientError(code));
  const details = container.querySelector("details.store-setup-publish__history");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("history absent");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await settle();
  const alerts = [...details.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
  expect(alerts).toEqual([text]);
  if (code !== "Unavailable") expect(alerts.join("")).not.toMatch(/网络|再试/u);
});
