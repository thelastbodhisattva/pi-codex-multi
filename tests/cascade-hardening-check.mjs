// Regression tests for the 2026-08 cascade-hardening sweep:
//   1. cascade continues past a failed member (bounded by maxRetries)
//   2. identical-prompt turns reset cascade state
//   3. transient overload does not exhaust accounts
//   4. Retry-After / quota reset honored for cooldowns
//   5. atomic-write helper survives a simulated crash mid-write
//   6. project config strips selectorScript
// Style: structural regex pins against production source + behavioral tests
// of real functions extracted from that source (plain node, no build step).
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");

function cut(startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.ok(start >= 0, `source marker not found: ${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.ok(end > start, `end marker not found after ${startMarker}: ${endMarker}`);
	return source.slice(start, end);
}

/** Extract a pure-JS closure from the TS source by stripping the handful of
 *  type annotations those functions carry. */
function evalBlock(code, returnNames) {
	const stripped = code
		.replaceAll("(errorMessage: string)", "(errorMessage)")
		.replaceAll("(ttlMs: number | undefined): number", "(ttlMs)")
		.replaceAll("(path: string, data: unknown, mode = 0o600)", "(path, data, mode = 0o600)")
		.replace(/\)\s*:\s*(boolean|void|number(\s*\|\s*undefined)?)\s*\{/g, ") {");
	return new Function(`${stripped}; return { ${returnNames.join(", ")} };`)();
}

// ---------------------------------------------------------------------------
// 1 + 6. Cascade continuation loop and maxRetries bound (structural pins)
// ---------------------------------------------------------------------------

const handleErrorBody = cut(
	"async handleError(",
	"\n\tgetPoolConfigs()",
);

assert.match(handleErrorBody, /for \(const nextCandidate of plan\.candidates\)/,
	"handleError must iterate all candidates, not just the first");
assert.match(handleErrorBody, /try \{\s*success = await this\.pi\.setModel\(nextModel\);/,
	"each candidate switch must be wrapped in try/catch");
assert.match(handleErrorBody, /attempts >= maxAttempts/,
	"the candidate loop must respect the maxRetries bound");
assert.match(handleErrorBody, /config\.maxRetries \?\? DEFAULT_MAX_RETRIES/,
	"maxRetries must default to DEFAULT_MAX_RETRIES when unset");
assert.match(handleErrorBody, /if \(!isTransientOverloadError\(errorMessage\)\)/,
	"only non-transient errors may mark accounts exhausted");
assert.doesNotMatch(handleErrorBody, /cascade exhausted; no later eligible target/,
	"a failed candidate must continue to the next one instead of declaring exhaustion");

assert.match(source, /const DEFAULT_MAX_RETRIES = 99;/);
assert.match(source, /maxRetries:\s*\n?\s*typeof parsed\.maxRetries === "number"/,
	"normalizeMultiPassConfig must normalize maxRetries");

// ---------------------------------------------------------------------------
// 2. Identical-prompt turns reset cascade state (structural pins)
// ---------------------------------------------------------------------------

assert.doesNotMatch(source, /this\.cascadeState\.prompt/,
	"cascade state identity must not key off prompt-string equality");
const startTurnBody = cut("\tstartTurn(", "\n\tclearCascadeState()");
assert.match(startTurnBody, /suppressNextStartTurn/,
	"startTurn must keep skipping its own followUp retry turn");
assert.match(startTurnBody, /this\.cascadeState = currentModel/,
	"startTurn must reset cascade state per turn");

// ---------------------------------------------------------------------------
// 3. Transient overload does not exhaust accounts (behavioral, real patterns)
// ---------------------------------------------------------------------------

const classification = evalBlock(
	cut("const PER_ACCOUNT_LIMIT_PATTERNS", "// Retry-aware cooldown math"),
	["isRateLimitError", "isTransientOverloadError"],
);

assert.equal(classification.isTransientOverloadError("model is overloaded, try again"), true);
assert.equal(classification.isTransientOverloadError("provider at capacity"), true);
assert.equal(classification.isTransientOverloadError("HTTP 503 while contacting upstream"), true);
assert.equal(classification.isTransientOverloadError("usage limit reached for your account"), false);
assert.equal(classification.isTransientOverloadError("rate limit exceeded due to capacity"), false,
	"per-account wording wins over overload wording");
assert.equal(classification.isRateLimitError("quota exhausted"), true);
assert.equal(classification.isRateLimitError("error 429: too many requests"), true,
	"429 anchored at word boundaries still matches");
assert.equal(classification.isRateLimitError("request id 14290 logged"), false,
	"429 inside a larger token must not match");
assert.equal(classification.isRateLimitError("all good here"), false);

// ---------------------------------------------------------------------------
// 4. Retry-After honored and cooldown clamped (behavioral, real math)
// ---------------------------------------------------------------------------

const cooldown = evalBlock(
	cut("const MIN_EXHAUSTED_MS", "// Schedule evaluation helpers"),
	["parseRetryAfterSeconds", "clampExhaustedMs"],
);

assert.equal(cooldown.parseRetryAfterSeconds("Please retry-after: 120 seconds"), 120);
assert.equal(cooldown.parseRetryAfterSeconds("Retry After 30s"), 30);
assert.equal(cooldown.parseRetryAfterSeconds("no hint here"), undefined);

assert.equal(cooldown.clampExhaustedMs(undefined), 5 * 60 * 1000, "fallback is 5 minutes");
assert.equal(cooldown.clampExhaustedMs(500), 60 * 1000, "floor is 60 seconds");
assert.equal(cooldown.clampExhaustedMs(120 * 1000), 120 * 1000);
assert.equal(cooldown.clampExhaustedMs(99 * 60 * 1000), 30 * 60 * 1000, "cap is 30 minutes");

assert.match(cut("private resolveExhaustedMs", "\t/** Best-effort persistence"),
	/getCachedQuotaResetAt\(providerName\)/,
	"cooldown derivation must consult the cached quota reset timestamp");

// ---------------------------------------------------------------------------
// 5. Atomic write helper survives simulated crash mid-write (real helper)
// ---------------------------------------------------------------------------

const fs = await import("node:fs");
const nodePath = await import("node:path");

function makeWriteJsonAtomic(renamer) {
	return new Function(
		"fsMod", "pathMod", "renamer",
		`const { existsSync, mkdirSync, writeFileSync, unlinkSync } = fsMod;
		 const { dirname, basename, join } = pathMod;
		 const renameSync = renamer;
		 ${cut("function writeJsonAtomic", "interface PersistedPoolState")
			.replace("(path: string, data: unknown, mode = 0o600)", "(path, data, mode = 0o600)")
			.replace("): void {", ") {")}
		 return writeJsonAtomic;`
	)(fs, nodePath, renamer);
}

const dir = mkdtempSync(path.join(tmpdir(), "multipass-atomic-"));
const target = path.join(dir, "state.json");

// Happy path.
makeWriteJsonAtomic(fs.renameSync)(target, { ok: true });
assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });

// Simulated crash mid-write: rename fails, target stays intact, no tmp left.
let crashOnce = true;
const crashyRenamer = (from, to) => {
	if (crashOnce) {
		crashOnce = false;
		throw new Error("simulated crash mid-rename");
	}
	return fs.renameSync(from, to);
};

assert.throws(() => makeWriteJsonAtomic(crashyRenamer)(target, { attempt: 2 }),
	/simulated crash/, "a failed rename must propagate");
assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true },
	"the previous good state must survive a crash mid-write");
assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0,
	"the helper must clean up its temp file on failure");

// A leftover .tmp from an external crash is ignored by readers: only the
// exact state path is ever read back (loadPersistedState contract).
fs.writeFileSync(path.join(dir, ".state.json.999999.1.tmp"), "{ truncated garbage");
assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });
assert.match(cut("\tloadPersistedState(): void {", "\tgetNextMember("),
	/multiPassStatePath\(\)/, "state loading reads only the canonical state path");

// ---------------------------------------------------------------------------
// 6. Project config strips selectorScript (structural pins)
// ---------------------------------------------------------------------------

const normalizeProjectConfigBody = cut("function normalizeProjectConfig", "\nfunction loadGlobalConfig");
assert.match(normalizeProjectConfigBody, /delete stripped\.selectorScript;/,
	"project config pools must have selectorScript stripped");
assert.match(normalizeProjectConfigBody, /normalizePools\(parsed\.pools\)/);

// Global config keeps honoring selectorScript (only project config strips it).
const normalizePoolsBody = cut("function normalizePools", "\nfunction normalizeMultiPassConfig");
assert.match(normalizePoolsBody, /\.\.\.pool,/,
	"global pool normalization preserves selectorScript");

// Persistence plumbing pins (item 7).
assert.match(source, /multi-pass\.state\.json/);
assert.match(source, /poolManager\.loadPersistedState\(\)/,
	"session_start must load persisted exhaustion state");
assert.match(source, /saveExhaustedState\(pools\)/);

console.log("cascade hardening checks passed");
