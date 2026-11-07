import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { GuestSessionService, parseGuestAdmissionEvidence } from "@bop/identity";
import { parseQrTableContextEvidence } from "@rms/dining";
import { parseStoreOperatingStatusResolutionEvidence } from "@rms/store";
import { CustomerEntryHandler } from "./customer-entry.js";
import {
  createCustomerEntryComposition,
  CustomerEntryServiceUnavailableError,
} from "./customer-entry-composition.js";
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
    const result = await createCustomerEntryComposition(f.options).establish(f.input());
    // WP-2423 Q4: a closed Store, or one not serving this channel, says so (no Session).
    if (failure === "closed" || failure === "mode-disabled")
      expect(result).toMatchObject({
        status: "NotAccepting",
        operatingState: failure === "closed" ? "Closed" : "Open",
        todayHours: [],
      });
    else expect(result).toEqual({ status: "EntryUnavailable" });
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
        requestAdmission: { consume: async () => ({ status: "Allowed" }) }, // Explicit synthetic policy.
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

it("uses current evaluated operating state without reconstructing publication candidates", async () => {
  const f = fixture();
  const input = f.input();
  const readCurrent = vi.fn(async () => ({
    brandReference: id(1),
    storeReference: id(2),
    evaluatedAt: now,
    state: "Open" as const,
    availableServiceModes: ["DineIn", "Pickup"] as const,
  }));
  const result = await createCustomerEntryComposition({
    qr: f.options.qr,
    profile: f.options.profile,
    admission: f.options.admission,
    session: f.options.session,
    operatingReader: { readCurrent },
  }).establish(input);
  expect(result.status).toBe("Established");
  expect(readCurrent).toHaveBeenCalledExactlyOnceWith({
    brandReference: id(1),
    storeReference: id(2),
    publicStoreReference: id(4),
    evaluatedAt: now,
  });
  expect(f.options.operating.configurations.loadCandidates).not.toHaveBeenCalled();
});
it.each(["closed", "paused", "mode", "scope", "time", "missing"])(
  "denies current operating %s before admission",
  async (kind) => {
    const f = fixture();
    const current = {
      brandReference: id(1),
      storeReference: id(2),
      evaluatedAt: now,
      state: "Open",
      availableServiceModes: ["DineIn", "Pickup"],
    };
    if (kind === "closed") current.state = "Closed";
    if (kind === "paused") current.state = "TemporarilyClosed";
    if (kind === "mode") current.availableServiceModes = ["Pickup"];
    if (kind === "scope") current.storeReference = id(99);
    if (kind === "time") current.evaluatedAt = "2026-01-15T11:59:59.000Z";
    const operatingReader = {
      readCurrent: async () => (kind === "missing" ? null : current),
    } as import("./customer-entry-composition.js").CustomerEntryOperatingReader;
    expect(
      await createCustomerEntryComposition({
        qr: f.options.qr,
        profile: f.options.profile,
        admission: f.options.admission,
        session: f.options.session,
        operatingReader,
      }).establish(f.input()),
    ).toEqual(
      ["closed", "paused", "mode"].includes(kind)
        ? {
            status: "NotAccepting",
            storeDisplayName: expect.any(String),
            operatingState:
              kind === "closed" ? "Closed" : kind === "paused" ? "TemporarilyClosed" : "Open",
            todayHours: [],
            todayKind: null,
            nextOpening: null,
            localDate: null,
          }
        : { status: "EntryUnavailable" },
    );
    expect(f.admission).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  },
);

