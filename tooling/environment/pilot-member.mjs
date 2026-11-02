// WP-2423 取舍 18 DEC-MEMBER-POINTS: composes members and points for one Store. A code or a phone
// number never reaches a log, a URL or an error from here.
import { Buffer } from "node:buffer";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CustomerMemberHandler } from "../../apps/api/dist/customer-member-http.js";
import { createCustomerMember } from "../../apps/api/dist/customer-member.js";
import { createMemberPointsSweep } from "../../apps/api/dist/member-points-sweep.js";
import { createMemberPhoneProtector } from "../../packages/rms/customer-loyalty/src/index.ts";
import { createAbuseBudgetConsumer } from "../../packages/database/src/index.ts";
import { currentPilotEnvironment } from "./pilot-environment.mjs";
import { loadPilotManagedSecrets } from "./pilot-secrets.mjs";

const ROUTE = "/bff/customer/member";
export const INTERNAL_TEST_MEMBER_INBOX = "member-messages-test-only";

/**
 * TEST-ONLY, InternalTest installations only: stands in for the text-message account that doesn't
 * exist yet. The tester reads the newest message for a number from a private file, one per last
 * four digits, in `<runtime>/member-messages-test-only/` (`docker exec`), so nothing is logged.
 * Guests and staff never see that this is not a real text. Refuses any production configuration.
 */
export function createInternalTestMemberMessages(directory, { env = process.env } = {}) {
  if (
    env.NODE_ENV === "production" ||
    env.BOP_PILOT_ENVIRONMENT === "Pilot" ||
    currentPilotEnvironment({ unset: "development", env }) !== "InternalTest"
  )
    throw new Error("MEMBER_TEST_MESSAGES_REFUSED");
  const folder = join(directory, INTERNAL_TEST_MEMBER_INBOX);
  return Object.freeze({
    testOnly: true,
    async send({ phone, kind, text }) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, phone.slice(-4) + ".json");
      const temporary = file + "." + randomBytes(6).toString("hex");
      await writeFile(temporary, JSON.stringify({ kind, text }), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    },
  });
}

/** The key that protects phone numbers: managed in a Pilot, a local generated file in InternalTest. */
async function loadMemberKey(directory, { env = process.env } = {}) {
  if (currentPilotEnvironment({ unset: "development", env }) === "Pilot")
    return (await loadPilotManagedSecrets(directory)).key("member-contact-key");
  const file = join(directory, "internal-test-member-key");
  try {
    return Buffer.from(await readFile(file, "utf8"), "base64url");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const key = randomBytes(32);
    await writeFile(file, key.toString("base64url"), { mode: 0o600, flag: "wx" }).catch(
      async (reason) => {
        if (reason?.code !== "EEXIST") throw reason;
      },
    );
    return Buffer.from(await readFile(file, "utf8"), "base64url");
  }
}

/**
 * Real text messages use the installation's order-message SMS channel; a Pilot without one has no
 * way to send (joining says so). Only InternalTest may use the test stand-in.
 */
export function memberMessages({ directory, sms = null, env = process.env }) {
  if (sms !== null)
    return Object.freeze({
      send: ({ phone, text }) => sms.send({ channel: "Sms", destination: phone, text }),
    });
  return currentPilotEnvironment({ unset: "development", env }) === "Pilot"
    ? null
    : createInternalTestMemberMessages(directory, { env });
}

const budgetOf = (resources) =>
  Object.freeze({
    async consume(bucket, key, policy) {
      const result = await createAbuseBudgetConsumer({
        bucketClass: bucket,
        windowSeconds: policy.windowSeconds,
        limitCount: policy.limit,
        now: resources.now,
        query: async (sql, values) => {
          const connection = await resources.database.acquire();
          try {
            return await connection.query(sql, [...values]);
          } finally {
            connection.release();
          }
        },
      }).consume(key);
      return { allowed: result.allowed, retryAfterSeconds: result.retry_after_seconds };
    },
  });

export async function registerInternalMember(app, { directory, resources, access, origin, sms }) {
  const port = createCustomerMember({
    access,
    tenantReference: resources.publicProfile.binding.tenantReference,
    protector: createMemberPhoneProtector(await loadMemberKey(directory)),
    messages: memberMessages({ directory, sms }),
    budget: budgetOf(resources),
    nextReference: resources.credentials.reference,
  });
  app.post(ROUTE, ...new CustomerMemberHandler({ allowedOrigin: origin, port }).handler());
}

export async function createInternalMemberSweep({
  directory,
  resources,
  providerAccountReference,
  environment,
  sms = null,
}) {
  return createMemberPointsSweep({
    scope: {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
      providerAccountReference,
      environment,
    },
    transactions: resources.transactions,
    protector: createMemberPhoneProtector(await loadMemberKey(directory)),
    messages: memberMessages({ directory, sms }),
    nextReference: resources.credentials.reference,
    now: resources.now,
  });
}
