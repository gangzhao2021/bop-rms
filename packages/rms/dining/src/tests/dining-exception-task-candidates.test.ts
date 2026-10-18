import { expect, it, vi } from "vitest";
import { createPostgresDiningExceptionTaskCandidates } from "../index.js";
const id = (n: number) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0");
function setup(values: unknown[] = [id(10), id(11)]) {
  const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM rms_dining")
        ? values.map((task_reference) => ({ task_reference }))
        : [],
    })),
    tx = { query },
    authorize = vi.fn(async () => true),
    scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  return {
    tx,
    query,
    authorize,
    read: createPostgresDiningExceptionTaskCandidates({ scope, authorize }),
  };
}
it("discovers scoped references only with bounded lookahead and retained authorization", async () => {
  const f = setup();
  expect(await f.read(f.tx, { afterTaskReference: id(9), limit: 1 })).toEqual({
    items: [id(10)],
    nextAfterTaskReference: id(10),
  });
  expect(f.query).toHaveBeenLastCalledWith(
    expect.stringContaining("tenant_id=$1 AND brand_id=$2 AND store_id=$3"),
    [id(1), id(2), id(3), id(9), 2],
  );
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenLastCalledWith(f.tx, {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    purpose: "ProjectOrderException",
  });
});
it("ends empty/exact pages and refuses invalid pagination", async () => {
  for (const values of [[], [id(10)]]) {
    const f = setup(values);
    expect(
      (await f.read(f.tx, { afterTaskReference: null, limit: 1 })).nextAfterTaskReference,
    ).toBeNull();
  }
  for (const limit of [0, 101, 1.5]) {
    const f = setup();
    await expect(f.read(f.tx, { afterTaskReference: null, limit })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  }
});
it("rejects duplicate, reversed, stale cursor and malformed owner results", async () => {
  for (const values of [
    [id(10), id(10)],
    [id(11), id(10)],
    [id(9)],
    ["bad"],
    [id(10), id(11), id(12)],
  ]) {
    const f = setup(values);
    await expect(f.read(f.tx, { afterTaskReference: id(9), limit: 1 })).rejects.toThrow();
  }
});
it("refuses initial denial, revocation and bounded dependency failure", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.read(f.tx, { afterTaskReference: null, limit: 1 })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.tx, { afterTaskReference: null, limit: 1 })).rejects.toThrow();
  f.authorize.mockResolvedValue(true);
  f.query.mockRejectedValue(Error("private database detail"));
  await expect(f.read(f.tx, { afterTaskReference: null, limit: 1 })).rejects.not.toThrow(
    "private database detail",
  );
});
