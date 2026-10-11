import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  StoreConfigurationFeeBasisView,
  StoreConfigurationEditingBoundary,
  StoreHoursDraftForm,
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
  expect(html).toContain("Configuration state: Draft");
  expect(html).toContain("do not change the live Store");
  expect(html).toContain(id(31));
  expect(html).toContain(basis.sourceSnapshotDigest);
  expect(html).toContain("Setup source revision");
  expect(html).toContain("Service charge");
  expect(html).toContain("Enabled");
  expect(html).toContain("Disabled");
  expect(html).toContain("Pickup");
  expect(html).not.toContain(id(30));
  expect(html).not.toContain(id(32));
  expect(html).toContain("do not supply fee amounts, quotes or professional tax qualification");
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
  expect(published).toContain("Configuration state: Published");
  const legacy = renderToStaticMarkup(
    <MemoryRouter>
      <StoreConfigurationFeeBasisView
        configuration={parseStoreConfigurationSnapshot(configuration("Draft"), id(3))}
      />
    </MemoryRouter>,
  );
  expect(legacy).toContain("no recorded Setup fee basis");
  expect(legacy).toContain("Fee policy is not inferred");
  expect(legacy).not.toContain("Disabled");
});

it("locks basis-bound content editing while keeping the authorized Setup route and legacy editing", () => {
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
  expect(html).toContain('<fieldset disabled="">');
  expect(html).toContain("immutable Setup source");
  expect(html).toContain(`href="/app/organization/stores/${id(3)}/setup"`);
  expect(html).toContain("Edit in Store Setup");
  expect(html).toContain('</fieldset><button type="button">Validate saved draft</button>');
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
