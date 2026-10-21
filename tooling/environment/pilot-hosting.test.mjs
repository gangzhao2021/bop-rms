import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  INTERNAL_CUSTOMER_ORIGIN,
  checkCertificateFiles,
  checkPilotTls,
  isPublicHostname,
  loadPilotHosting,
  parsePilotHosting,
} from "./pilot-hosting.mjs";
import { createTestCertificates } from "./pilot-test-certificates.mjs";

const pilot = { env: { NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" } };
const internal = { env: { NODE_ENV: "development" } };
const valid = {
  schemaVersion: 1,
  environment: "Pilot",
  customerOrigin: "https://order.store-pilot.ca",
  secretsDirectory: "/run/secrets/bop-rms",
  tls: {
    mode: "front",
    certificateFile: "/run/tls/fullchain.pem",
    keyFile: "/run/tls/privkey.pem",
  },
};
let directory, certificates;
beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pilot-hosting-")));
  certificates = await createTestCertificates(directory);
}, 60_000);
afterAll(() => fs.rm(directory, { recursive: true, force: true }));

it("DEC-PILOT-MAINTENANCE-PAGE: no hosting.json keeps the local internal test entry", async () => {
  const hosting = parsePilotHosting(null, internal);
  expect(hosting).toMatchObject({
    configured: false,
    origin: INTERNAL_CUSTOMER_ORIGIN,
    host: "127.0.0.1:4443",
    secretsDirectory: null,
    tls: { mode: "internal" },
  });
  expect(await loadPilotHosting(path.join(directory, "absent"), internal)).toMatchObject({
    configured: false,
  });
});

it("DEC-PILOT-SECRETS: a Pilot hosting.json names the origin, secrets folder and certificate", () => {
  expect(parsePilotHosting(valid, pilot)).toMatchObject({
    configured: true,
    origin: "https://order.store-pilot.ca",
    host: "order.store-pilot.ca",
    hostname: "order.store-pilot.ca",
    secretsDirectory: "/run/secrets/bop-rms",
    tls: { mode: "front", certificateFile: "/run/tls/fullchain.pem" },
  });
  expect(parsePilotHosting({ ...valid, tls: { mode: "proxy" } }, pilot).tls).toEqual({
    mode: "proxy",
  });
  const reason = (value, options = pilot) => {
    try {
      parsePilotHosting(value, options);
      return null;
    } catch (error) {
      return error.reason;
    }
  };
  expect(reason({ ...valid, environment: "InternalTest" })).toBe("environment");
  expect(reason({ ...valid, customerOrigin: "http://order.store-pilot.ca" })).toBe(
    "customerOrigin",
  );
  expect(reason({ ...valid, customerOrigin: "https://order.store-pilot.ca/menu" })).toBe(
    "customerOrigin",
  );
  expect(reason({ ...valid, customerOrigin: "https://a:b@order.store-pilot.ca" })).toBe(
    "customerOrigin",
  );
  expect(reason({ ...valid, secretsDirectory: undefined })).toBe("secretsDirectory");
  expect(reason({ ...valid, secretsDirectory: "relative/secrets" })).toBe("secretsDirectory");
  expect(reason({ ...valid, tls: { mode: "front", certificateFile: "/x" } })).toBe("tls");
  expect(reason({ ...valid, tls: { mode: "selfsigned" } })).toBe("tls.mode");
  expect(reason({ ...valid, extra: 1 })).toBe("keys");
  // InternalTest (DEMO login, simulated payment) is never put on a public name or managed keys.
  const test = {
    ...valid,
    environment: "InternalTest",
    secretsDirectory: undefined,
    tls: undefined,
  };
  expect(reason(test, internal)).toBe("customerOrigin.internal-test");
  expect(
    reason({ ...test, customerOrigin: INTERNAL_CUSTOMER_ORIGIN, secretsDirectory: "/s" }, internal),
  ).toBe("secretsDirectory");
  expect(
    parsePilotHosting({ ...test, customerOrigin: INTERNAL_CUSTOMER_ORIGIN }, internal).origin,
  ).toBe(INTERNAL_CUSTOMER_ORIGIN);
});

it("DEC-PILOT-MAINTENANCE-PAGE: only public names count as a customer domain", () => {
  for (const name of ["order.store-pilot.ca", "shop.example-restaurant.com"])
    expect(isPublicHostname(name)).toBe(true);
  for (const name of [
    "127.0.0.1",
    "localhost",
    "pilot.local",
    "order.example.com",
    "x.test",
    "::1",
    "intranet",
  ])
    expect(isPublicHostname(name)).toBe(false);
});

it("DEC-PILOT-MAINTENANCE-PAGE: a mounted certificate counts only when trusted, for this name, valid and matching its key", async () => {
  const files = {
    certificateFile: certificates.certificateFile,
    keyFile: certificates.keyFile,
    hostname: "order.store-pilot.ca",
  };
  const roots = [certificates.root];
  expect(await checkCertificateFiles(files, { roots })).toBeNull();
  // Not in the public trust store (the default roots): a private or self-signed certificate.
  expect(await checkCertificateFiles(files)).toBe("certificate-not-trusted");
  expect(
    await checkCertificateFiles({ ...files, hostname: "other.store-pilot.ca" }, { roots }),
  ).toBe("certificate-wrong-host");
  expect(
    await checkCertificateFiles({ ...files, keyFile: certificates.rootKeyFile }, { roots }),
  ).toBe("certificate-key-mismatch");
  expect(
    await checkCertificateFiles(files, { roots, now: Date.now() + 400 * 24 * 3600 * 1000 }),
  ).toBe("certificate-expired");
  expect(await checkCertificateFiles({ ...files, certificateFile: "/absent.pem" }, { roots })).toBe(
    "certificate-unreadable",
  );
  // A full chain file (leaf then intermediates) is accepted the same way.
  const chain = path.join(directory, "chain.pem");
  await fs.writeFile(
    chain,
    (await fs.readFile(certificates.certificateFile, "utf8")) + certificates.root,
  );
  expect(await checkCertificateFiles({ ...files, certificateFile: chain }, { roots })).toBeNull();
});

it("DEC-PILOT-MAINTENANCE-PAGE: the Tls gap clears only with a public origin and a trusted certificate", async () => {
  expect(await checkPilotTls(parsePilotHosting(null, internal))).toBe(
    "customer-origin-not-configured",
  );
  const front = parsePilotHosting(valid, pilot);
  expect(await checkPilotTls(front, { checkFiles: async () => null })).toBeNull();
  expect(await checkPilotTls(front, { checkFiles: async () => "certificate-expired" })).toBe(
    "certificate-expired",
  );
  const proxy = parsePilotHosting({ ...valid, tls: { mode: "proxy" } }, pilot);
  const seen = [];
  expect(
    await checkPilotTls(proxy, {
      handshake: async (target) => {
        seen.push(target);
        return null;
      },
    }),
  ).toBeNull();
  expect(seen).toEqual([{ hostname: "order.store-pilot.ca", port: 443 }]);
  const notPublic = parsePilotHosting(
    { ...valid, customerOrigin: "https://pilot.internal" },
    pilot,
  );
  expect(await checkPilotTls(notPublic, { checkFiles: async () => null })).toBe(
    "customer-origin-not-public",
  );
  const noTls = parsePilotHosting({ ...valid, tls: undefined }, pilot);
  expect(await checkPilotTls(noTls)).toBe("certificate-not-configured");
});
