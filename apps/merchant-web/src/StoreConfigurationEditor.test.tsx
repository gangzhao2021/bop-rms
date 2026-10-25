import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { MemoryRouter } from "react-router";
import {
  StoreConfigurationFeeBasisView,
  StoreConfigurationEditingBoundary,
  StoreHoursDraftForm,
  StoreHoursOwnApproval,
  storeConfigurationEditBase,
  storeHoursSetupBasis,
  storeHoursSubmittedMessage,
  storeConfigurationOpenChange,
  storeConfigurationStateLabel,
} from "./StoreConfigurationEditor.js";
import {
  parseStoreConfigurationSnapshot,
  parseStoreConfigurationView,
} from "./store-configuration-client.js";
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(1),
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
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

const basis = {
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(30),
  setupDraftReference: id(31),
  sourceRevision: 7,
  sourceSnapshotDigest: "sha256:" + "a".repeat(64),
  feeContexts: [
    {
      chargeType: "ServiceCharge",
      state: "Enabled",
      taxClassificationReference: id(32),
      orderTypes: ["Pickup"],
    },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ],
};
it("shows real Setup provenance and fee states without Tenant identity or invented qualification", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreConfigurationFeeBasisView
        configuration={parseStoreConfigurationSnapshot(
          { ...configuration("Draft"), setupBasis: basis },
          id(3),
        )}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-label="Recorded fee configuration"');
  expect(html).toContain("Draft, not yet sent for approval");
  expect(html).toContain("do not change the live Store");
  expect(html).toContain(`saved Store setup draft ${basis.sourceRevision}`);
  expect(html).not.toContain(id(31));
  expect(html).not.toContain(basis.sourceSnapshotDigest);
  expect(html).toContain("Service charge");
  expect(html).toContain(": On");
  expect(html).toContain(": Off");
  expect(html).toContain("Pickup");
  expect(html).not.toContain(id(30));
  expect(html).not.toContain(id(32));
  expect(html).toContain("not been checked by a tax");
  expect(findInternalText([staticText(html)])).toEqual([]);
});
it("distinguishes actual Published content from a legacy record lacking fee facts", () => {
  const published = renderToStaticMarkup(
    <MemoryRouter>
      <StoreConfigurationFeeBasisView
        configuration={parseStoreConfigurationSnapshot(
          { ...configuration("Published"), setupBasis: basis },
          id(3),
        )}
      />
    </MemoryRouter>,
  );
  expect(published).toContain('aria-label="Published fee configuration"');
  expect(published).toContain("Published.");
  const legacy = renderToStaticMarkup(
    <MemoryRouter>
      <StoreConfigurationFeeBasisView
        configuration={parseStoreConfigurationSnapshot(configuration("Draft"), id(3))}
      />
    </MemoryRouter>,
  );
  expect(legacy).toContain("made before fees were part of Store setup");
  expect(legacy).not.toContain("Disabled");
});

it("edits hours of a configuration from Store setup while fees stay in Store setup", () => {
  const full = parseStoreConfigurationSnapshot(
    { ...configuration("Draft"), setupBasis: basis },
    id(3),
  );
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreConfigurationFeeBasisView configuration={full} />
      <StoreConfigurationEditingBoundary configuration={full}>
        <input aria-label="Business day starts" value="04:00" readOnly />
        <button type="button">Add interval</button>
      </StoreConfigurationEditingBoundary>
      <button type="button">Validate saved draft</button>
    </MemoryRouter>,
  );
  expect(html).not.toContain('disabled=""');
  expect(html).toContain("These hours are also the hours in Store setup.");
  expect(html).toContain("Change them in");
  expect(html).toContain(`href="/app/organization/stores/${id(3)}/setup"`);
  expect(html).toContain("Edit in Store Setup");
  expect(html).toContain('</fieldset><button type="button">Validate saved draft</button>');
  expect(findInternalText([staticText(html)])).toEqual([]);
  const legacy = renderToStaticMarkup(
    <StoreConfigurationEditingBoundary
      configuration={parseStoreConfigurationSnapshot(configuration("Draft"), id(3))}
    >
      <input aria-label="Business day starts" defaultValue="04:00" />
    </StoreConfigurationEditingBoundary>,
  );
  expect(legacy).not.toContain('disabled=""');
  expect(legacy).toContain('value="04:00"');
});

