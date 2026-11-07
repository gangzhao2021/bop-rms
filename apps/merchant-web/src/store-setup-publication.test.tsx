import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { StoreConfigurationPublicationChecklist } from "./StoreConfigurationOrdinaryPanel.js";
import {
  StoreSetupLiveSettings,
  liveStoreSettingsChange,
  openingHoursChanges,
} from "./StoreSetupDraftPage.js";
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
    receiptReference: id(16),
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
      // WP-2423 (v15): the receipt template the Store issues receipts with today.
      receiptReference: { state: "Configured", value: id(16) },
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
    // WP-2423 v15 (`8bd902e3` D1): an installed configuration may name the installer's tax
    // reference; the Store's tax configuration in force (the one quotes use) is carried instead.
    const inForce = { ...live, storeTaxConfigurationReference: id(40) };
    expect(liveStoreSettingsChange(content, inForce).taxConfigurationReference).toEqual({
      state: "Configured",
      value: id(40),
    });
    const carried = {
      ...content,
      taxConfigurationReference: { state: "Configured" as const, value: id(40) },
    };
    const inForceHtml = renderToStaticMarkup(
      <MemoryRouter>
        <StoreSetupLiveSettings
          content={carried}
          live={inForce}
          disabled={false}
          onUse={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(inForceHtml).toContain("Tax settings (see Tax review): same as the live Store");
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
  it("says which days publishing changes and carries the live opening hours", () => {
    const sunday = (end: string, cutoffMinutes: number) =>
      Array.from({ length: 7 }, (_, i) => ({
        isoWeekday: i + 1,
        intervals:
          i === 6
            ? [
                {
                  startLocalTime: "10:00:00",
                  endLocalTime: end,
                  endsNextDay: false,
                  serviceModes: ["Pickup"],
                  orderCutoffSeconds: cutoffMinutes * 60,
                  leadTimeSeconds: 900,
                },
              ]
            : [],
      }));
    const running = {
      ...live,
      current: { ...live.current, weeklySchedule: sunday("20:00:00", 35) },
    } as typeof live;
    // Times differ: only the times are shown.
    expect(
      openingHoursChanges(running.current.weeklySchedule, sunday("15:00:00", 35) as never),
    ).toEqual(["Sunday: 10:00\u201320:00 becomes 10:00\u201315:00"]);
    // Same times, different last orders: the details that differ are shown.
    expect(
      openingHoursChanges(running.current.weeklySchedule, sunday("20:00:00", 20) as never),
    ).toEqual([
      "Sunday: 10:00\u201320:00 (Pickup; last orders 35 min before closing; preparation 15 min) becomes 10:00\u201320:00 (Pickup; last orders 20 min before closing; preparation 15 min)",
    ]);
    expect(
      openingHoursChanges(running.current.weeklySchedule, running.current.weeklySchedule),
    ).toEqual([]);
    const content = {
      ...createUnconfiguredStoreSetupContentV2(),
      weeklySchedule: { state: "Configured" as const, value: sunday("15:00:00", 35) as never },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreSetupLiveSettings
          content={content}
          live={running}
          disabled={false}
          onUse={() => undefined}
        />
      </MemoryRouter>,
    );
    const text = staticText(html);
    expect(text).toContain("Publishing this setup changes the Store\u2019s opening hours:");
    expect(text).toContain("Sunday: 10:00\u201320:00 becomes 10:00\u201315:00");
    expect(text.indexOf("Sunday: 10:00")).toBeLessThan(
      text.indexOf("\nUse the live Store\u2019s settings\n"),
    );
    expect(text).toContain(
      "\u201cUse the live Store\u2019s settings\u201d also replaces the opening hours in this setup with the live Store\u2019s.",
    );
    expect(findInternalText([text])).toEqual([]);
    // DEC-STORE-SETUP-PUBLICATION 13: using the live settings carries its opening hours too.
    expect(liveStoreSettingsChange(content, running).weeklySchedule).toEqual({
      state: "Configured",
      value: running.current.weeklySchedule,
    });
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
