import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { GuestSessionService, parseGuestAdmissionEvidence } from "@bop/identity";
import { parseQrTableContextEvidence } from "@rms/dining";
import { parseStoreOperatingStatusResolutionEvidence } from "@rms/store";
import { CustomerEntryHandler } from "./customer-entry.js";
import { createCustomerEntryComposition } from "./customer-entry-composition.js";
import { createApiRuntimeLogger, createApiServerRuntime } from "./server.js";
import {
  fixture,
  id,
  now,
  admissionUntil,
} from "../test-support/customer-entry-composition-fixture.js";

describe("WP-2208 Customer Entry domain composition", () => {
  it.each(["DineIn", "Pickup"])(
    "composes real services for %s and stores only selectors",
    async (channel) => {
      const f = fixture();
      if (channel === "Pickup") {
        f.payload.channel = f.context.channel = "Pickup";
        f.payload.publicTableReference =
          f.context.publicTableReference =
          f.context.tableReference =
            null;
        f.context.tableLifecycle = f.context.assignmentState = null;
      }
      const result = await createCustomerEntryComposition(f.options).establish(f.input());
      expect(result.status).toBe("Established");
      if (result.status !== "Established") throw new Error("synthetic entry unavailable");
      expect(result).toMatchObject({
        channel,
        contextExpiresAt: admissionUntil,
        operatingState: "Open",
        brandDisplayName: "Synthetic Brand",
      });
      expect(f.create).toHaveBeenCalledOnce();
      const record = [...f.records.values()][0];
      expect(record?.session).toMatchObject({
        brandReference: id(1),
        storeReference: id(2),
        diningState: "ContextOnly",
        channel,
        version: 1,
      });
      expect(JSON.stringify(record)).not.toContain(result.sessionCredential);
      expect(JSON.stringify(record)).not.toContain(result.csrfCredential);
      const identity = new GuestSessionService({
        ...f.options.session,
        admission: { consume: async () => null },
      });
      expect(
        await identity.authorize({
          sessionCredential: result.sessionCredential,
          csrfCredential: result.csrfCredential,
          observedAt: now,
        }),
      ).toEqual(record?.session);
    },
  );

  it.each(["signature", "revoked", "expired", "key-unavailable", "context-stale"])(
    "denies %s before Store reads",
    async (failure) => {
      const f = fixture();
      if (failure === "revoked") f.context.qrState = "Revoked";
      if (failure === "expired") f.payload.expiresAt = now;
      if (failure === "context-stale") f.context.validUntil = now;
      if (failure === "key-unavailable")
        vi.mocked(f.options.qr.keys.load).mockRejectedValue(new Error("synthetic hidden detail"));
      const input = f.input();
      if (failure === "signature")
        input.qrToken = `${input.qrToken.split(".").slice(0, 2).join(".")}.${Buffer.alloc(64).toString("base64url")}`;
      expect(await createCustomerEntryComposition(f.options).establish(input)).toEqual({
        status: "EntryUnavailable",
      });
      expect(f.options.profile.resolution.resolve).not.toHaveBeenCalled();
      expect(f.admission).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    "profile-scope",
    "operating-scope",
    "unpublished",
    "closed",
    "mode-disabled",
    "store-stale",
  ])("denies %s before admission", async (failure) => {
    const f = fixture();
    if (failure === "profile-scope") f.resolution.brandReference = id(88);
    if (failure === "operating-scope")
      vi.mocked(f.options.operating.resolution.resolve).mockImplementation(async () =>
        parseStoreOperatingStatusResolutionEvidence({ ...f.resolution, storeReference: id(88) }),
      );
    if (failure === "unpublished") f.profile.publishingLifecycle.state = "Draft";
    if (failure === "closed")
      f.operating.weeklySchedule.forEach((day) => {
        day.intervals = [];
      });
    if (failure === "mode-disabled")
      f.operating.weeklySchedule.forEach((day) => {
        day.intervals.forEach((interval) => {
          interval.serviceModes = ["Pickup"];
        });
      });
    if (failure === "store-stale") f.resolution.validUntil = now;
    expect(await createCustomerEntryComposition(f.options).establish(f.input())).toEqual({
      status: "EntryUnavailable",
    });
    expect(f.admission).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([
    "denied",
    "malformed",
    "stale",
    "future",
    "brand",
    "store",
    "table",
    "public-store",
    "qr",
    "revision",
    "locale",
    "request",
    "channel",
  ])("denies %s admission before issuing credentials", async (failure) => {
    const f = fixture();
    f.admission.mockImplementation(async (input) => {
      if (failure === "denied") return null;
      const evidence = f.admissionEvidence(input);
      const changes: Record<string, Record<string, unknown>> = {
        malformed: { decision: "Unexpected" },
        stale: { validUntil: now },
        future: { evaluatedAt: admissionUntil },
        brand: { brandReference: id(88) },
        store: { storeReference: id(88) },
        table: { publicTableReference: id(88) },
        "public-store": { publicStoreReference: id(88) },
        qr: { qrReference: id(88) },
        revision: { qrRevocationVersion: 2 },
        locale: { locale: "fr-CA" },
        request: { entryRequestReference: id(88) },
        channel: { channel: "Pickup", publicTableReference: null },
      };
      return { ...evidence, ...changes[failure] } as unknown as ReturnType<
        typeof parseGuestAdmissionEvidence
      >;
    });
    expect(await createCustomerEntryComposition(f.options).establish(f.input())).toEqual({
      status: "EntryUnavailable",
    });
    expect(f.options.session.credentials.generateCredential).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("does not reissue on replay or retry after an unknown commit", async () => {
    const f = fixture();
    f.admission.mockImplementation(async (input) =>
      parseGuestAdmissionEvidence(f.admissionEvidence(input)),
    );
    const port = createCustomerEntryComposition(f.options);
    const input = f.input();
    expect((await port.establish(input)).status).toBe("Established");
    expect(await port.establish(input)).toEqual({ status: "EntryUnavailable" });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.options.session.credentials.generateCredential).toHaveBeenCalledTimes(2);
    f.create.mockImplementationOnce(async ({ record }) => {
      f.records.set(record.operationReference, record);
      throw new Error("synthetic lost acknowledgement");
    });
    const next = f.input();
    expect(await port.establish(next)).toEqual({ status: "EntryUnavailable" });
    expect(await port.establish(next)).toEqual({ status: "EntryUnavailable" });
    expect(f.records.size).toBe(2);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("isolates concurrent proofs and bounds expiry by the verified context", async () => {
    const f = fixture();
    f.context.validUntil = "2026-01-15T12:00:30.000Z";
    const port = createCustomerEntryComposition(f.options);
    const first = f.input();
    f.payload.publicTableReference = id(55);
    const inputs = [first, f.input()];
    vi.mocked(f.options.qr.contexts.resolve).mockImplementation(async (payload) => {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, payload.publicTableReference === id(5) ? 10 : 0),
      );
      return parseQrTableContextEvidence({
        ...f.context,
        publicTableReference: payload.publicTableReference,
      });
    });
    const results = await Promise.all(inputs.map((input) => port.establish(input)));
    expect(results.map((result) => result.status)).toEqual(["Established", "Established"]);
    for (const result of results)
      expect(result).toMatchObject({ contextExpiresAt: f.context.validUntil });
    expect(f.records.size).toBe(2);
    expect(f.records.get(first.operationReference)?.session.publicTableReference).toBe(id(5));
    expect(f.records.get(inputs[1]?.operationReference ?? "")?.session.publicTableReference).toBe(
      id(55),
    );
    expect(
      new Set([...f.records.values()].map((record) => record.session.sessionReference)).size,
    ).toBe(2);
    expect(f.admission.mock.calls.map(([input]) => input.entryRequestReference).sort()).toEqual(
      inputs.map((input) => input.entryRequestReference).sort(),
    );
  });

  it.each(["profile", "operating", "admission", "credentials", "store"])(
    "fails closed on a %s dependency failure",
    async (failure) => {
      const f = fixture();
      const error = new Error("synthetic private dependency detail");
      if (failure === "profile")
        vi.mocked(f.options.profile.profiles.loadCandidates).mockRejectedValue(error);
      if (failure === "operating")
        vi.mocked(f.options.operating.configurations.loadCandidates).mockRejectedValue(error);
      if (failure === "admission") f.admission.mockRejectedValue(error);
      if (failure === "credentials")
        vi.mocked(f.options.session.credentials.generateCredential).mockImplementation(() => {
          throw error;
        });
      if (failure === "store") f.create.mockRejectedValue(error);
      expect(await createCustomerEntryComposition(f.options).establish(f.input())).toEqual({
        status: "EntryUnavailable",
      });
      expect(f.records.size).toBe(0);
      expect(f.create).toHaveBeenCalledTimes(failure === "store" ? 1 : 0);
    },
  );

  it("consumes a duplicate request proof once under concurrent calls", async () => {
    const f = fixture();
    const port = createCustomerEntryComposition(f.options);
    const input = f.input();
    const results = await Promise.all([port.establish(input), port.establish(input)]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "EntryUnavailable",
      "Established",
    ]);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.records.size).toBe(1);
  });

  it("serves the composed success over real HTTP and guards denied input without sensitive logs", async () => {
    const f = fixture();
    let sequence = 500;
    const logs: string[] = [];
    const allowedOrigin = "https://customer.invalid";
    const runtime = createApiServerRuntime({
      port: 0,
      logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
      customerEntry: new CustomerEntryHandler({
        allowedOrigin,
        now: () => now,
        uuidV7Factory: () => id(++sequence),
        port: createCustomerEntryComposition(f.options),
      }),
    });
    const qrToken = f.token();
    let responseBody: string;
    let cookie: string;
    try {
      await runtime.listen();
      const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}/bff/customer/entry`;
      const headers = {
        "content-type": "application/json",
        origin: allowedOrigin,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      };
      const denied = await fetch(url, {
        method: "POST",
        headers: { ...headers, origin: "https://other.invalid" },
        body: JSON.stringify({ qrToken }),
      });
      expect(denied.status).toBe(400);
      await denied.text();
      expect(f.options.qr.keys.load).not.toHaveBeenCalled();
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ qrToken }),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toContain("no-store");
      cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/^__Host-bop-guest=/u);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      responseBody = await response.text();
      expect(JSON.parse(responseBody)).toMatchObject({
        schemaVersion: 2,
        status: "Established",
        contextExpiresAt: admissionUntil,
      });
      for (const hidden of [
        "brandReference",
        "storeReference",
        "sessionReference",
        "sessionCredential",
        "qrReference",
      ])
        expect(responseBody).not.toContain(`"${hidden}"`);
      f.context.qrState = "Revoked";
      const revoked = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ qrToken }),
      });
      expect(revoked.status).toBe(422);
      expect(revoked.headers.get("set-cookie")).toBeNull();
      expect(await revoked.text()).not.toContain("Revoked");
      expect(f.records.size).toBe(1);
    } finally {
      await runtime.shutdown("SIGTERM");
    }
    expect(runtime.server.listening).toBe(false);
    const csrf = (JSON.parse(responseBody) as { csrfToken: string }).csrfToken;
    for (const sensitive of [qrToken, csrf, cookie.split(";")[0]?.split("=")[1], id(1), id(2)]) {
      expect(sensitive).toBeTruthy();
      expect(logs.join("")).not.toContain(sensitive);
    }
  });
});
