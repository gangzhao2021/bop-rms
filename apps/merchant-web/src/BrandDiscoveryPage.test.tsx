import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import {
  BrandDiscoveryView,
  BrandInvitationView,
  type BrandInvitationStatus,
} from "./BrandDiscoveryPage.js";
import { parseMerchantBrandDiscoveryPage } from "./merchant-brand-discovery-client.js";
const id = (n: number) => `018f9e90-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const session = {
  authenticated: true as const,
  csrf: "c".repeat(43),
  recentMfaRequired: false,
  actorReference: id(1),
  selectedBrandReference: null,
};
const props = {
  session,
  page: null,
  status: "Ready",
  busy: false,
  stale: false,
  onRefresh: vi.fn(),
  onMore: vi.fn(),
  onChoose: vi.fn(),
  onRenew: vi.fn(),
  onLogout: vi.fn(),
};
const at = "2026-10-06T12:00:00.000Z";
const packet = (items: unknown[], hasMore = false) =>
  parseMerchantBrandDiscoveryPage(
    {
      profile: "MerchantBrandDiscoveryV1",
      actorReference: id(1),
      afterBrandReference: null,
      items,
      hasMore,
      nextAfterBrandReference: hasMore ? id(3) : null,
      observedAt: at,
      validUntil: "2026-10-06T12:00:05.000Z",
    },
    session,
    null,
    Date.parse(at),
  );
describe("ordinary Brand discovery presentation", () => {
  it("shows only genuine identity and locale summaries, explicit missing metadata and no fake actions", () => {
    const html = renderToStaticMarkup(
      <BrandDiscoveryView
        {...props}
        page={packet([
          {
            brandReference: id(2),
            code: "BRAND",
            displayName: "Synthetic Brand",
            lifecycle: "Draft",
            defaultLocale: "en-CA",
            version: 1,
          },
        ])}
      />,
    );
    expect(html).toContain("Choose Synthetic Brand");
    expect(html).toContain("Draft");
    expect(html).toContain("Default locale en-CA");
    expect(html).toContain("summaries are not available");
    expect(html).not.toContain(id(1));
    expect(html).not.toContain(id(2));
    expect(html).not.toContain("Activate Brand");
    expect(html).not.toContain("Create Brand");
  });
  it("retains a continuing action on an actually empty scanned page", () => {
    const html = renderToStaticMarkup(<BrandDiscoveryView {...props} page={packet([], true)} />);
    expect(html).toContain("No Brands on this page");
    expect(html).toContain("More Brands");
  });
  it("expired list disables choice and requires actual refresh", () => {
    const html = renderToStaticMarkup(
      <BrandDiscoveryView
        {...props}
        stale
        page={packet([
          {
            brandReference: id(2),
            code: "BRAND",
            displayName: "Synthetic Brand",
            lifecycle: "Active",
            defaultLocale: "en-CA",
            version: 1,
          },
        ])}
      />,
    );
    expect(html).toContain("Brand list expired");
    expect(html).toContain('disabled=""');
  });
  it("requires login/MFA and explains unknown selection recovery and immutable selection conflict", () => {
    for (const [status, copy] of [
      ["AccessRequired", "Sign in securely"],
      ["MfaRequired", "Recent verification"],
      ["OutcomeUnknown", "recover the actual session selection"],
      ["SelectionConflict", "Renew your session"],
    ] as const)
      expect(
        renderToStaticMarkup(<BrandDiscoveryView {...props} status={status ?? ""} />),
      ).toContain(copy);
  });
});

// Static accessible-state proof only. Real unmount/navigation/keyboard behavior
// requires the coordinator's ordinary browser workflow, not this renderer.
describe("invitation acceptance in the existing anonymous Brand entry", () => {
  const invitationProps = {
    secret: "",
    status: "Ready" as BrandInvitationStatus,
    busy: false,
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };
  it("embeds a labelled private-code form only in AccessRequired and keeps ordinary login", () => {
    const invitation = <BrandInvitationView {...invitationProps} />;
    const html = renderToStaticMarkup(
      <BrandDiscoveryView
        {...props}
        session={null}
        status="AccessRequired"
        invitation={invitation}
      />,
    );
    expect(html).toContain('href="/merchant/organization/brands/login"');
    expect(html).toContain("Sign in securely");
    expect(html).toContain('aria-label="Accept a Brand invitation"');
    expect(html).toContain('for="brand-invitation-code"');
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).toContain('autocomplete="off"');
    expect(html).toContain('method="post"');
    expect(html).toContain('aria-describedby="brand-invitation-help brand-invitation-status"');
    expect(html).not.toContain('name="secret"');
    expect(html).not.toContain("?secret=");
    expect(html).not.toContain("Create Brand");
    for (const status of ["Ready", "Loading", "MfaRequired", "Offline", "Unavailable"])
      expect(
        renderToStaticMarkup(
          <BrandDiscoveryView {...props} status={status} invitation={invitation} />,
        ),
      ).not.toContain('aria-label="Accept a Brand invitation"');
  });

  it("shows explicit validation, offline, unavailable and unknown recovery without retaining a submitted code", () => {
    const states: [BrandInvitationStatus, string][] = [
      ["Invalid", "complete 43-character invitation code"],
      ["Offline", "Reconnect, then enter your invitation code again"],
      ["Unavailable", "Re-enter your code to try again"],
      ["OutcomeUnknown", "No retry was sent"],
    ];
    for (const [status, copy] of states) {
      const html = renderToStaticMarkup(
        <BrandInvitationView {...invitationProps} status={status} />,
      );
      expect(html).toContain(copy);
      expect(html).toContain('value=""');
      expect(html).not.toContain('href="');
      if (status === "Invalid") expect(html).toContain('aria-invalid="true"');
      if (status === "OutcomeUnknown") {
        expect(html).toContain("Start again");
        expect(html).toContain('disabled=""');
      }
    }
  });

  it("announces loading and redirect while disabling submission and retaining an explicit cancel action", () => {
    for (const [status, copy] of [
      ["Loading", "Starting invitation sign-in"],
      ["Redirecting", "Continuing to secure sign-in"],
    ] as const) {
      const html = renderToStaticMarkup(
        <BrandInvitationView {...invitationProps} status={status} busy />,
      );
      expect(html).toContain(copy);
      expect(html).toContain('role="status"');
      expect(html).toContain('<button type="submit" disabled="">Accept invitation</button>');
      expect(html).toContain('<button type="button">Cancel invitation sign-in</button>');
    }
  });
});
