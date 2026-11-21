import { afterEach, beforeEach, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createInternalStaffTotpVerifier,
  provisionInternalStaffTotp,
  staffTotpFileName,
} from "./pilot-staff-totp.mjs";
import {
  decodeTotpSecret,
  generateHotp,
  totpTimeStep,
} from "../../packages/bop/identity/src/index.ts";

const staff = "01909975-0000-7000-8000-000000000001";
const kitchen = "01909975-0000-7000-8000-000000000002";
let directory;
let environment;
beforeEach(async () => {
  environment = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  directory = await mkdtemp(join(tmpdir(), "pilot-staff-totp-"));
  await writeFile(
    join(directory, "internal-test-merchant.json"),
    JSON.stringify({
      schemaVersion: 2,
      environment: "InternalTest",
      actors: [
        { selector: "staff", actorReference: staff, validUntil: "2030-01-01T00:00:00.000Z" },
        { selector: "kitchen", actorReference: kitchen, validUntil: "2030-01-01T00:00:00.000Z" },
      ],
    }),
  );
});
afterEach(async () => {
  process.env.NODE_ENV = environment;
  await rm(directory, { recursive: true, force: true });
});

it("issues private TEST-ONLY secrets for named DEMO staff and verifies their codes", async () => {
  const issued = await provisionInternalStaffTotp({ directory, selectors: ["staff", "kitchen"] });
  expect(issued.map((entry) => entry.selector)).toEqual(["staff", "kitchen"]);
  expect(issued[0]?.uri).toMatch(
    /^otpauth:\/\/totp\/BOP%20RMS%20InternalTest%3ADEMO%20staff%20staff\?secret=[A-Z2-7]+&/u,
  );
  const path = join(directory, staffTotpFileName);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.label).toContain("TEST-ONLY");
  const secret = decodeTotpSecret(saved.actors[0].secret);
  const verify = createInternalStaffTotpVerifier({ directory });
  const at = Date.now();
  expect(
    await verify({
      actorReference: staff,
      code: generateHotp(secret, totpTimeStep(at)),
      atMilliseconds: at,
    }),
  ).toEqual({ timeStep: totpTimeStep(at) });
  expect(await verify({ actorReference: staff, code: "000000", atMilliseconds: 0 })).toBeNull();
  // Already issued: kept unless explicitly rotated.
  expect(await provisionInternalStaffTotp({ directory, selectors: ["staff"] })).toEqual([]);
  const rotated = await provisionInternalStaffTotp({
    directory,
    selectors: ["staff"],
    replace: true,
  });
  expect(rotated).toHaveLength(1);
  const after = JSON.parse(await readFile(path, "utf8"));
  expect(after.actors[0].secret).not.toBe(saved.actors[0].secret);
  expect(after.actors[1].secret).toBe(saved.actors[1].secret);
});

it("refuses unknown staff, a readable secrets file and actors without a secret", async () => {
  await expect(provisionInternalStaffTotp({ directory, selectors: ["owner"] })).rejects.toThrow(
    "INTERNAL_STAFF_TOTP_UNAVAILABLE",
  );
  const verify = createInternalStaffTotpVerifier({ directory });
  await expect(
    verify({ actorReference: staff, code: "123456", atMilliseconds: Date.now() }),
  ).rejects.toThrow("INTERNAL_STAFF_TOTP_UNAVAILABLE");
  await provisionInternalStaffTotp({ directory, selectors: ["staff"] });
  await expect(
    verify({ actorReference: kitchen, code: "123456", atMilliseconds: Date.now() }),
  ).rejects.toThrow("INTERNAL_STAFF_TOTP_UNAVAILABLE");
  await chmod(join(directory, staffTotpFileName), 0o644);
  await expect(
    verify({ actorReference: staff, code: "123456", atMilliseconds: Date.now() }),
  ).rejects.toThrow("INTERNAL_STAFF_TOTP_UNAVAILABLE");
});
