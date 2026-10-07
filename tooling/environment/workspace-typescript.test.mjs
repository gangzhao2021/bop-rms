import { execFileSync } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = fileURLToPath(new URL("./register-workspace-typescript.mjs", import.meta.url));
function run(source, cwd = root) {
  return execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
  });
}
it("resolves workspace package specifiers to source rather than built dist", () => {
  expect(
    run(
      `console.log(import.meta.resolve("@rms/catalog"));`,
      fileURLToPath(new URL("../../apps/api/", import.meta.url)),
    ).trim(),
  ).toMatch(/\/packages\/rms\/catalog\/src\/index\.ts$/u);
});
it("loads real domain exports and their shared manifest without build artifacts", () => {
  expect(
    run(`
    import { GuestSessionService } from "./packages/bop/identity/src/index.ts";
    if ([GuestSessionService].some(value => typeof value !== "function"))
      throw new Error("MISSING_RUNTIME_EXPORT");
    console.log("LOADED");
  `).trim(),
  ).toBe("LOADED");
});
it("keeps missing JavaScript imports as errors outside workspace source parents", () => {
  expect(
    run(`
    try {
      await import("./packages/bop/identity/src/index.js");
      throw new Error("UNEXPECTED_FALLBACK");
    } catch (error) {
      if(error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      console.log("MISSING");
    }
  `).trim(),
  ).toBe("MISSING");
});
