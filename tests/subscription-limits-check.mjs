import assert from "node:assert/strict";

const CODEX_MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;
const CODEX_DAY_SECONDS = 24 * 60 * 60;

function normalizeCodexUsageWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
  const resetAt = typeof window.reset_at === "number" && window.reset_at > 0
    ? window.reset_at
    : typeof window.reset_after_seconds === "number" && window.reset_after_seconds >= 0
      ? Math.floor(Date.now() / 1000) + window.reset_after_seconds
      : undefined;
  return {
    usedPercent: typeof window.used_percent === "number" ? window.used_percent : 0,
    windowSeconds: typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : 0,
    resetAt,
  };
}

function matchesUsageWindow(window, expectedSeconds) {
  if (!window) return false;
  return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function parseCodexUsageSnapshot(data) {
  const rateLimit = data?.rate_limit || {};
  const windows = [
    normalizeCodexUsageWindow(rateLimit.primary_window),
    normalizeCodexUsageWindow(rateLimit.secondary_window),
  ].filter(Boolean);
  return {
    planType: typeof data?.plan_type === "string" ? data.plan_type : "unknown",
    email: typeof data?.email === "string" ? data.email : "",
    fiveHour: windows.find((window) => matchesUsageWindow(window, 5 * 60 * 60)),
    weekly: windows.find((window) => matchesUsageWindow(window, 7 * 24 * 60 * 60)),
    monthly: windows.find((window) => window.windowSeconds >= CODEX_MONTHLY_WINDOW_MIN_SECONDS),
  };
}

function getCodexWindowRemaining(window) {
  if (!window) return undefined;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function formatResetShort(resetAt) {
  if (!resetAt) return "--";
  const diffMs = resetAt * 1000 - Date.now();
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.round(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `~${days}d`;
  if (hours > 0) return `~${hours}h`;
  return `~${minutes}m`;
}

function formatCodexWindowLabel(window, fallback) {
  if (!window || window.windowSeconds < CODEX_MONTHLY_WINDOW_MIN_SECONDS) return fallback;
  return `${Math.round(window.windowSeconds / CODEX_DAY_SECONDS)}d`;
}

function formatQuotaWindowSummary(label, window) {
  if (!window) return undefined;
  return `${label} ${Math.round(getCodexWindowRemaining(window))}% (${formatResetShort(window.resetAt)})`;
}

function classifyCodexQuotaKind(snapshot) {
  const values = [
    getCodexWindowRemaining(snapshot.fiveHour),
    getCodexWindowRemaining(snapshot.weekly),
    getCodexWindowRemaining(snapshot.monthly),
  ].filter((value) => value !== undefined);
  if (values.length === 0) return { kind: "error", score: 0 };
  const bottleneck = Math.min(...values);
  if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

function subDisplayName(entry) {
  const providerNames = {
    "openai-codex": "ChatGPT Plus/Pro (Codex)",
  };
  const providerName = `${providerNames[entry.provider] || entry.provider} #${entry.index}`;
  if (!entry.label) return providerName;
  return `${entry.label} — ${providerName}`;
}

function runWindowClassificationChecks() {
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const snapshot = parseCodexUsageSnapshot({
    plan_type: "pro",
    email: "test@example.com",
    rate_limit: {
      // Intentionally reversed from the human-friendly order.
      primary_window: {
        used_percent: 35,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt + 6 * 24 * 60 * 60,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: resetAt,
      },
    },
  });

  assert.equal(snapshot.planType, "pro");
  assert.equal(snapshot.email, "test@example.com");
  assert.equal(snapshot.fiveHour.windowSeconds, 5 * 60 * 60);
  assert.equal(snapshot.weekly.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(getCodexWindowRemaining(snapshot.fiveHour), 90);
  assert.equal(getCodexWindowRemaining(snapshot.weekly), 65);
}

function runFreeMonthlyWindowChecks() {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = parseCodexUsageSnapshot({
    plan_type: "free",
    rate_limit: {
      primary_window: {
        used_percent: 37,
        limit_window_seconds: 30 * 24 * 60 * 60,
        reset_at: 0,
        reset_after_seconds: 3600,
      },
    },
  });

  assert.equal(snapshot.planType, "free");
  assert.equal(snapshot.monthly.windowSeconds, 30 * 24 * 60 * 60);
  assert.equal(getCodexWindowRemaining(snapshot.monthly), 63);
  assert.ok(snapshot.monthly.resetAt >= now + 3599);
  assert.equal(formatCodexWindowLabel(snapshot.monthly, "30d"), "30d");
  assert.match(formatQuotaWindowSummary("30d", snapshot.monthly), /^30d 63% \(~1h\)$/);
  assert.equal(classifyCodexQuotaKind(snapshot).kind, "ready");
  assert.equal(
    classifyCodexQuotaKind({ monthly: { usedPercent: 95 } }).kind,
    "blocked",
  );
}

function runSeverityChecks() {
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 40 } }).kind,
    "ready",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 75 }, weekly: { usedPercent: 20 } }).kind,
    "watch",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 88 }, weekly: { usedPercent: 15 } }).kind,
    "low",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 97 }, weekly: { usedPercent: 10 } }).kind,
    "blocked",
  );
  assert.equal(classifyCodexQuotaKind({}).kind, "error");
}

function runDisplayNameChecks() {
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 2 }),
    "ChatGPT Plus/Pro (Codex) #2",
  );
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 3, label: "Outlook" }),
    "Outlook — ChatGPT Plus/Pro (Codex) #3",
  );
}

runWindowClassificationChecks();
runFreeMonthlyWindowChecks();
runSeverityChecks();
runDisplayNameChecks();
console.log("subscription limit checks passed");
