import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { TextDecoder } from "node:util";

const maximumFileBytes = 65_536;
export function configuredPrivateApprovalPath(value: unknown, unavailable: () => never): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value
  )
    return unavailable();
  return value;
}

/** Deployment configuration only: never accept either path from an HTTP request.
 * POSIX ownership is deliberate; the supported Windows environment is WSL2.
 * Every observation reopens the configured file, so replacement/withdrawal is
 * visible to the owning approval source rather than hidden by a process cache.
 */
export async function readPrivateApprovalJson(
  path: string,
  unavailable: () => never,
): Promise<unknown> {
  if (typeof process.getuid !== "function") return unavailable();
  const uid = process.getuid();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o077n) !== 0n ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumFileBytes)
    )
      return unavailable();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      total !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.uid !== before.uid ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      return unavailable();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)));
  } catch {
    return unavailable();
  } finally {
    // A close failure also refuses the observation; no raw filesystem error escapes.
    if (handle) await handle.close().catch(unavailable);
  }
}
