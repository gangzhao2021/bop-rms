import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import {
  FULL_SIGN_IN_REQUIRED,
  isFullSignInRequired,
  needsFullSignIn,
  responseNeedsFullSignIn,
} from "./full-sign-in.js";

describe("WP-2423 shared PIN-session refusal", () => {
  it("recognises only the BFF's full sign-in refusal", () => {
    expect(isFullSignInRequired(403, { error: "full_sign_in_required" })).toBe(true);
    expect(isFullSignInRequired(403, { error: "request_denied" })).toBe(false);
    expect(isFullSignInRequired(401, { error: "full_sign_in_required" })).toBe(false);
    expect(isFullSignInRequired(403, null)).toBe(false);
    expect(isFullSignInRequired(403, ["full_sign_in_required"])).toBe(false);
  });
  it("reads a copy of the body, leaving the response readable", async () => {
    const response = new Response(JSON.stringify({ error: "full_sign_in_required" }), {
      status: 403,
    });
    expect(await responseNeedsFullSignIn(response)).toBe(true);
    expect(await response.json()).toEqual({ error: "full_sign_in_required" });
    expect(await responseNeedsFullSignIn(new Response("not json", { status: 403 }))).toBe(false);
    expect(
      await responseNeedsFullSignIn(
        new Response(JSON.stringify({ error: "full_sign_in_required" }), { status: 409 }),
      ),
    ).toBe(false);
  });
  it("matches the shared kind on errors and outcomes", () => {
    expect(needsFullSignIn(FULL_SIGN_IN_REQUIRED)).toBe(true);
    expect(needsFullSignIn({ code: "FullSignInRequired" })).toBe(true);
    expect(needsFullSignIn({ code: "Denied" })).toBe(false);
    expect(needsFullSignIn("Denied")).toBe(false);
    expect(needsFullSignIn(null)).toBe(false);
  });
  it("asks the person to confirm it's them in plain words", () => {
    const html = renderToStaticMarkup(<FullSignInPrompt csrf="csrf" />);
    expect(html).toContain(
      "You signed in with a PIN. Confirm it&#x27;s you with your authenticator app, or sign in with your account, to do this.",
    );
    expect(html).toContain("Verify it&#x27;s you");
    expect(html).toContain("Sign out and sign in with your account");
    expect(html).not.toContain("permission");
    expect(findInternalText([staticText(html)])).toEqual([]);
  });
});
