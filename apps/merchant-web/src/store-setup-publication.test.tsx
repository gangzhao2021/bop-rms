import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { StoreConfigurationPublicationChecklist } from "./StoreConfigurationOrdinaryPanel.js";
import { StoreSetupLiveSettings, liveStoreSettingsChange } from "./StoreSetupDraftPage.js";
import {
  parseStoreConfigurationOrdinaryWorkspace,
  storeConfigurationPublicationCheckCodes,
} from "./store-configuration-pending-journal.js";
import { createUnconfiguredStoreSetupContentV2 } from "./store-setup-client.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";

const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`;
const checks = (failing: readonly string[]) => ({
  profile: "StoreConfigurationPublicationChecksV1" as const,
  configurationReference: id(10),
  checkedAt: "2026-10-15T14:00:00.000Z",
  checks: storeConfigurationPublicationCheckCodes.map((code) => ({
    code,
    outcome: failing.includes(code) ? ("Fail" as const) : ("Pass" as const),
  })),
});
const live = {
  observedAt: "2026-10-15T14:00:00.000Z",
  current: {
    taxConfigurationReference: id(15),
    brandBaseVersionReference: id(11),
    exceptions: [{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
    effectiveFrom: "2026-10-01T04:00:00.000Z",
    source: "StoreOverride",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    enabledServiceModes: ["DineIn", "Pickup"],
    capacityConfigurationReference: null,
  } as unknown as StoreConfigurationSnapshot,
};

describe("WP-2423 DEC-STORE-SETUP-PUBLICATION Store setup publication screens", () => {
  it("lists every check in plain words and counts what blocks publication", () => {
    const html = renderToStaticMarkup(
      <StoreConfigurationPublicationChecklist checks={checks(["Tax", "GoLive"])} />,
    );
    expect(html).toContain("2 checks need attention");
    expect(html).toContain("Needs attention: Tax settings are not the ones in force");
    expect(html).toContain("Needs attention: This Store&#x27;s go-live check is not approved");
    expect(html).toContain("Ready: Opening hours are complete.");
    expect(findInternalText([staticText(html)], [/\bUTC\b/u])).toEqual([]);
    expect(
      renderToStaticMarkup(<StoreConfigurationPublicationChecklist checks={checks([])} />),
    ).toContain("Every check passed.");
  });
  it("offers the live Store's tax, Brand settings, holidays and start, and changes only those", () => {
    const content = createUnconfiguredStoreSetupContentV2();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreSetupLiveSettings
          content={content}
          live={live}
          disabled={false}
          onUse={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Settings from the live Store");
    expect(html).toContain("Tax settings (see Tax review): not the live Store&#x27;s settings yet");
    expect(html).toContain("Use the live Store&rsquo;s settings".replace("&rsquo;", "’"));
    expect(findInternalText([staticText(html)])).toEqual([]);
    const change = liveStoreSettingsChange(content, live);
    expect(change).toEqual({
      // WP-2423 v15: the live Store's operating settings fill what the setup has none of.
      source: { state: "Configured", value: "StoreOverride" },
      timeZone: { state: "Configured", value: "America/Toronto" },
      businessDayStartLocalTime: { state: "Configured", value: "04:00:00" },
      enabledServiceModes: { state: "Configured", value: ["DineIn", "Pickup"] },
      weeklySchedule: { state: "Configured", value: live.current.weeklySchedule },
      capacityConfigurationReference: { state: "Configured", value: null },
      taxConfigurationReference: { state: "Configured", value: id(15) },
      brandBaseVersionReference: { state: "Configured", value: id(11) },
      exceptions: { state: "Configured", value: live.current.exceptions },
      effectiveFrom: { state: "Configured", value: live.observedAt },
      effectiveUntil: { state: "Configured", value: null },
    });
    // Holidays and operating settings already in the setup are kept.
    const kept = {
      ...content,
      exceptions: { state: "Configured" as const, value: [] },
      timeZone: { state: "Configured" as const, value: "America/Vancouver" },
    };
    expect(liveStoreSettingsChange(kept, live).exceptions).toBe(kept.exceptions);
    expect(liveStoreSettingsChange(kept, live)).not.toHaveProperty("timeZone");
    expect(
      renderToStaticMarkup(
        <StoreSetupLiveSettings
          content={content}
          live={{ ...live, current: null }}
          disabled={false}
          onUse={() => undefined}
        />,
      ),
    ).toBe("");
  });
  it("refuses checks that do not belong to the latest configuration", async () => {
    await expect(
      parseStoreConfigurationOrdinaryWorkspace(
        {
          profile: "StoreConfigurationOrdinaryWorkspaceV1",
          scope: {
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            actorReference: id(4),
          },
          latest: null,
          current: null,
          expectedHead: {
            configurationReference: null,
            configurationVersion: 0,
            contentDigest: null,
          },
          original: null,
          observedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 4000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
          publicationChecks: checks([]),
        },
        {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          actorReference: id(4),
        },
      ),
    ).rejects.toThrow();
  });
});
