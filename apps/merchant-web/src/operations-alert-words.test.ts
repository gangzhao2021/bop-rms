import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { alertTitle } from "./OperationsAlerts.js";
import { alertAction, alertSummary } from "./operations-alert-words.js";

interface Catalog {
  readonly renderAlert: (
    key: string,
    params: unknown,
  ) => { title: string; summary: string; action: string };
  readonly ALERT_KEYS: readonly string[];
}
// The monitor's own catalog (plain JavaScript without types): this test fails when its wording
// moves away from the Chinese held here.
const catalogFile = new URL("../../../tooling/environment/pilot-alerts.mjs", import.meta.url).href;
const { renderAlert, ALERT_KEYS } = (await import(/* @vite-ignore */ catalogFile)) as Catalog;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Every wording each alert can take. */
const VARIANTS: Readonly<Record<string, readonly unknown[]>> = {
  "entry.api": [{ downMs: 3 * MIN }],
  "entry.customer": [{ downMs: 1 * MIN }],
  "entry.merchant": [{ downMs: 2 * 60 * MIN }],
  "supervisor.silent": [{ reportAgeMs: null }, { reportAgeMs: 30_000 }],
  "service.attention": [
    { services: ["api"] },
    { services: ["business-worker:events"] },
    { services: ["business-worker:tableOnlineRefund", "customer", "unknown"] },
    {
      services: [
        "api",
        "kitchen-queue-worker",
        "reconciliation-worker:reconciliation",
        "daily-settlement-worker:dailySettlement",
      ],
    },
  ],
  "payment.updates": [
    { count: 1, oldestAgeMs: 5 * MIN },
    { count: 3, oldestAgeMs: 70 * MIN },
  ],
  "updates.retrying": [
    { count: 1, oldestAgeMs: 5 * MIN },
    { count: 3, oldestAgeMs: 5 * MIN },
  ],
  "orders.held_stock": [
    { count: 1, oldestAgeMs: 3 * DAY },
    { count: 2, oldestAgeMs: 30 * 60 * MIN },
  ],
  "pickup.capacity_horizon": [{ coveredMs: 0 }, { coveredMs: 5 * 60 * MIN }],
  "receipts.template": [
    { reason: "StoreConfigurationUnavailable" },
    { reason: "TemplateNotProven" },
  ],
  "pricing.tax_configuration": [
    { reason: "StoreConfigurationUnavailable" },
    { reason: "TaxConfigurationMismatch" },
  ],
  "orders.workflow": [{ reason: "Orders" }, { reason: "Cancellation" }],
  "reconciliation.differences": [
    { count: 1, oldestAgeMs: 2 * 60 * MIN },
    { count: 3, oldestAgeMs: 5 * MIN },
  ],
  "settlement.exceptions": [
    { count: 1, oldestAgeMs: MIN },
    { count: 2, oldestAgeMs: MIN },
  ],
  "backup.failed": [
    { stage: "dump", attemptsLeft: 1 },
    { stage: "restore check", attemptsLeft: 2 },
    { stage: "off-site copy", attemptsLeft: 0 },
    { stage: "retention", attemptsLeft: 0 },
    { stage: "backup", attemptsLeft: 0 },
  ],
  "backup.stale": [{ ageMs: null }, { ageMs: 2 * DAY }],
  "backup.restore_check": [{}],
  "backup.offsite": [{}],
  "certificate.expiring": [{ remainingMs: -1 }, { remainingMs: 6 * DAY }],
  "installation.validity": [{ remainingMs: -1 }, { remainingMs: 13 * DAY }],
  "disk.low": [
    {
      disks: [
        { name: "runtime", freeBytes: 2 * 1024 ** 3, freePercent: 3 },
        { name: "backups", freeBytes: 5 * 1024 ** 2, freePercent: 1 },
        { name: "database", freeBytes: 3 * 1024 ** 3, freePercent: 4 },
        { name: "offsite", freeBytes: 3 * 1024 ** 3, freePercent: 4 },
      ],
    },
  ],
  "monitor.source": [
    {
      sources: [
        "the service status",
        "payment and settlement status",
        "the backup status",
        "the certificate",
        "the store setup end date",
        "disk space",
        "the receipt template check",
        "the check for orders holding stock",
        "the check for pickup times",
        "the check that orders can be priced",
        "the check of the store's order rules",
      ],
    },
  ],
  "channel.delivery": [
    { channels: ["email"], failingMs: 40 * MIN },
    { channels: ["email", "webhook"], failingMs: 40 * MIN },
  ],
};
const every = () =>
  Object.entries(VARIANTS).flatMap(([key, list]) =>
    list.map((params) => ({ key, ...renderAlert(key, params) })),
  );
