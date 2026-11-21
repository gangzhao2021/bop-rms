import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { RoleAdministrationScreen } from "./RoleAdministrationPages.js";
import { roleEditorFixture, roleListFixture } from "./role-administration-pages.fixtures.js";
import {
  parseRoleAdministrationPageView,
  roleKindLabels,
  unavailableRoleAdministrationPageClient,
} from "./role-administration-pages.js";

const render = (fixture: unknown, screenId: "IAM-ROLE-LIST" | "IAM-ROLE-EDITOR") =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RoleAdministrationScreen
        view={parseRoleAdministrationPageView(fixture, screenId)}
        client={unavailableRoleAdministrationPageClient}
        csrf="synthetic-csrf"
        reload={() => undefined}
      />
    </MemoryRouter>,
  );
const withRole = (patch: Record<string, unknown>, change: Record<string, unknown> | null = {}) => {
  const fixture = structuredClone(roleEditorFixture) as unknown as {
    roles: Record<string, unknown>[];
  };
  fixture.roles = fixture.roles.map((role) => ({
    ...role,
    ...patch,
    change: change === null ? null : { ...(role.change as object), ...change },
  }));
  return fixture;
};
/** Never a permission code, an identifier, or a version number on a staff screen. */
const noInternals = (html: string) => {
  const text = html.replace(/<[^>]+>/gu, " ");
  expect(text).not.toMatch(/\b[a-z]+(\.[a-z_]+){1,}\b/u);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  expect(text).not.toMatch(/version \d/u);
};

it("WP-2423 role presets: lists roles in use and removed roles in plain words", () => {
  expect(Object.values(roleKindLabels)).toEqual([
    "BOP preset",
    "Your version of a BOP preset",
    "Your role",
  ]);
  const list = render(roleListFixture, "IAM-ROLE-LIST");
  expect(list).toContain("Roles in use");
  expect(list).toContain("Removed roles");
  expect(list).toContain("3 staff");
  expect(list).toContain("Change waiting for approval");
  expect(list).toContain("New role");
  noInternals(list);
});

it("WP-2423 role presets: an approver reads what the change adds, flagged powers first", () => {
  const editor = render(roleEditorFixture, "IAM-ROLE-EDITOR");
  expect(editor).toContain(
    "Adds: Approve a refund above the requester&#x27;s limit, Comp or discount dishes before the table pays",
  );
  expect(editor).toContain("This role can: Approve a refund above the requester");
  expect(editor).toContain("Applies to the 3 staff who hold Front of House once approved");
  expect(editor).toContain(">Approve</button>");
  noInternals(editor);
  // An approver who lacks a flagged power is told, and cannot approve it.
  const lacking = render(
    withRole(
      {},
      { approval: { mine: false, soleOperator: null, needsHolderOf: ["payment.refund.approve"] } },
    ),
    "IAM-ROLE-EDITOR",
  );
  expect(lacking).toContain("which you don&#x27;t hold yourself");
  expect(lacking).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/u);
});

it("WP-2423 role presets: the submitter of a one-owner store is offered to approve alone; with Mia, Mia must", () => {
  const alone = render(
    withRole(
      { operations: ["ApproveAlone", "Withdraw"] },
      {
        approval: {
          mine: true,
          soleOperator: { status: "Effective", otherApprovers: [], verifiedUntil: null },
          needsHolderOf: [],
        },
      },
    ),
    "IAM-ROLE-EDITOR",
  );
  expect(alone).toContain("Approve on my own and turn on");
  expect(alone).toContain("Withdraw change");
  const withMia = render(
    withRole(
      { operations: ["ApproveAlone", "Withdraw"] },
      {
        approval: {
          mine: true,
          soleOperator: {
            status: "OtherApprovers",
            otherApprovers: [{ displayName: "Mia" }],
            verifiedUntil: null,
          },
          needsHolderOf: [],
        },
      },
    ),
    "IAM-ROLE-EDITOR",
  );
  expect(withMia).toContain("Mia");
  expect(withMia).not.toContain("Approve on my own and turn on");
});

it("WP-2423 role presets: a Store's version offers Restore default; the Owner role is locked", () => {
  const mine = render(
    withRole({ kind: "YourVersion", operations: ["Revise", "RestoreDefault", "Duplicate"] }, null),
    "IAM-ROLE-EDITOR",
  );
  expect(mine).toContain("Your version of a BOP preset");
  expect(mine).toContain("Restore default");
  expect(mine).toContain("Edit this preset");
  const held = render(withRole({ operations: [] }, null), "IAM-ROLE-EDITOR");
  expect(held).toContain("3 staff hold this role. Give them another role first.");
  const owner = render(
    withRole({ locked: true, operations: ["Duplicate"] }, null),
    "IAM-ROLE-EDITOR",
  );
  expect(owner).toContain("cannot be edited or removed");
  expect(owner).not.toContain("Remove role");
});

it("WP-2423 role presets: a Store's version is offered what BOP changed in the preset, in Chinese too, and told what BOP retired", () => {
  const offered = {
    kind: "YourVersion",
    operations: ["Revise", "RestoreDefault", "Duplicate"],
    presetUpdate: { added: ["ordering.order.comp"], removed: ["payment.refund.approve"] },
    retiredByBop: 1,
  };
  const editor = render(withRole(offered, null), "IAM-ROLE-EDITOR");
  expect(editor).toContain("BOP updated the preset this role is based on");
  expect(editor).toContain(
    "The BOP preset now also includes: Comp or discount dishes before the table pays. Add it to your version?",
  );
  expect(editor).toContain(">Add to my version</button>");
  expect(editor).toContain(">Keep mine without it</button>");
  expect(editor).toContain("No longer in the BOP preset: Approve a refund above the requester");
  expect(editor).toContain(">Remove from my version</button>");
  expect(editor).toContain(">Keep mine with it</button>");
  expect(editor).toContain("Permissions BOP no longer offers were taken off your version (1)");
  noInternals(editor);
  // The Roles list offers it on the role's row too.
  const list = structuredClone(roleListFixture) as unknown as { roles: Record<string, unknown>[] };
  list.roles = list.roles.map((role, index) =>
    index === 0 ? { ...role, ...offered, change: null } : role,
  );
  const rows = render(list, "IAM-ROLE-LIST");
  expect(rows).toContain(">Add to my version</button>");
  noInternals(rows);
  // Someone who may not change roles is offered nothing.
  expect(
    render(withRole({ ...offered, operations: ["Duplicate"] }, null), "IAM-ROLE-EDITOR"),
  ).not.toContain("Add to my version");
  // A draft BOP sent back says what it left out.
  expect(render(withRole({}, { rebased: true, droppedByBop: 2 }), "IAM-ROLE-EDITOR")).toContain(
    "Permissions BOP no longer offers were left out of this draft (2)",
  );
  setLanguageForTest("zh-Hans");
  try {
    const zh = render(withRole(offered, null), "IAM-ROLE-EDITOR");
    expect(zh).toContain("BOP 更新了这个角色所基于的预设");
    expect(zh).toContain("加到本店版本");
    expect(zh).toContain("保持本店版本，不加");
  } finally {
    setLanguageForTest("en");
  }
});
