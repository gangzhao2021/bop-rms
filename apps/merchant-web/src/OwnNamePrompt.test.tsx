import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import {
  createOwnNameClient,
  OWN_NAME_PROMPT,
  OWN_NAME_PURPOSE,
  OWN_NAME_REQUIRED,
  OwnNameError,
  ownNameFailureText,
  ownNameProblem,
  OwnNamePromptView,
  parseOwnNameState,
} from "./OwnNamePrompt.js";

const csrf = "c".repeat(43);
const operation = "01909974-0000-7000-8000-000000000001";

describe("Home asks a staff member without a name to add one", () => {
  it("asks plainly, says why, and shows no internal text", () => {
    const html = renderToStaticMarkup(
      <OwnNamePromptView
        name=""
        busy={false}
        problem={null}
        idPrefix="own-name-test"
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    // Owner 2026-10-18 ("必填（推荐）"): required, with the plain reason, and no way to dismiss it.
    expect(OWN_NAME_PROMPT).toBe(
      "Your store asks every staff member for their name. Orders, refunds and other records show it, so your team can see who did what.",
    );
    expect(OWN_NAME_REQUIRED).toBe("This stays here until you add your name.");
    expect(html).toContain(OWN_NAME_PROMPT);
    expect(html).toContain(OWN_NAME_REQUIRED);
    expect(html).not.toMatch(/dismiss|later|skip|not now/iu);
    expect(html).toContain(OWN_NAME_PURPOSE);
    expect(html).toContain('<label for="own-name-test-name">Your name</label>');
    expect(html).toContain('autoComplete="name"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain(">Save name</button>");
    expect(findInternalText([staticText(html)])).toEqual([]);
  });
  it("links a problem to the field", () => {
    const html = renderToStaticMarkup(
      <OwnNamePromptView
        name=" "
        busy={false}
        problem="Enter your name."
        idPrefix="own-name-test"
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="own-name-test-hint own-name-test-error"');
    expect(html).toContain('role="alert">Enter your name.</p>');
  });
  it("checks the name the way it is stored", () => {
    expect(ownNameProblem("   ")).toBe("Enter your name.");
    expect(ownNameProblem("x".repeat(81))).toBe("Use 80 characters or fewer.");
    expect(ownNameProblem("Mia\u0007")).toBe("Use letters, spaces and punctuation only.");
    expect(ownNameProblem("  Mia Chen ")).toBeNull();
  });
  it("explains each failure in plain words", () => {
    expect(ownNameFailureText(new OwnNameError("Conflict"))).toBe(
      "Your name was already added. Ask a manager if it needs to change.",
    );
    expect(ownNameFailureText(new OwnNameError("Offline"))).toBe(
      "Your name couldn't be saved. Check the connection and try again.",
    );
    expect(ownNameFailureText(new OwnNameError("PermissionDenied"))).toBe(
      "Your sign-in has ended or doesn't allow this. Sign in again, then add your name.",
    );
    expect(ownNameFailureText(new Error("x"))).toBe(
      "Your name couldn't be saved. Check the connection and try again.",
    );
  });
  it("reads only the three known answers", () => {
    expect(parseOwnNameState({ name: "Missing", profileVersion: 0 })).toEqual({
      name: "Missing",
      profileVersion: 0,
    });
    expect(parseOwnNameState({ name: "Recorded", displayName: "Mia" })).toEqual({
      name: "Recorded",
      displayName: "Mia",
    });
    expect(parseOwnNameState({ name: "NotStoreMember" })).toEqual({ name: "NotStoreMember" });
    for (const bad of [
      { name: "Missing", profileVersion: 2 },
      { name: "Missing" },
      { name: "Recorded", displayName: "Mia", actorReference: operation },
      { name: "Other" },
      null,
    ])
      expect(() => parseOwnNameState(bad)).toThrow(OwnNameError);
  });
  it("reads and saves through the same-origin staff routes with the CSRF header", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: "Missing", profileVersion: 0 }))
      .mockResolvedValueOnce(Response.json({ status: "Applied", profileVersion: 1 }))
      .mockResolvedValueOnce(Response.json({ error: "Conflict" }, { status: 409 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    const client = createOwnNameClient(csrf, fetcher);
    expect(await client.read()).toEqual({ name: "Missing", profileVersion: 0 });
    expect(await client.save({ displayName: "Mia Chen", operationReference: operation })).toEqual({
      status: "Applied",
    });
    await expect(
      client.save({ displayName: "Mia Chen", operationReference: operation }),
    ).rejects.toMatchObject({ code: "Conflict" });
    await expect(
      client.save({ displayName: "Mia Chen", operationReference: operation }),
    ).rejects.toMatchObject({ code: "Offline" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/organization/staff/me");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/merchant/organization/staff/me/name");
    const init = fetcher.mock.calls[1]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toMatchObject({ "x-bop-csrf": csrf });
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: "Mia Chen",
      expectedProfileVersion: 0,
      operationReference: operation,
    });
  });
});
