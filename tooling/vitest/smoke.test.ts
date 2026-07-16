import { describe, expect, it } from "vitest";

describe("Vitest foundation", () => {
  it("discovers and executes TypeScript tests", () => {
    const verification = { runner: "vitest", ready: true } as const;

    expect(verification).toEqual({ runner: "vitest", ready: true });
  });
});