// WP-2423 Q4: the pilot edits only hours and dated closures, in staff language.
const hoursView = (latest: ReturnType<typeof configuration> | null) => {
  const current = {
    ...configuration("Published"),
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: configuration("Published").weeklySchedule.map((day) => ({
      ...day,
      intervals: day.intervals.map((interval) => ({
        ...interval,
        serviceModes: ["DineIn", "Pickup"],
        orderCutoffSeconds: 900,
      })),
    })),
  };
  return parseStoreConfigurationView(
    {
      screenId: "STORE-HOURS-SERVICE",
      storeReference: id(3),
      current,
      latest:
        latest === null
          ? null
          : {
              ...current,
              ...latest,
              enabledServiceModes: current.enabledServiceModes,
              weeklySchedule: current.weeklySchedule,
              configurationReference: id(20),
              configurationVersion: 2,
              supersedesConfigurationReference: id(1),
            },
      expectedVersion: latest === null ? 1 : 2,
      observedAt: at,
    },
    id(3),
  );
};
const renderForm = (view: ReturnType<typeof hoursView>) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StoreHoursDraftForm
        view={view}
        draft={(view.latest ?? view.current) as NonNullable<typeof view.current>}
        disabled={false}
        onDraftChange={() => undefined}
        onCommand={() => undefined}
      />
    </MemoryRouter>,
  );
it("edits hours without effective dates, business-day start or a typed reason code", () => {
  const html = renderForm(hoursView(null));
  expect(html).not.toContain("Effective from");
  expect(html).not.toContain("Effective until");
  expect(html).not.toContain("Change reason code");
  expect(html).not.toContain('type="datetime-local"');
  expect(html).toContain("The business day starts at 04:00.");
  expect(html).not.toMatch(/<label>Business day starts/u);
  expect(html).toContain("No pending change. Customers see the published hours.");
  expect(html).not.toContain("Published version");
  expect(html).not.toContain("no recorded Setup fee basis");
  // Minutes, not seconds; service modes in staff words; labels wrap their inputs.
  expect(html).toContain("Last orders (minutes before closing)");
  expect(html).toContain('max="1440" step="1" required="" value="15"');
  expect(html).toContain("Preparation time (minutes)");
  expect(html).toContain('value="10"');
  expect(html).not.toContain("seconds");
  expect(html).toContain("Dine-in");
  expect(html).not.toContain(">DineIn<");
  expect(html).toContain("<legend>Monday</legend>");
});
it("describes lifecycle states in staff language", () => {
  const pending = renderForm(hoursView(configuration("PendingApproval")));
  expect(pending).toContain("Latest change: Waiting for approval");
  expect(pending).toContain("Approve reviewed configuration");
  expect(pending).toContain("other than the person who made the change");
  expect(renderForm(hoursView(configuration("Approved")))).toContain(
    "Latest change: Approved, waiting to be published",
  );
  expect(renderForm(hoursView(configuration("Draft")))).toContain(
    "Latest change: Draft, not yet sent for approval",
  );
  expect(storeConfigurationStateLabel("Superseded")).toBe("Replaced by a newer version");
});

it("WP-2423 Q4: offers the hours draft for a configuration from Store setup", () => {
  const view = parseStoreConfigurationView(
    {
      screenId: "STORE-HOURS-SERVICE",
      storeReference: id(3),
      current: { ...configuration("Published"), setupBasis: basis },
      latest: null,
      expectedVersion: 1,
      observedAt: at,
    },
    id(3),
  );
  const html = renderForm(view);
  expect(html).toContain('<button type="submit">Save hours draft</button>');
  expect(html).toContain("Add dated exception");
  expect(html).toContain("Fees in the published settings");
  expect(html).not.toContain('disabled=""><legend>Hours');
  expect(findInternalText([staticText(html)])).toEqual([]);
});

