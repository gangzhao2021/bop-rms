import { describe, expect, it, vi } from "vitest";
import {
  createStaffTableAbandonment,
  createStaffTableCode,
  createStaffTableGuestPipeline,
} from "./table-guest-pipeline.js";

// WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): the table guest steps map the customer ports'
// answers exactly; owner ports are doubles that record what they are handed.
const id = (n: number) => `0198a7c0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const staff = { sessionCookie: "cookie", csrf: "csrf" };

describe("staff table code", () => {
  const base = () => {
    let sequence = 0x200;
    return {
      loadTable: vi.fn(async () => ({
        aggregateVersion: 3,
        activeDiningSessionReference: null as string | null,
        seatable: true,
      })),
      loadJoinState: vi.fn(async () => ({
        tableReference: id(30),
        sessionVersion: 5,
        tableAssignmentVersion: 3,
        capabilityVersion: 2,
        generation: 4,
      })),
      start: vi.fn(async () => ({
        status: "Issued",
        session: { diningSessionReference: id(31) },
        capability: { generation: 1 },
        joinCredential: "123456",
      })),
      regenerate: vi.fn(async () => ({ status: "Issued", joinCredential: "654321" })),
      nextReference: () => id(++sequence),
    };
  };

  it("starts a session at a free table, as staff do on the Tables page", async () => {
    const ports = base();
    expect(await createStaffTableCode(ports)(staff, { tableReference: id(30) })).toEqual({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "123456",
      started: true,
      generation: 1,
    });
    expect(ports.start).toHaveBeenCalledWith(staff, {
      tableReference: id(30),
      expectedAssignmentVersion: 3,
      operationReference: expect.any(String),
      joinKind: "HumanCode",
    });
    expect(ports.regenerate).not.toHaveBeenCalled();
  });

  it("issues a fresh one-time code for a table that already has guests", async () => {
    const ports = base();
    ports.loadTable.mockResolvedValue({
      aggregateVersion: 3,
      activeDiningSessionReference: id(31),
      seatable: true,
    });
    expect(await createStaffTableCode(ports)(staff, { tableReference: id(30) })).toEqual({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "654321",
      started: false,
      generation: null,
    });
    expect(ports.regenerate).toHaveBeenCalledWith(staff, {
      diningSessionReference: id(31),
      tableReference: id(30),
      expectedAssignmentVersion: 3,
      expectedSessionVersion: 5,
      expectedCapabilityVersion: 2,
      expectedGeneration: 4,
      operationReference: expect.any(String),
    });
  });

  it("reads the table again once when another staff member started its session first", async () => {
    const ports = base();
    ports.start.mockRejectedValueOnce(new Error("DINING_SESSION_UNAVAILABLE"));
    ports.loadTable
      .mockResolvedValueOnce({
        aggregateVersion: 3,
        activeDiningSessionReference: null,
        seatable: true,
      })
      .mockResolvedValueOnce({
        aggregateVersion: 3,
        activeDiningSessionReference: id(31),
        seatable: true,
      });
    expect(await createStaffTableCode(ports)(staff, { tableReference: id(30) })).toMatchObject({
      status: "Opened",
      joinCredential: "654321",
    });
  });

  it("answers TableUnavailable for a table that can't be seated or keeps changing", async () => {
    const ports = base();
    ports.loadTable.mockResolvedValue({
      aggregateVersion: 3,
      activeDiningSessionReference: null,
      seatable: false,
    });
    expect(await createStaffTableCode(ports)(staff, { tableReference: id(30) })).toEqual({
      status: "TableUnavailable",
    });
    const busy = base();
    busy.start.mockRejectedValue(new Error("conflict"));
    expect(await createStaffTableCode(busy)(staff, { tableReference: id(30) })).toEqual({
      status: "TableUnavailable",
    });
    // A replay of an earlier start returns no code to give the table guest.
    const replay = base();
    replay.start.mockResolvedValue({ status: "AlreadyApplied" } as never);
    expect(await createStaffTableCode(replay)(staff, { tableReference: id(30) })).toEqual({
      status: "TableUnavailable",
    });
  });
});

describe("staff table abandonment — WP-2423 item 7", () => {
  const ports = () => {
    let sequence = 0x250;
    return {
      loadJoinState: vi.fn(async () => ({
        tableReference: id(30),
        sessionVersion: 2,
        tableAssignmentVersion: 3,
        capabilityVersion: 2,
        generation: 1,
      })),
      close: vi.fn(async (_staff: unknown, command: { action: "Begin" | "Finalize" }) =>
        command.action === "Begin"
          ? { phase: "Closing", sessionVersion: 3 }
          : { phase: "Closed", sessionVersion: 4 },
      ),
      nextReference: () => id(++sequence),
    };
  };
  const input = { tableReference: id(30), diningSessionReference: id(31), generation: 1 };

  it("closes the empty session with the closing commands, as a manager does on the Tables page", async () => {
    const p = ports();
    expect(await createStaffTableAbandonment(p)(staff, input)).toBe("Closed");
    expect(p.close.mock.calls).toEqual([
      [
        staff,
        {
          action: "Begin",
          diningSessionReference: id(31),
          operationReference: expect.any(String),
          expectedSessionVersion: 2,
        },
      ],
      [
        staff,
        {
          action: "Finalize",
          diningSessionReference: id(31),
          operationReference: expect.any(String),
          expectedSessionVersion: 3,
        },
      ],
    ]);
  });

  it("keeps a session someone issued a newer code for, or that it can't read", async () => {
    const newer = ports();
    newer.loadJoinState.mockResolvedValueOnce({
      tableReference: id(30),
      sessionVersion: 2,
      tableAssignmentVersion: 3,
      capabilityVersion: 3,
      generation: 2,
    });
    expect(await createStaffTableAbandonment(newer)(staff, input)).toBe("Kept");
    expect(newer.close).not.toHaveBeenCalled();
    const gone = ports();
    gone.loadJoinState.mockResolvedValueOnce(null as never);
    expect(await createStaffTableAbandonment(gone)(staff, input)).toBe("Kept");
    expect(await createStaffTableAbandonment(ports())(staff, { ...input, generation: null })).toBe(
      "Kept",
    );
  });

  it("keeps it for staff who can't close sessions (no new permission), and reports other failures", async () => {
    const frontOfHouse = ports();
    frontOfHouse.close.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "DINING_CLOSING_PERMISSION_DENIED" }),
    );
    expect(await createStaffTableAbandonment(frontOfHouse)(staff, input)).toBe("Kept");
    expect(frontOfHouse.close).toHaveBeenCalledTimes(1);
    const broken = ports();
    broken.close.mockRejectedValueOnce(new Error("connection reset"));
    await expect(createStaffTableAbandonment(broken)(staff, input)).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("staff table guest pipeline", () => {
  const credentials = { sessionCredential: "a".repeat(43), csrfCredential: "b".repeat(43) };
  const setup = () => {
    let sequence = 0x300;
    const options = {
      takesOrder: vi.fn(async () => true),
      openTable: vi.fn(),
      abandonTable: vi.fn(),
      tableQrToken: vi.fn(async () => "table-qr"),
      entry: {
        establish: vi.fn(async () => ({
          status: "Established",
          channel: "DineIn",
          sessionCredential: credentials.sessionCredential,
          csrfCredential: credentials.csrfCredential,
        })),
      },
      join: {
        join: vi.fn(async (input: { operationReference: string }) => ({
          status: "Joined",
          operationReference: input.operationReference,
          admissionReference: id(40),
        })),
      },
      joinRequest: vi.fn(async () => ({ abuse: "budget" })),
      binding: {
        prepare: vi.fn(async () => ({
          status: "Prepared",
          operationReference: id(41),
          sessionCredential: "c".repeat(43),
          csrfCredential: "d".repeat(43),
          recoveryProof: "e".repeat(43),
          expiresAt: "2026-10-15T18:05:00.000Z",
        })),
        activate: vi.fn(async () => ({
          status: "Activated",
          operationReference: id(41),
          sessionCredential: "c".repeat(43),
          csrfCredential: "d".repeat(43),
          cookie: {},
        })),
      },
      sessions: { authorize: vi.fn(async () => ({ sessionReference: id(42) })) },
      cart: {
        createCart: vi.fn(async () => ({
          status: "Current",
          view: {
            cart: {
              cartReference: id(43),
              version: 9,
              orderType: "DineIn",
              items: [{ displayName: "Iced latte", quantity: 2 }],
            },
          },
        })),
        addItem: vi.fn(),
      },
      quote: { quoteCart: vi.fn() },
      details: { save: vi.fn() },
      checkout: { create: vi.fn() },
      payment: { prepare: vi.fn(async () => ({ tip: { amountMinor: 0n } })) },
      nextReference: () => id(++sequence),
      now: () => "2026-10-15T18:00:00.000Z",
    };
    return { options, pipeline: createStaffTableGuestPipeline(options as never) };
  };

  it("DEC-STAFF-DINE-IN-ROUND: a table without a current QR code is reported, nothing entered", async () => {
    const { options, pipeline } = setup();
    options.tableQrToken.mockResolvedValueOnce(null as never);
    expect(
      await pipeline.enter({ tableReference: id(30), requestedAt: "2026-10-15T18:00:00.000Z" }),
    ).toEqual({ status: "NoTableQr" });
    expect(options.entry.establish).not.toHaveBeenCalled();
  });

  it("enters with the table's printed QR and joins with the one-time table code", async () => {
    const { options, pipeline } = setup();
    const entered = await pipeline.enter({
      tableReference: id(30),
      requestedAt: "2026-10-15T18:00:00.000Z",
    });
    expect(options.tableQrToken).toHaveBeenCalledWith(id(30));
    expect(entered).toEqual({ status: "Established", credentials });
    expect(
      await pipeline.join(credentials, { joinCredential: "123456", operationReference: id(44) }),
    ).toEqual({ admissionReference: id(40) });
    expect(options.join.join).toHaveBeenCalledWith(
      { ...credentials, joinCredential: "123456", operationReference: id(44) },
      { abuse: "budget" },
    );
    const bound = await pipeline.bind(credentials, {
      operationReference: id(41),
      admissionReference: id(40),
    });
    expect(bound).toEqual({
      credentials: { sessionCredential: "c".repeat(43), csrfCredential: "d".repeat(43) },
      guestSessionReference: id(42),
    });
  });

  it("refuses a pickup QR answer and reads the table cart's unsent items", async () => {
    const { options, pipeline } = setup();
    options.entry.establish.mockResolvedValueOnce({
      status: "Established",
      channel: "Pickup",
      sessionCredential: credentials.sessionCredential,
      csrfCredential: credentials.csrfCredential,
    });
    await expect(
      pipeline.enter({ tableReference: id(30), requestedAt: "2026-10-15T18:00:00.000Z" }),
    ).rejects.toThrow("TABLE_GUEST_PIPELINE_UNAVAILABLE");
    expect(
      await pipeline.selectCart(credentials, {
        operationReference: id(45),
        requestedAt: "2026-10-15T18:00:00.000Z",
      }),
    ).toEqual({
      status: "Selected",
      cartReference: id(43),
      cartVersion: 9,
      pendingItems: [{ name: "Iced latte", quantity: 2 }],
    });
    options.cart.createCart.mockResolvedValueOnce({ status: "CheckoutInProgress" } as never);
    expect(
      await pipeline.selectCart(credentials, {
        operationReference: id(45),
        requestedAt: "2026-10-15T18:00:00.000Z",
      }),
    ).toEqual({ status: "CheckoutInProgress" });
  });

  it("WP-2423: takes a refused round's items back out of the table cart, one version at a time", async () => {
    const { options, pipeline } = setup();
    expect(pipeline.removeItems).toBeUndefined();
    const removeItem = vi.fn(async (input: { expectedCartVersion: number }) => ({
      status: "Applied",
      view: { cart: { version: input.expectedCartVersion + 1 } },
    }));
    const withRemoval = createStaffTableGuestPipeline({
      ...options,
      cart: { ...options.cart, removeItem },
    } as never);
    expect(
      await withRemoval.removeItems?.(credentials, {
        cartReference: id(43),
        cartVersion: 11,
        cartItemReferences: [id(50), id(51)],
      }),
    ).toBe("Removed");
    expect(removeItem.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ cartItemReference: id(50), expectedCartVersion: 11 }),
      expect.objectContaining({ cartItemReference: id(51), expectedCartVersion: 12 }),
    ]);
    // A guest changed the cart meanwhile: what is left stays as it is.
    removeItem.mockResolvedValueOnce({ status: "VersionConflict" } as never);
    expect(
      await withRemoval.removeItems?.(credentials, {
        cartReference: id(43),
        cartVersion: 11,
        cartItemReferences: [id(50)],
      }),
    ).toBe("Kept");
  });

  it("prepares the round's payment without a Provider, after the opening rule", async () => {
    const { options, pipeline } = setup();
    await pipeline.preparePayment(credentials, {
      checkoutSessionReference: id(46),
      selectionReference: id(47),
      tip: { amountMinor: 0n, currencyCode: "CAD" } as never,
      recordedAfterOutage: false,
    });
    expect(options.payment.prepare).toHaveBeenCalledWith({
      ...credentials,
      checkoutSessionReference: id(46),
      selectionReference: id(47),
      tip: { amountMinor: 0n, currencyCode: "CAD" },
    });
    options.takesOrder.mockResolvedValueOnce(false);
    await expect(
      pipeline.preparePayment(credentials, {
        checkoutSessionReference: id(46),
        selectionReference: id(47),
        tip: { amountMinor: 0n, currencyCode: "CAD" } as never,
        recordedAfterOutage: false,
      }),
    ).rejects.toMatchObject({ code: "STORE_CLOSED" });
  });
});
