import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
const templates = source.slice(
  source.indexOf("const PROVIDER_TEMPLATES"),
  source.indexOf("const SUPPORTED_PROVIDERS"),
);

assert.match(templates, /"openai-codex"/);
assert.doesNotMatch(templates, /anthropic|copilot|gemini|antigravity/i);
assert.match(source, /entry\.provider === "openai-codex"/);
assert.match(source, /pool\.baseProvider === "openai-codex"/);
assert.match(source, /parsed\.allowedSubs\.filter\(isCodexProviderName\)/);
assert.match(source, /import type \{ OAuthCredentials, OAuthLoginCallbacks \} from "@earendil-works\/pi-ai\/oauth";/);
assert.doesNotMatch(source, /\b(?:loginOpenAICodex|refreshOpenAICodexToken)\b/);

console.log("Codex-only boundary checks passed");