// WP-2423 (v15 D2/D3): whose change is open is shown; another person's is never replaced silently.
it("shows another person's open change, blocks saving over it and offers to decline it", () => {
  const base = hoursView({ ...configuration("PendingApproval"), authoredByReference: id(40) });
  const view = parseStoreConfigurationView(
    { ...base, viewerActorReference: id(10), latestWithdrawal: null },
    id(3),
  );
  expect(storeConfigurationOpenChange(view)).toBe("SomeoneElse");
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreHoursDraftForm
        view={view}
        draft={storeConfigurationEditBase(view) as NonNullable<typeof view.current>}
        disabled={false}
        onDraftChange={() => undefined}
        onCommand={() => undefined}
        onWithdraw={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("Someone else’s change (version 2, waiting for approval) is still open");
  // v15 D9: no decline offered unless the server says you may decline.
  expect(html).not.toContain("Decline this change");
  // v15: sent for approval, so no draft-only wording.
  expect(html).toContain(
    "It has been sent for approval and is waiting for an Owner to approve it.",
  );
  expect(html).not.toContain("can check it or send it");
  expect(html).toMatch(/<button type="submit" disabled="">Save hours draft<\/button>/u);
  expect(findInternalText([staticText(html)])).toEqual([]);
  // Your own open change: editing continues from it, and you may withdraw it.
  const own = parseStoreConfigurationView(
    { ...base, viewerActorReference: id(40), latestWithdrawal: null },
    id(3),
  );
  expect(storeConfigurationOpenChange(own)).toBe("Yours");
  expect(storeConfigurationEditBase(own)?.configurationVersion).toBe(2);
  // Withdrawn: the next change starts from the published hours (nothing carried).
  const withdrawn = parseStoreConfigurationView(
    {
      ...base,
      viewerActorReference: id(10),
      latestWithdrawal: { kind: "Declined", withdrawnAt: at, byYou: true },
    },
    id(3),
  );
  expect(storeConfigurationOpenChange(withdrawn)).toBe("None");
  expect(storeConfigurationEditBase(withdrawn)?.configurationVersion).toBe(1);
  const closed = renderToStaticMarkup(
    <MemoryRouter>
      <StoreHoursDraftForm
        view={withdrawn}
        draft={storeConfigurationEditBase(withdrawn) as NonNullable<typeof view.current>}
        disabled={false}
        onDraftChange={() => undefined}
        onCommand={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(closed).toContain("Latest change: Declined");
  expect(closed).not.toContain("Approve reviewed configuration");
  // A malformed withdrawal is refused.
  expect(() =>
    parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(10),
        latestWithdrawal: { kind: "Deleted", withdrawnAt: at, byYou: true },
      },
      id(3),
    ),
  ).toThrow();
});

it("WP-2423 v15: names who made the open change, and declining it is confirmed with an optional reason", () => {
  const base = hoursView({ ...configuration("Draft"), authoredByReference: id(40) });
  const view = parseStoreConfigurationView(
    {
      ...base,
      viewerActorReference: id(10),
      latestWithdrawal: null,
      latestAuthorName: "Mia Chen",
      soleOperator: null,
    },
    id(3),
  );
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreHoursDraftForm
        view={view}
        draft={storeConfigurationEditBase(view) as NonNullable<typeof view.current>}
        disabled={false}
        onDraftChange={() => undefined}
        onCommand={() => undefined}
        onWithdraw={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("Mia Chen’s change (version 2, draft, not yet sent for approval)");
  expect(html).toContain("Only Mia Chen can check it or send it for approval.");
  // Another person's draft: you cannot check or send it.
  expect(html).toMatch(/<button type="button" disabled="">Validate saved draft<\/button>/u);
  expect(html).toMatch(/<button type="button" disabled="">Submit saved draft<\/button>/u);
  expect(findInternalText([staticText(html)])).toEqual([]);
  // The decliner's reason is shown to the person who made the change.
  const declined = parseStoreConfigurationView(
    {
      ...base,
      viewerActorReference: id(40),
      latestWithdrawal: { kind: "Declined", withdrawnAt: at, byYou: false, reason: "TalkFirst" },
      latestAuthorName: null,
      soleOperator: null,
    },
    id(3),
  );
  const closed = renderToStaticMarkup(
    <MemoryRouter>
      <StoreHoursDraftForm
        view={declined}
        draft={storeConfigurationEditBase(declined) as NonNullable<typeof view.current>}
        disabled={false}
        onDraftChange={() => undefined}
        onCommand={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(closed).toContain("(Talk to me before changing this)");
  expect(() =>
    parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(40),
        latestWithdrawal: { kind: "Withdrawn", withdrawnAt: at, byYou: true, reason: "TalkFirst" },
        latestAuthorName: null,
        soleOperator: null,
      },
      id(3),
    ),
  ).toThrow();
});

it("WP-2423 DEC-SOLE-OPERATOR-APPROVAL: your own hours change is approved alone, or says why not", () => {
  const base = hoursView({ ...configuration("PendingApproval"), authoredByReference: id(10) });
  // The Owner: holds Store configuration approval.
  const view = (soleOperator: unknown) =>
    parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(10),
        latestWithdrawal: null,
        latestAuthorName: null,
        soleOperator,
        viewerMayDecline: false,
        viewerMayApprove: true,
      },
      id(3),
    );
  const render = (soleOperator: unknown) => {
    const v = view(soleOperator);
    const form = renderToStaticMarkup(
      <MemoryRouter>
        <StoreHoursDraftForm
          view={v}
          draft={storeConfigurationEditBase(v) as NonNullable<typeof v.current>}
          disabled={false}
          onDraftChange={() => undefined}
          onCommand={() => undefined}
        />
      </MemoryRouter>,
    );
    return {
      form,
      own: renderToStaticMarkup(
        <StoreHoursOwnApproval
          view={v}
          csrf="synthetic"
          busy={false}
          onApprove={() => undefined}
        />,
      ),
    };
  };
  const off = render({ status: "NotSet", otherApprovers: [], verifiedUntil: null });
  // The person who made it is never offered the ordinary approval of someone else's change.
  expect(off.form).not.toContain("Approve reviewed configuration");
  expect(off.own).toContain("Sole operator is off.");
  expect(off.own).toContain("turn on Sole operator in Store setup");
  const others = render({
    status: "OtherApprovers",
    otherApprovers: [{ displayName: "Sam Lee" }],
    verifiedUntil: null,
  });
  expect(others.own).toContain("Sam Lee also holds Owner access to this Store");
  const effective = render({ status: "Effective", otherApprovers: [], verifiedUntil: null });
  expect(effective.own).toContain("Approve hours on my own");
  expect(effective.own).toContain("I checked these opening hours and approve on my own");
  expect(findInternalText([staticText(effective.own)])).toEqual([]);
  // Without the sole-operator offer (another deployment): your own change needs another person.
  expect(render(null).own).toContain("You cannot approve a change you made.");
});

