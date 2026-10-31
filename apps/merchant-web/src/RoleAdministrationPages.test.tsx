import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { RoleAdministrationScreen } from "./RoleAdministrationPages.js";
import { roleEditorFixture, roleListFixture } from "./role-administration-pages.fixtures.js";
import {
  parseRoleAdministrationPageView,
  rolePermissionLabel,
  roleScopeLabels,
  roleStatusLabels,
  roleTypeLabels,
  unavailableRoleAdministrationPageClient,
} from "./role-administration-pages.js";

it("WP-2423: shows role statuses, scopes and types in plain words, never stored codes", () => {
  expect(Object.values(roleStatusLabels)).toEqual([
    "Draft",
    "Waiting for approval",
    "Approved, not yet active",
    "Active",
    "Rejected",
    "Deactivated",
  ]);
  for (const label of [
    ...Object.values(roleStatusLabels),
    ...Object.values(roleScopeLabels),
    ...Object.values(roleTypeLabels),
  ])
    expect(label).not.toMatch(/[a-z][A-Z]/u);
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
  const list = render(roleListFixture, "IAM-ROLE-LIST");
  expect(list).toContain("<strong>Waiting for approval</strong> · All stores in the brand");
  expect(list).toContain("Custom role · version 3");
  // The status filter offers the same words; its values stay the stored codes.
  expect(list).toContain('<option value="InReview">Waiting for approval</option>');
  expect(list).not.toMatch(/>InReview</u);
  const editor = render(roleEditorFixture, "IAM-ROLE-EDITOR");
  expect(editor).toContain("Waiting for approval");
  expect(editor).not.toMatch(/>\s*InReview|identity\.role\.(view|activate)</u);
});

it("WP-2423: names a permission by its catalog description, else its group", () => {
  const catalog = [
    {
      action: "identity.role.view",
      group: "Role administration",
      description: "View roles",
      highRisk: false,
    },
  ];
  expect(rolePermissionLabel("identity.role.view", catalog, "Role administration")).toBe(
    "View roles",
  );
  expect(rolePermissionLabel("identity.role.activate", catalog, "Role administration")).toBe(
    "Role administration",
  );
});
