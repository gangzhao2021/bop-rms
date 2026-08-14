import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/cloud-operations-evidence-baseline.json";

describe("WP-2065 cloud operations evidence baseline", () => {
  it("pins the accepted CloudWatch, ADOT and X-Ray telemetry path", async () => {
    const { telemetry } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(telemetry).toEqual({
      structuredLogs: "cloudwatch-logs",
      metrics: "cloudwatch-metrics",
      traces: "x-ray",
      collector: "adot",
      failureIsolatedFromBusinessOutcome: true,
      highCardinalityBusinessLabels: false,
    });
  });

  it("requires encrypted least-privilege alert routing without Customer payload", async () => {
    const { alertTransport } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(alertTransport.path).toBe("cloudwatch-alarm-or-eventbridge-to-encrypted-sns");
    expect(alertTransport.leastPrivilegePublish).toBe(true);
    expect(alertTransport.verifiedEmailSubscriptions).toBe(true);
    expect(alertTransport.customerPayload).toBe(false);
    expect(alertTransport.unknownOrDeliveryFailure).toBe("fail-closed");
  });

  it("keeps cost and quota alarms notify-only", async () => {
    const { costAndQuota } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(costAndQuota.controls).toEqual([
      "aws-budgets",
      "cost-anomaly-detection",
      "service-quota-alarms",
    ]);
    expect(costAndQuota.requiredTags).toEqual(["resource-owner", "environment", "data-class"]);
    expect(costAndQuota.alarmAction).toBe("notify-only");
    expect(costAndQuota.mayDeleteProductionData).toBe(false);
    expect(costAndQuota.mayStopTransactionService).toBe(false);
  });

  it("pins bounded capacity signals and protects the database pool", async () => {
    const { capacity } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(capacity.signals).toEqual(["cpu", "memory", "request-load", "queue-lag"]);
    expect(capacity.autoscalingMinimumAndMaximumRequired).toBe(true);
    expect(capacity.databaseConnectionBudgetPercentMaximum).toBe(70);
    expect(capacity.deploymentMayExhaustDatabasePool).toBe(false);
  });

  it("requires a real-contact staging acknowledgement drill as external evidence", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.acknowledgementDrill).toEqual({
      stagingFaultInjection: true,
      primaryAndBackupDelivery: true,
      humanAcknowledgement: true,
      escalationAndRecoveryRecorded: true,
      realContactEvidenceRequired: true,
    });
    expect(policy.externalEvidenceRequired).toBe(true);
  });

  it("contains no contact, topic, account, credential, payload or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(
      /https?:\/\/|\b\d{12}\b|arn:aws|@example|accessKeyId|secretAccessKey/iu,
    );
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
  });
});
