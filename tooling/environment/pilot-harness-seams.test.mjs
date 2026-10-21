import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * DEC-PILOT-RUNTIME-ENVIRONMENT: the routes a Pilot-mode test harness uses to reach the local
 * Stripe and Cognito stand-ins (`harness`) and its test certificate root (`checkCapabilities`)
 * are function arguments only. No configuration file, environment variable or request can set
 * them, and no runtime module passes them — so a real Pilot process cannot use a stand-in.
 */
const directory = fileURLToPath(new URL(".", import.meta.url));
const runtimeModules = async () =>
  (await readdir(directory)).filter(
    (name) =>
      name.endsWith(".mjs") &&
      !name.endsWith(".test.mjs") &&
      // TEST-ONLY stand-ins and test helpers themselves.
      ![
        "pilot-stripe-fake.mjs",
        "cognito-test-provider.mjs",
        "pilot-test-certificates.mjs",
      ].includes(name),
  );

test("no runtime module passes a harness route or a capability-check override", async () => {
  const offenders = [];
  for (const name of await runtimeModules()) {
    const text = await readFile(join(directory, name), "utf8");
    if (/\bharness\s*:/u.test(text)) offenders.push(name + " harness:");
    if (/\bcheckCapabilities\s*:/u.test(text)) offenders.push(name + " checkCapabilities:");
    if (/process\.env\.[A-Z_]*HARNESS/u.test(text)) offenders.push(name + " env");
  }
  expect(offenders).toEqual([]);
});

test("the harness routes are declared only where the stand-ins are reached", async () => {
  const declaring = [];
  for (const name of await runtimeModules()) {
    const text = await readFile(join(directory, name), "utf8");
    if (/\bharness\?\./u.test(text)) declaring.push(name);
  }
  expect(declaring.sort()).toEqual([
    "pilot-merchant-cognito-session.mjs",
    "pilot-stripe-provider.mjs",
  ]);
});