/** Latin words left in a Chinese sentence, other than the brand and the size units. */
const english = (text: string) =>
  (text.match(/[A-Za-z]{2,}/gu) ?? []).filter((word) => !["BOP", "GB", "MB"].includes(word));

afterEach(() => setLanguageForTest("en"));

describe("Owner 2026-11-03: system alerts in the store's language", () => {
  it("covers every alert of the monitor's catalog", () => {
    expect(Object.keys(VARIANTS).sort()).toEqual([...ALERT_KEYS].sort());
  });
  it("writes every title, action and summary wording in Chinese, in plain words", () => {
    setLanguageForTest("zh-Hans");
    for (const alert of every()) {
      for (const shown of [
        alertTitle(alert.title),
        alertAction(alert.action),
        alertSummary(alert.summary),
      ]) {
        expect(english(shown), `${alert.key}: ${shown}`).toEqual([]);
        expect(shown).not.toMatch(/试点|运维|容器|\{[a-zA-Z]+\}/u);
      }
    }
  });
  it("carries the values into the Chinese", () => {
    setLanguageForTest("zh-Hans");
    const say = (key: string, params: unknown) => alertSummary(renderAlert(key, params).summary);
    expect(say("entry.api", { downMs: 3 * MIN })).toContain("3分钟");
    expect(say("entry.api", { downMs: 30_000 })).toContain("不到一分钟");
    expect(say("entry.api", { downMs: 3 * 60 * MIN })).toContain("3小时");
    expect(say("certificate.expiring", { remainingMs: 6 * DAY })).toContain("还有6天到期");
    expect(say("payment.updates", { count: 3, oldestAgeMs: 5 * MIN })).toMatch(/3 条更新.*5分钟/u);
    expect(say("updates.retrying", { count: 1, oldestAgeMs: 5 * MIN })).toContain("1 条");
    expect(say("backup.failed", { stage: "dump", attemptsLeft: 2 })).toMatch(/导出数据.*2 次/u);
    expect(say("service.attention", { services: ["business-worker:events", "customer"] })).toBe(
      "订单处理（订单更新）、客人点单页和员工页面一直出错，不会自行恢复。",
    );
    expect(
      say("disk.low", { disks: [{ name: "backups", freeBytes: 2 * 1024 ** 3, freePercent: 3 }] }),
    ).toBe("备份文件夹还剩 2.0 GB（3%）。空间用完后，订单和备份都会停止。");
    expect(say("channel.delivery", { channels: ["email", "webhook"], failingMs: 40 * MIN })).toBe(
      "邮件、电话或消息提醒已失败40分钟。店主可能收不到问题通知。",
    );
  });
  it("keeps the operating steps in the Chinese", () => {
    setLanguageForTest("zh-Hans");
    const action = (key: string, params: unknown = {}) =>
      alertAction(renderAlert(key, params).action);
    expect(action("payment.updates", { count: 1, oldestAgeMs: 1 })).toContain("不要再收一次");
    expect(action("entry.api")).toContain("纸质点单");
    expect(action("pickup.capacity_horizon", { coveredMs: 0 })).toContain("刷卡机");
    expect(action("pickup.capacity_horizon", { coveredMs: 5 })).toContain("客人暂时不受影响");
    expect(action("orders.held_stock", { count: 1, oldestAgeMs: 1 })).toContain("释放占用的配料");
    expect(action("backup.restore_check")).toContain("保留之前的备份");
    expect(action("orders.workflow", { reason: "Orders" })).toContain("刷卡机");
    expect(action("orders.workflow", { reason: "Cancellation" })).toContain("客人暂时不受影响");
  });
  it("shows the monitor's own words when a text matches nothing, never blank", () => {
    setLanguageForTest("zh-Hans");
    expect(alertAction("Some newer instruction.")).toBe("Some newer instruction.");
    expect(alertSummary("Some newer background.")).toBe("Some newer background.");
    expect(alertTitle("Some newer problem")).toBe("Some newer problem");
    // A known sentence with an unknown value keeps the sentence and the value as sent.
    expect(
      alertSummary(
        "It expires in soon. After that, guests cannot order and staff cannot use the store screens.",
      ),
    ).toContain("soon");
  });
  it("shows English word for word while English is chosen", () => {
    for (const alert of every()) {
      expect(alertTitle(alert.title)).toBe(alert.title);
      expect(alertAction(alert.action)).toBe(alert.action);
      expect(alertSummary(alert.summary)).toBe(alert.summary);
    }
  });
});
