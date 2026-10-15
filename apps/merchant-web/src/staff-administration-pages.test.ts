import { describe, expect, it, vi } from "vitest";
import { createStaffPageClient } from "./staff-administration-pages.js";

describe("WP-2423 staff command refusals", () => {
  it("tells a PIN sign-in refusal apart from a missing permission", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "full_sign_in_required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "LastOwner" }, { status: 409 }));
    const client = createStaffPageClient("c".repeat(43), fetcher);
    const request = {
      operation: "Approve",
      changeReference: "01909974-0000-7000-8000-000000000001",
    } as const;
    await expect(client.command(request)).rejects.toMatchObject({ code: "FullSignInRequired" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "PermissionDenied" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "LastOwner" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/organization/staff/command");
  });
});
