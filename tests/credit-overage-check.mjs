import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A ChatGPT account whose plan window is spent keeps serving Codex requests
// off purchased credits; only /wham/usage's plan meter reports 100%. The
// quota classifier must therefore not report such an account as "blocked"
// (which priority routing persists until the weekly reset).
const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");

assert.match(source, /creditOverage: boolean;/, "snapshot must carry creditOverage");
assert.match(source, /const credits = getRecord\(raw\?\.credits\);/);
assert.match(source, /const spendControl = getRecord\(raw\?\.spend_control\);/);
assert.match(source, /const planLimitReached = rateLimit\?\.limit_reached === true;/);
assert.match(
	source,
	/credits\?\.has_credits === true \|\| credits\?\.unlimited === true/,
	"has_credits or unlimited must count as credit funding",
);
assert.match(source, /const creditOverage = planLimitReached\s*&&\s*hasCredits/, "only explicit plan exhaustion can use the credit override");
assert.match(source, /credits\?\.overage_limit_reached !== true/, "overage cap must disable the override");
assert.match(source, /spendControl\?\.reached !== true/, "spend control must disable the override");
assert.match(
	source,
	/if \(bottleneck <= 5 && snapshot\.creditOverage\) return \{ kind: "watch", score: bottleneck \};\n\tif \(bottleneck <= 5\) return \{ kind: "blocked", score: bottleneck \};/,
	"credit-funded spent windows classify as watch, uncovered ones stay blocked",
);

// Behavioural check: evaluate the parser + classifier in isolation.
function extractFunction(name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} not found`);
	let depth = 0;
	let i = name === "classifyCodexQuotaKind"
		? source.indexOf("} {", start) + 2
		: source.indexOf("{", start);
	for (; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return source.slice(start, i + 1).replace(/: [A-Za-z<>|\[\]{}; ,?]+(?=[=),{])/g, "");
}

const stripTypes = (code) =>
	code
		// Strip both simple return types and the classifier's object return type.
		.replace(/\)\s*:\s*\{\s*kind:\s*QuotaStatusKind;\s*score:\s*number;\s*\}\s*\{/g, ") {")
		.replace(/\): [^{=]+\{/g, ") {")
		.replace(/\(window\): window is CodexUsageWindow => /g, "(window) => ")
		.replace(/\(value\): value is number => /g, "(value) => ")
		.replace(/ as Record<string, unknown>/g, "")
		.replace(/: unknown/g, "")
		.replace(/: Record<string, unknown> \| undefined/g, "")
		.replace(/: CodexUsageWindow \| undefined/g, "")
		.replace(/: CodexUsageSnapshot/g, "")
		.replace(/: number/g, "")
		.replace(/: string/g, "")
		.replace(/: boolean/g, "");

const helpers = ["getRecord", "normalizeCodexUsageWindow", "matchesUsageWindow", "parseCodexUsageSnapshot", "getCodexWindowRemaining", "classifyCodexQuotaKind"]
	.map((name) => stripTypes(extractFunction(name)))
	.join("\n");
const evalModule = new Function(`${helpers}\nreturn { parseCodexUsageSnapshot, classifyCodexQuotaKind };`)();

const weekSpent = {
	rate_limit: {
		allowed: false,
		limit_reached: true,
		primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2000000000 },
	},
};

const funded = evalModule.parseCodexUsageSnapshot({
	...weekSpent,
	credits: { has_credits: true, balance: "100.00", overage_limit_reached: false },
	spend_control: { reached: false },
});
assert.equal(funded.creditOverage, true);
assert.equal(evalModule.classifyCodexQuotaKind(funded).kind, "watch", "credit-funded account stays routable");

const drained = evalModule.parseCodexUsageSnapshot({ ...weekSpent, credits: { has_credits: false, balance: "0" } });
assert.equal(drained.creditOverage, false);
assert.equal(evalModule.classifyCodexQuotaKind(drained).kind, "blocked");

const capped = evalModule.parseCodexUsageSnapshot({
	...weekSpent,
	credits: { has_credits: true, balance: "12", overage_limit_reached: true },
});
assert.equal(evalModule.classifyCodexQuotaKind(capped).kind, "blocked", "overage cap keeps the account blocked");

const spendStopped = evalModule.parseCodexUsageSnapshot({
	...weekSpent,
	credits: { has_credits: true, balance: "12" },
	spend_control: { reached: true },
});
assert.equal(evalModule.classifyCodexQuotaKind(spendStopped).kind, "blocked", "spend control keeps the account blocked");

const noCreditsField = evalModule.parseCodexUsageSnapshot(weekSpent);
assert.equal(evalModule.classifyCodexQuotaKind(noCreditsField).kind, "blocked");

const nonPlanDenial = evalModule.parseCodexUsageSnapshot({
	rate_limit: {
		allowed: false,
		limit_reached: false,
		primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2000000000 },
	},
	credits: { has_credits: true, balance: "100.00" },
});
assert.equal(nonPlanDenial.creditOverage, false, "credits must not override a non-plan denial");
assert.equal(evalModule.classifyCodexQuotaKind(nonPlanDenial).kind, "blocked");

const unlimited = evalModule.parseCodexUsageSnapshot({
	...weekSpent,
	credits: { unlimited: true },
});
assert.equal(unlimited.creditOverage, true);
assert.equal(evalModule.classifyCodexQuotaKind(unlimited).kind, "watch");

console.log("credit-overage-check: ok");
