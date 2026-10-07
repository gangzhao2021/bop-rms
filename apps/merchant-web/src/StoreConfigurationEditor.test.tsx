import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  StoreConfigurationFeeBasisView,
  StoreConfigurationEditingBoundary,
} from "./StoreConfigurationEditor.js";
import { parseStoreConfigurationSnapshot } from "./store-configuration-client.js";
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