it("WP-2423: an operating read the database couldn't answer stays an outage, before admission", async () => {
  const f = fixture();
  const outage = new CustomerEntryServiceUnavailableError();
  await expect(
    createCustomerEntryComposition({
      qr: f.options.qr,
      profile: f.options.profile,
      admission: f.options.admission,
      session: f.options.session,
      operatingReader: {
        readCurrent: async () => {
          throw outage;
        },
      },
    }).establish(f.input()),
  ).rejects.toBe(outage);
  expect(f.admission).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it("WP-2423 item 8 ⑦ 1b: tells a guest at a pickup code that the Store takes dine-in only", async () => {
  const pickupFixture = () => {
    const f = fixture();
    f.payload.channel = f.context.channel = "Pickup";
    f.payload.publicTableReference =
      f.context.publicTableReference =
      f.context.tableReference =
        null;
    f.context.tableLifecycle = f.context.assignmentState = null;
    return f;
  };
  const establish = (f: ReturnType<typeof fixture>, servicesTurnedOff: readonly "Pickup"[]) =>
    createCustomerEntryComposition({
      qr: f.options.qr,
      profile: f.options.profile,
      admission: f.options.admission,
      session: f.options.session,
      operatingReader: {
        readCurrent: async () => ({
          brandReference: id(1),
          storeReference: id(2),
          evaluatedAt: now,
          state: "Open" as const,
          availableServiceModes: servicesTurnedOff.length === 0 ? ["DineIn", "Pickup"] : ["DineIn"],
          servicesTurnedOff,
        }),
      },
    }).establish(f.input());
  const off = pickupFixture();
  expect(await establish(off, ["Pickup"])).toEqual({
    status: "ServiceNotOffered",
    storeDisplayName: expect.any(String),
  });
  expect(off.admission).not.toHaveBeenCalled();
  expect(off.create).not.toHaveBeenCalled();
  expect((await establish(pickupFixture(), [])).status).toBe("Established");
  // A table code at the same Store still seats the guest.
  expect((await establish(fixture(), ["Pickup"])).status).toBe("Established");
});

describe("DEC-DINING-GUEST-TABLE-START: a scan at a Store where guests start tables", () => {
  const table = (changes: object = {}) => ({
    isOpen: vi.fn(async () => false),
    guestStart: vi.fn(async () => "MayStart" as const),
    ...changes,
  });
  const noVisit = (f: ReturnType<typeof fixture>) => {
    expect(f.create).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
  };
  it("a scan alone starts nothing: no Session, no admission, nothing a link preview could occupy", async () => {
    const f = fixture();
    const result = await createCustomerEntryComposition({ ...f.options, table: table() }).establish(
      f.input(),
    );
    expect(result).toMatchObject({
      status: "TableMayStart",
      storeDisplayName: expect.any(String),
    });
    expect(Object.hasOwn(result, "sessionCredential")).toBe(false);
    noVisit(f);
  });
  it("the guest's tap starts the visit, and says the table isn't open yet", async () => {
    const f = fixture();
    const result = await createCustomerEntryComposition({ ...f.options, table: table() }).establish(
      { ...f.input(), intent: "Start" },
    );
    expect(result).toMatchObject({ status: "Established", tableOpen: false });
    expect(f.create).toHaveBeenCalledOnce();
  });
  it("a table waiting for cleaning starts no visit, whatever is sent", async () => {
    const f = fixture();
    const result = await createCustomerEntryComposition({
      ...f.options,
      table: table({ guestStart: vi.fn(async () => "BeingCleaned" as const) }),
    }).establish({ ...f.input(), intent: "Start" });
    expect(result.status).toBe("TableBeingCleaned");
    noVisit(f);
  });
  it.each([
    ["the switch off", vi.fn(async () => "No" as const)],
    ["a read that failed", vi.fn(async () => Promise.reject(new Error("read")))],
  ])("%s answers exactly as before, whatever is sent", async (_name, guestStart) => {
    const f = fixture();
    const result = await createCustomerEntryComposition({
      ...f.options,
      table: table({ guestStart }),
    }).establish({ ...f.input(), intent: "Start" });
    expect(result.status).toBe("TableNotOpen");
    noVisit(f);
  });
  it("an open table a new phone may be a new party at asks once, with no visit yet; the answer goes on", async () => {
    const asked = table({
      isOpen: vi.fn(async () => true),
      asksNewParty: vi.fn(async () => true),
    });
    const f = fixture();
    expect(
      (await createCustomerEntryComposition({ ...f.options, table: asked }).establish(f.input()))
        .status,
    ).toBe("TableAskNewParty");
    noVisit(f);
    for (const intent of ["Join", "NewParty"] as const) {
      const g = fixture();
      expect(
        await createCustomerEntryComposition({ ...g.options, table: asked }).establish({
          ...g.input(),
          intent,
        }),
      ).toMatchObject({ status: "Established", tableOpen: true });
    }
  });
  it("an open table with nothing to ask, or a failed read, joins as before", async () => {
    for (const asksNewParty of [
      vi.fn(async () => false),
      vi.fn(async () => Promise.reject(new Error("read"))),
    ]) {
      const f = fixture();
      const result = await createCustomerEntryComposition({
        ...f.options,
        table: table({ isOpen: vi.fn(async () => true), asksNewParty }),
      }).establish(f.input());
      expect(result).toMatchObject({ status: "Established", tableOpen: true });
    }
  });
});

describe("WP-2423 item 13 ② (Owner 2026-11-05): a merchant the platform paused", () => {
  const paused = (f: ReturnType<typeof fixture>, table?: object) =>
    createCustomerEntryComposition({
      qr: f.options.qr,
      profile: f.options.profile,
      admission: f.options.admission,
      session: f.options.session,
      ...(table === undefined ? {} : { table: table as never }),
      operatingReader: {
        readCurrent: async () => ({
          brandReference: id(1),
          storeReference: id(2),
          evaluatedAt: now,
          state: "Open" as const,
          availableServiceModes: ["DineIn", "Pickup"],
          newGuestsPaused: true,
        }),
      },
    });
  const seated = (changes: object = {}) => ({
    isOpen: vi.fn(async () => true),
    guestStart: vi.fn(async () => "MayStart" as const),
    ...changes,
  });
  it("starts no new visit: a free table, a guest-started table or a new party, with no hours", async () => {
    for (const [table, intent] of [
      [undefined, undefined],
      [seated({ isOpen: vi.fn(async () => false) }), "Start"],
      [seated(), "NewParty"],
    ] as const) {
      const f = fixture();
      const result = await paused(f, table).establish({
        ...f.input(),
        ...(intent ? { intent } : {}),
      });
      expect(result).toMatchObject({ status: "NotAccepting", newGuestsPaused: true });
      expect(f.admission).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    }
  });
  it("lets a phone join the party already seated, so that visit finishes as usual", async () => {
    const f = fixture();
    expect(await paused(f, seated()).establish(f.input())).toMatchObject({
      status: "Established",
      tableOpen: true,
    });
    expect(f.create).toHaveBeenCalledOnce();
  });
});

describe("M104/M105: a rescan goes on with this phone's visit", () => {
  const pickup = (f: ReturnType<typeof fixture>) => {
    f.payload.channel = f.context.channel = "Pickup";
    f.payload.publicTableReference =
      f.context.publicTableReference =
      f.context.tableReference =
        null;
    f.context.tableLifecycle = f.context.assignmentState = null;
    return f;
  };
  const first = async (f: ReturnType<typeof fixture>) => {
    const result = await createCustomerEntryComposition(f.options).establish(f.input());
    if (result.status !== "Established") throw new Error("synthetic entry unavailable");
    return result;
  };
  const again = (
    f: ReturnType<typeof fixture>,
    presented: readonly { source: "Current" | "Earlier"; credential: string }[],
    options = f.options,
  ) =>
    createCustomerEntryComposition(options).establish({
      ...f.input(),
      presentedCredentials: presented,
    });

  it("a pickup code scanned again resumes the same visit: no new Session, no admission", async () => {
    const f = pickup(fixture());
    const visit = await first(f);
    const result = await again(f, [{ source: "Current", credential: visit.sessionCredential }]);
    expect(result).toMatchObject({
      status: "Established",
      resumed: true,
      channel: "Pickup",
      sessionCredential: visit.sessionCredential,
      earlierCredentials: [],
    });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.admission).toHaveBeenCalledOnce();
    expect(f.records.size).toBe(1);
    // The resumed visit is renewed, once.
    expect(f.options.session.store.touchInteractive).toHaveBeenCalledOnce();
  });

  it("never renews the earlier visits it only checks (a scan elsewhere doesn't extend them)", async () => {
    const f = fixture();
    const table = await first(f);
    pickup(f);
    const result = await again(f, [{ source: "Current", credential: table.sessionCredential }]);
    expect(result).toMatchObject({ status: "Established", channel: "Pickup" });
    expect(result).not.toHaveProperty("resumed");
    expect(f.options.session.store.touchInteractive).not.toHaveBeenCalled();
  });

  it("resumes an existing visit while the Store is paused for new guests (it finishes as usual)", async () => {
    const f = pickup(fixture());
    const visit = await first(f);
    const result = await again(f, [{ source: "Current", credential: visit.sessionCredential }], {
      qr: f.options.qr,
      profile: f.options.profile,
      admission: f.options.admission,
      session: f.options.session,
      operatingReader: {
        readCurrent: async () => ({
          brandReference: id(1),
          storeReference: id(2),
          evaluatedAt: now,
          state: "Closed" as const,
          availableServiceModes: [],
          newGuestsPaused: true,
        }),
      },
    } as never);
    expect(result).toMatchObject({
      status: "Established",
      resumed: true,
      operatingState: "Closed",
    });
    expect(f.create).toHaveBeenCalledOnce();
    // A phone with no visit here is still refused.
    expect(
      await again(f, [], {
        qr: f.options.qr,
        profile: f.options.profile,
        admission: f.options.admission,
        session: f.options.session,
        operatingReader: {
          readCurrent: async () => ({
            brandReference: id(1),
            storeReference: id(2),
            evaluatedAt: now,
            state: "Open" as const,
            availableServiceModes: ["Pickup"],
            newGuestsPaused: true,
          }),
        },
      } as never),
    ).toMatchObject({ status: "NotAccepting", newGuestsPaused: true });
  });

  it("an ended visit here starts a new one, says so, and keeps the old one for its receipts", async () => {
    const f = pickup(fixture());
    const visit = await first(f);
    const [key, record] = [...f.records.entries()][0] as [string, never];
    const old = record as { session: Record<string, unknown> };
    const createdAt = new Date(Date.parse(now) - 5 * 3_600_000).toISOString();
    f.records.set(key, {
      ...old,
      session: {
        ...old.session,
        createdAt,
        lastSeenAt: createdAt,
        idleExpiresAt: new Date(Date.parse(createdAt) + 4 * 3_600_000).toISOString(),
        absoluteExpiresAt: new Date(Date.parse(createdAt) + 24 * 3_600_000).toISOString(),
      },
    } as never);
    const result = await again(f, [{ source: "Current", credential: visit.sessionCredential }]);
    expect(result).toMatchObject({
      status: "Established",
      previousVisit: "EndedReceiptsKept",
      earlierCredentials: [visit.sessionCredential],
    });
    expect(result).not.toHaveProperty("resumed");
    if (result.status !== "Established") throw new Error("expected a visit");
    expect(result.sessionCredential).not.toBe(visit.sessionCredential);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("keeps a table visit here, and a visit this Store can't see, when a pickup code starts a new one", async () => {
    const f = fixture();
    const table = await first(f);
    pickup(f);
    const elsewhere = "E".repeat(43);
    const result = await again(f, [
      { source: "Current", credential: table.sessionCredential },
      { source: "Earlier", credential: elsewhere },
    ]);
    expect(result).toMatchObject({
      status: "Established",
      channel: "Pickup",
      earlierCredentials: [table.sessionCredential, elsewhere],
    });
    expect(result).not.toHaveProperty("resumed");
    expect(result).not.toHaveProperty("previousVisit");
  });

  it("goes back to a kept earlier pickup visit when this Store's code is scanned again", async () => {
    const f = pickup(fixture());
    const visit = await first(f);
    const other = "O".repeat(43);
    const result = await again(f, [
      { source: "Current", credential: other },
      { source: "Earlier", credential: visit.sessionCredential },
    ]);
    expect(result).toMatchObject({
      status: "Established",
      resumed: true,
      sessionCredential: visit.sessionCredential,
      earlierCredentials: [other],
    });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("answers a retry, never a new visit, when the visit can't be checked", async () => {
    const f = pickup(fixture());
    const visit = await first(f);
    const failing = {
      ...f.options,
      session: {
        ...f.options.session,
        store: {
          ...f.options.session.store,
          resolve: async () => {
            throw Object.assign(new Error("acquire"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" });
          },
        },
      },
    };
    await expect(
      again(f, [{ source: "Current", credential: visit.sessionCredential }], failing),
    ).rejects.toBeInstanceOf(CustomerEntryServiceUnavailableError);
    expect(f.create).toHaveBeenCalledOnce();
  });
});
