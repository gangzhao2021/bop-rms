import process from "node:process";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { isAbsolute, join } from "node:path";

const unavailable = () => new Error("PRIVATE_INSTALLATION_UNAVAILABLE");
const maximumBytes = 64 * 1024;
export function parsePrivateInstallationFilename(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(value)) throw unavailable();
  return value;
}
const sameFile = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const privateFile = (state) => {
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.uid !== process.getuid() ||
    (state.mode & 0o7777) !== 0o600 ||
    state.size < 1 ||
    state.size > maximumBytes
  )
    throw unavailable();
};
/** Existing local owner-only installation boundary. No credentials are created,
 * permissions changed or unbounded paths/files exposed. Every read revalidates
 * directory identity and the same regular file before/after reading. */
export async function createPrivateInstallationReader(directory) {
  try {
    if (
      typeof directory !== "string" ||
      !isAbsolute(directory) ||
      (await realpath(directory)) !== directory
    )
      throw unavailable();
    const initial = await lstat(directory);
    const checkDirectory = async () => {
      const state = await lstat(directory);
      if (
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        state.uid !== process.getuid() ||
        (state.mode & 0o7777) !== 0o700 ||
        state.dev !== initial.dev ||
        state.ino !== initial.ino ||
        (await realpath(directory)) !== directory
      )
        throw unavailable();
    };
    await checkDirectory();
    return Object.freeze({
      async read(name) {
        try {
          await checkDirectory();
          const path = join(directory, parsePrivateInstallationFilename(name));
          const before = await lstat(path);
          privateFile(before);
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const bytes = Buffer.alloc(maximumBytes + 1);
          try {
            const state = await handle.stat();
            privateFile(state);
            if (!sameFile(before, state)) throw unavailable();
            let size = 0;
            while (size < bytes.length) {
              const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
              if (bytesRead === 0) break;
              size += bytesRead;
            }
            const after = await handle.stat(),
              current = await lstat(path);
            privateFile(after);
            privateFile(current);
            if (
              size > maximumBytes ||
              size !== state.size ||
              !sameFile(state, after) ||
              !sameFile(after, current)
            )
              throw unavailable();
            await checkDirectory();
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
          } finally {
            bytes.fill(0);
            await handle.close();
          }
        } catch {
          throw unavailable();
        }
      },
    });
  } catch {
    throw unavailable();
  }
}