// WP-2423 v15 (`8bd902e3` D2/D3/D4/D9).
it("v15: the published configuration decides the hours path; a withdrawn setup change does not", () => {
  const withdrawnSetup = parseStoreConfigurationView(
    {
      screenId: "STORE-HOURS-SERVICE",
      storeReference: id(3),
      current: configuration("Published"),
      latest: {
        ...configuration("Draft"),
        configurationReference: id(20),
        configurationVersion: 2,
        supersedesConfigurationReference: id(1),
        setupBasis: basis,
      },
      expectedVersion: 2,
      observedAt: at,
      viewerActorReference: id(10),
      latestWithdrawal: { kind: "Withdrawn", withdrawnAt: at, byYou: true },
    },
    id(3),
  );
  // Installed (V1) published configuration: an ordinary hours change from the published hours.
  expect(storeHoursSetupBasis(withdrawnSetup)).toBeUndefined();
  expect(storeConfigurationEditBase(withdrawnSetup)?.configurationVersion).toBe(1);
  expect(storeConfigurationEditBase(withdrawnSetup)?.setupBasis).toBeUndefined();
  // Published from Store setup: an hours-only setup revision.
  const fromSetup = parseStoreConfigurationView(
    {
      screenId: "STORE-HOURS-SERVICE",
      storeReference: id(3),
      current: { ...configuration("Published"), setupBasis: basis },
      latest: null,
      expectedVersion: 1,
      observedAt: at,
    },
    id(3),
  );
  expect(storeHoursSetupBasis(fromSetup)?.sourceRevision).toBe(7);
});

