// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { buttonNamed, click, mount, settle, typeInto } from "./dom-test-kit.fixture.js";
import { OwnNamePrompt, type OwnNameClient, type OwnNameState } from "./OwnNamePrompt.js";
import { StaffIdentityLine } from "./StaffIdentityLine.js";
import type { StaffPinClient } from "./staff-pin-client.js";

afterEach(() => document.body.replaceChildren());

it("WP-2423 M61 (v15 live check): the frame line shows the name saved on Home without a reload", async () => {
  let state: OwnNameState = { name: "Missing", profileVersion: 0 };
  const names: OwnNameClient = {
    read: async () => state,
    save: async ({ displayName }) => {
      state = { name: "Recorded", displayName };
      return { status: "Applied" };
    },
  };
  const pin = {
    pinStatus: async () => Promise.reject(new Error("not read here")),
  } as unknown as StaffPinClient;
  const csrf = "n".repeat(43);
  const { container } = await mount(
    <>
      <StaffIdentityLine csrf={csrf} storeReference="store-a" nameClient={names} pinClient={pin} />
      <OwnNamePrompt csrf={csrf} client={names} />
    </>,
  );
  await settle();
  expect(container.querySelector(".staff-identity")?.textContent).toContain("Name not added yet");
  await typeInto(container.querySelector('input[name="displayName"]'), "TEST Owner Two");
  await click(buttonNamed(container, "Save name"));
  await settle(10);
  expect(container.textContent).toContain("Thanks. Your team now sees your name.");
  expect(container.querySelector(".staff-identity")?.textContent).toContain("TEST Owner Two");
  expect(container.querySelector(".staff-identity")?.textContent).not.toContain(
    "Name not added yet",
  );
});
