import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrationConnectionConfig } from "./config.ts";
import { MigrationOperationalError } from "./diagnostics.ts";

const roots: string[] = [];

async function fixture(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(path.join("/tmp", "bop-rms-wp0020-config-"));
  roots.push(root);
  const local = path.join(root, ".local");
  await mkdir(local);
  const password = path.join(local, "password");
  await writeFile(password, "synthetic-wp0020-password", { mode: 0o600 });
  const values: Record<string, string> = {
    BOP_RMS_COMPOSE_PROJECT: "bop-rms-wp0020-test",
    BOP_RMS_ENVIRONMENT: "test",
    BOP_RMS_POSTGRES_HOST: "127.0.0.1",
    BOP_RMS_POSTGRES_PASSWORD_FILE: ".local/password",
    BOP_RMS_POSTGRES_PORT: "55434",
    BOP_RMS_POSTGRES_DB: "bop_rms_wp0020_test",
    BOP_RMS_POSTGRES_USER: "bop_rms_wp0020_test",
    BOP_RMS_POSTGRES_SSL_MODE: "disable",
    BOP_RMS_API_PORT: "53011",
    BOP_RMS_MERCHANT_WEB_PORT: "53012",
    BOP_RMS_CUSTOMER_PWA_PORT: "53013",
    ...overrides,
  };
  const envFile = path.join(root, "test.env");
  await writeFile(
    envFile,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  return { envFile, password, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("migration connection configuration", () => {
  it("loads an explicit local/test target without exposing the secret path", async () => {
    const item = await fixture();
    const config = await loadMigrationConnectionConfig(item.root, item.envFile, {});
    expect(config).toMatchObject({
      database: "bop_rms_wp0020_test",
      environment: "test",
      host: "127.0.0.1",
      port: 55434,
      ssl: false,
      user: "bop_rms_wp0020_test",
    });
    expect(config.password).toBe("synthetic-wp0020-password");
  });

  it("rejects ambient DSN and password authorities", async () => {
    const item = await fixture();
    await expect(
      loadMigrationConnectionConfig(item.root, item.envFile, {
        DATABASE_URL: "postgres://forbidden",
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_CONFIG_UNSAFE" });
    await expect(
      loadMigrationConnectionConfig(item.root, item.envFile, { PGPASSWORD: "forbidden" }),
    ).rejects.toBeInstanceOf(MigrationOperationalError);
  });

  it("rejects an unsafe password mode", async () => {
    const item = await fixture();
    await chmod(item.password, 0o644);
    await expect(loadMigrationConnectionConfig(item.root, item.envFile, {})).rejects.toMatchObject({
      code: "MIGRATION_CONFIG_UNSAFE",
    });
  });

  it("rejects a password symlink", async () => {
    const item = await fixture({ BOP_RMS_POSTGRES_PASSWORD_FILE: ".local/password-link" });
    await symlink(item.password, path.join(item.root, ".local", "password-link"));
    await expect(loadMigrationConnectionConfig(item.root, item.envFile, {})).rejects.toMatchObject({
      code: "MIGRATION_CONFIG_UNSAFE",
    });
  });

  it("rejects a symbolic .local secret boundary", async () => {
    const item = await fixture();
    const local = path.join(item.root, ".local");
    const realLocal = path.join(item.root, "real-local");
    await rename(local, realLocal);
    await symlink(realLocal, local);
    await expect(loadMigrationConnectionConfig(item.root, item.envFile, {})).rejects.toMatchObject({
      code: "MIGRATION_CONFIG_UNSAFE",
    });
  });

  it("rejects an environment symlink or a file outside the repository", async () => {
    const item = await fixture();
    const linkedEnvironment = path.join(item.root, "linked.env");
    await symlink(item.envFile, linkedEnvironment);
    await expect(
      loadMigrationConnectionConfig(item.root, linkedEnvironment, {}),
    ).rejects.toMatchObject({ code: "MIGRATION_CONFIG_UNSAFE" });

    const outside = await fixture();
    await expect(
      loadMigrationConnectionConfig(item.root, outside.envFile, {}),
    ).rejects.toMatchObject({ code: "MIGRATION_CONFIG_UNSAFE" });
  });

  it("rejects non-loopback connections without verify-full", async () => {
    const item = await fixture({ BOP_RMS_POSTGRES_HOST: "db.example.test" });
    await expect(loadMigrationConnectionConfig(item.root, item.envFile, {})).rejects.toMatchObject({
      code: "MIGRATION_CONFIG_UNSAFE",
    });
  });

  it("requires a protected CA reference for verify-full", async () => {
    const missing = await fixture({ BOP_RMS_POSTGRES_SSL_MODE: "verify-full" });
    await expect(
      loadMigrationConnectionConfig(missing.root, missing.envFile, {}),
    ).rejects.toMatchObject({ code: "MIGRATION_CONFIG_UNSAFE" });

    const valid = await fixture({
      BOP_RMS_POSTGRES_HOST: "db.example.test",
      BOP_RMS_POSTGRES_SSL_CA_FILE: ".local/ca.pem",
      BOP_RMS_POSTGRES_SSL_MODE: "verify-full",
    });
    await writeFile(path.join(valid.root, ".local", "ca.pem"), "synthetic-ca-material");
    expect((await loadMigrationConnectionConfig(valid.root, valid.envFile, {})).ssl).toEqual({
      ca: "synthetic-ca-material",
      rejectUnauthorized: true,
    });
  });

  it("rejects unsupported BOP-RMS variables deterministically", async () => {
    const item = await fixture({ BOP_RMS_SECRET_VALUE: "forbidden" });
    await expect(loadMigrationConnectionConfig(item.root, item.envFile, {})).rejects.toMatchObject({
      code: "MIGRATION_CONFIG_UNSAFE",
    });
  });
});