it("v15: an Owner without a Store name is named by role; only people who may decline see Decline", () => {
  const base = hoursView({ ...configuration("Draft"), authoredByReference: id(40) });
  const render = (viewerMayDecline: boolean) => {
    const view = parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(10),
        latestWithdrawal: null,
        latestAuthorName: "the Owner",
        soleOperator: null,
        viewerMayDecline,
      },
      id(3),
    );
    return renderToStaticMarkup(
      <MemoryRouter>
        <StoreHoursDraftForm
          view={view}
          draft={storeConfigurationEditBase(view) as NonNullable<typeof view.current>}
          disabled={false}
          onDraftChange={() => undefined}
          onCommand={() => undefined}
          onWithdraw={() => undefined}
        />
      </MemoryRouter>,
    );
  };
  const manager = render(false);
  expect(manager).toContain("The Owner’s change (version 2");
  expect(manager).toContain("Only the Owner can check it or send it for approval.");
  expect(manager).not.toContain("Decline this change");
  expect(findInternalText([staticText(manager)])).toEqual([]);
  const owner = render(true);
  expect(owner).toContain("Decline this change");
  expect(() =>
    parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(10),
        latestWithdrawal: null,
        latestAuthorName: null,
        soleOperator: null,
        viewerMayDecline: "yes",
      },
      id(3),
    ),
  ).toThrow();
});

it("v15: after sending, the Owner with sole operator in effect is told they may approve alone", () => {
  const base = hoursView({ ...configuration("PendingApproval"), authoredByReference: id(10) });
  const view = (soleOperator: unknown, viewerMayApprove?: boolean) =>
    parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(10),
        latestWithdrawal: null,
        latestAuthorName: null,
        soleOperator,
        ...(viewerMayApprove === undefined ? {} : { viewerMayDecline: false, viewerMayApprove }),
      },
      id(3),
    );
  const notSet = { status: "NotSet", otherApprovers: [], verifiedUntil: null };
  const effective = storeHoursSubmittedMessage(
    view({ status: "Effective", otherApprovers: [], verifiedUntil: null }),
  );
  expect(effective).toContain("you can approve it yourself");
  expect(effective).not.toContain("independent");
  // An Owner (holds approval) with sole operator off is told where to turn it on.
  expect(storeHoursSubmittedMessage(view(notSet, true))).toBe(
    "Sent for approval. Another person with approval access must approve it. If you run the Store alone, turn on sole operator in Approvals to approve it yourself.",
  );
  expect(
    storeHoursSubmittedMessage(
      view(
        { status: "OtherApprovers", otherApprovers: [{ displayName: "Mia" }], verifiedUntil: null },
        true,
      ),
    ),
  ).toBe(
    "Sent for approval. Another person with approval access must approve it before it is published.",
  );
  // A Store Manager (no approval access) never sees sole operator hints.
  const manager =
    "Sent for approval. An Owner will review and approve it; you\u2019ll see it here once it is published.";
  expect(storeHoursSubmittedMessage(view(notSet, false))).toBe(manager);
  expect(
    storeHoursSubmittedMessage(
      view(
        { status: "OtherApprovers", otherApprovers: [{ displayName: null }], verifiedUntil: null },
        false,
      ),
    ),
  ).toBe(manager);
  // Approval access not known (older server): no sole operator hint either.
  expect(storeHoursSubmittedMessage(view(notSet))).toBe(manager);
  expect(storeHoursSubmittedMessage(view(null))).toBe(manager);
  // The approval panel tells a Manager an Owner reviews it, with no sole operator wording.
  const panel = renderToStaticMarkup(
    <StoreHoursOwnApproval
      view={view(notSet, false)}
      csrf="c"
      busy={false}
      onApprove={() => undefined}
    />,
  );
  expect(panel).toContain("An Owner will review and approve this change");
  expect(panel).not.toMatch(/sole operator/iu);
  expect(
    renderToStaticMarkup(
      <StoreHoursOwnApproval
        view={view(notSet, true)}
        csrf="c"
        busy={false}
        onApprove={() => undefined}
      />,
    ),
  ).toMatch(/Sole operator is off/u);
  // A malformed approval flag is refused.
  expect(() =>
    parseStoreConfigurationView(
      {
        ...base,
        viewerActorReference: id(10),
        latestWithdrawal: null,
        latestAuthorName: null,
        soleOperator: null,
        viewerMayDecline: false,
        viewerMayApprove: "yes",
      },
      id(3),
    ),
  ).toThrow();
});

it("v15: someone else's change is described from its current state", () => {
  const render = (lifecycle: "Draft" | "PendingApproval" | "Approved", mayApprove: boolean) => {
    const view = parseStoreConfigurationView(
      {
        ...hoursView({ ...configuration(lifecycle), authoredByReference: id(40) }),
        viewerActorReference: id(10),
        latestWithdrawal: null,
        latestAuthorName: "Mia",
        soleOperator: null,
        viewerMayDecline: mayApprove,
        viewerMayApprove: mayApprove,
      },
      id(3),
    );
    return staticText(
      renderToStaticMarkup(
        <MemoryRouter>
          <StoreHoursDraftForm
            view={view}
            draft={storeConfigurationEditBase(view) as NonNullable<typeof view.current>}
            disabled={false}
            onDraftChange={() => undefined}
            onCommand={() => undefined}
            onWithdraw={() => undefined}
          />
        </MemoryRouter>,
      ),
    ).replace(/\s+/gu, " ");
  };
  const draftOwner = render("Draft", true);
  expect(draftOwner).toContain(
    "Only Mia can check it or send it for approval. You can approve it once it is sent, or decline it here.",
  );
  expect(render("Draft", false)).toContain(
    "Only Mia can check it or send it for approval. Ask an Owner to approve or decline it.",
  );
  const pendingOwner = render("PendingApproval", true);
  expect(pendingOwner).toContain("It has been sent for approval. You can approve or decline it.");
  expect(pendingOwner).toContain("Approve reviewed configuration");
  expect(pendingOwner).not.toContain("Only Mia can check it");
  const pendingManager = render("PendingApproval", false);
  expect(pendingManager).toContain(
    "It has been sent for approval and is waiting for an Owner to approve it.",
  );
  expect(pendingManager).not.toContain("Approve reviewed configuration");
  const approved = render("Approved", true);
  expect(approved).toContain(
    "A new change cannot be saved until it is published, or declined. It has been approved and can now be published. Customers see the new hours once it is published.",
  );
  expect(approved).not.toContain("Only Mia can check it");
  expect(approved).not.toContain("once it is sent");
  for (const text of [draftOwner, pendingOwner, pendingManager, approved])
    expect(findInternalText([text])).toEqual([]);
});
