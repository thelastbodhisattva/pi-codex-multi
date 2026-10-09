import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");

// Production wiring: type/config/menu/docs, bounded quota cache, exact reset
// persistence, model capability filtering, and retry-source guard.
assert.match(source, /type PoolStrategy = [^;]*"priority"/);
assert.match(source, /value === "priority"/);
assert.match(source, /priority -- Prefer members in order while quota-eligible/);
assert.match(source, /value: "priority"[\s\S]*?configured order while quota-eligible/);
assert.match(source, /const QUOTA_CACHE_TTL_MS = 30 \* 1000/);
assert.match(source, /markQuotaBlocked\(first, result\.resetAt\)/);
assert.match(source, /function findUsableModel\(/);
assert.match(source, /const scopedModels = ctx\.scopedModels \?\? \[\];[\s\S]*?if \(scopedModels\.length === 0\) return model/);
assert.match(source, /scoped\.model\.provider === providerName && scoped\.model\.id === modelId/);
assert.match(source, /isModelUsable: \(provider, modelId\) => Boolean\(findUsableModel\(ctx, provider, modelId\)\)/);
assert.doesNotMatch(source, /BASE_CODEX_ONLY_MODEL_IDS/,
  "package code must not hard-code machine-specific model capabilities");

const inputHandler = source.match(/pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?\n\t\}\);/)?.[0];
assert.ok(inputHandler, "production input handler not found");
assert.match(inputHandler, /event\.source !== "extension"/);
assert.match(inputHandler, /pool\.strategy === "priority"/);
assert.match(inputHandler, /getPriorityTarget\(pool, activeModel, ctx\)/);
assert.ok(
  inputHandler.indexOf('event.source !== "extension"') < inputHandler.indexOf("getPriorityTarget"),
  "extension-injected retries must be outside proactive priority routing",
);

class PriorityHarness {
  constructor({ members, authenticated, models, scopedModels = [], quota, now = 1_000 }) {
    this.members = members;
    this.authenticated = authenticated;
    this.models = models;
    this.scopedModels = scopedModels;
    this.quota = quota;
    this.now = now;
    this.cache = new Map();
    this.exhausted = new Map();
    this.current = null;
    this.switches = [];
    this.lookupCalls = [];
    this.followUps = 0;
  }

  supports(provider, model) {
    const key = `${provider}:${model}`;
    return this.models.has(key)
      && (this.scopedModels.length === 0 || this.scopedModels.includes(key));
  }

  structurallyEligible(provider, model) {
    const until = this.exhausted.get(provider);
    if (until !== undefined && until <= this.now) this.exhausted.delete(provider);
    return this.authenticated.has(provider)
      && !this.exhausted.has(provider)
      && this.supports(provider, model);
  }

  async lookup(provider) {
    const cached = this.cache.get(provider);
    const blockedResetPassed = cached?.result.kind === "blocked"
      && cached.result.resetAt <= this.now;
    if (cached && cached.expires > this.now && !blockedResetPassed) return cached.result;
    this.lookupCalls.push(provider);
    const result = await this.quota(provider, this.now);
    this.cache.set(provider, { expires: this.now + 30_000, result });
    return result;
  }

  async priorityTarget() {
    const { provider: currentProvider, id } = this.current;
    const candidates = this.members.filter((provider) => this.structurallyEligible(provider, id));
    const first = candidates[0];
    if (!first) return undefined;
    if (first === currentProvider && this.members[0] !== first) return undefined;

    let result;
    try {
      result = await this.lookup(first);
    } catch {
      return undefined;
    }
    if (!result || result.kind === "error" || result.kind === "missing-auth") return undefined;
    if (result.kind !== "blocked") return first === currentProvider ? undefined : first;

    this.exhausted.set(first, result.resetAt > this.now ? result.resetAt : this.now + 300_000);
    const fallback = candidates.find((provider) => provider !== first);
    return fallback && fallback !== currentProvider ? fallback : undefined;
  }

  async input(source = "interactive") {
    if (source === "extension") return;
    const target = await this.priorityTarget();
    if (!target) return;
    this.switches.push(`${target}:${this.current.id}`);
    this.current = { provider: target, id: this.current.id };
  }

  async runtimeRateLimit() {
    const failed = this.current.provider;
    this.exhausted.set(failed, this.now + 300_000);
    const target = this.members.find((provider) =>
      provider !== failed && this.structurallyEligible(provider, this.current.id));
    if (!target) return false;
    this.switches.push(`${target}:${this.current.id}`);
    this.current = { provider: target, id: this.current.id };
    this.followUps += 1;
    return true;
  }
}

const shared = "gpt-shared";
const members = ["openai-codex-2", "openai-codex"];
const sharedModels = new Set(members.map((provider) => `${provider}:${shared}`));

// Preferred available + bounded cache: promote once, then retain it without a
// second network lookup on the next external turn.
{
  const h = new PriorityHarness({
    members,
    authenticated: new Set(members),
    models: sharedModels,
    quota: async () => ({ kind: "ready" }),
  });
  h.current = { provider: "openai-codex", id: shared };
  await h.input();
  await h.input("rpc");
  assert.equal(h.current.provider, "openai-codex-2");
  assert.deepEqual(h.switches, [`openai-codex-2:${shared}`]);
  assert.deepEqual(h.lookupCalls, ["openai-codex-2"]);
}

// Preferred blocked: persist through the reported reset, use base, make no
// request while cooling down, and automatically fail back after reset.
{
  const resetAt = 10_000;
  const h = new PriorityHarness({
    members,
    authenticated: new Set(members),
    models: sharedModels,
    now: 5_000,
    quota: async (_provider, now) => now < resetAt
      ? { kind: "blocked", resetAt }
      : { kind: "ready", resetAt: now + 100_000 },
  });
  h.current = { provider: "openai-codex-2", id: shared };
  await h.input();
  assert.equal(h.current.provider, "openai-codex");
  assert.equal(h.exhausted.get("openai-codex-2"), resetAt);
  h.now = 9_999;
  await h.input();
  assert.equal(h.lookupCalls.length, 1, "cooldown avoids per-turn quota requests");
  h.now = resetAt + 1;
  await h.input();
  assert.equal(h.current.provider, "openai-codex-2");
  assert.equal(h.lookupCalls.length, 2, "reset invalidates a stale blocked cache entry");
}

// Capability is a hard filter: both providers may advertise the model, but
// this session's declared scope permits only the base provider. The cloned
// provider is neither probed nor used for runtime failover.
{
  const h = new PriorityHarness({
    members,
    authenticated: new Set(members),
    models: new Set([
      "openai-codex:gpt-restricted",
      "openai-codex-2:gpt-restricted",
    ]),
    scopedModels: ["openai-codex:gpt-restricted"],
    quota: async () => ({ kind: "ready" }),
  });
  h.current = { provider: "openai-codex", id: "gpt-restricted" };
  await h.input();
  assert.equal(await h.runtimeRateLimit(), false);
  assert.deepEqual(h.lookupCalls, []);
  assert.deepEqual(h.switches, []);
}

// Missing preferred auth is skipped without a lookup or switch.
{
  const h = new PriorityHarness({
    members,
    authenticated: new Set(["openai-codex"]),
    models: sharedModels,
    quota: async () => ({ kind: "ready" }),
  });
  h.current = { provider: "openai-codex", id: shared };
  await h.input();
  assert.deepEqual(h.lookupCalls, []);
  assert.deepEqual(h.switches, []);
}

// Lookup failure is fail-safe: do not guess that the preferred account is
// eligible and do not disturb the current working provider.
{
  const h = new PriorityHarness({
    members,
    authenticated: new Set(members),
    models: sharedModels,
    quota: async () => { throw new Error("usage endpoint unavailable"); },
  });
  h.current = { provider: "openai-codex", id: shared };
  await h.input();
  assert.equal(h.current.provider, "openai-codex");
  assert.deepEqual(h.switches, []);
}

// Runtime rate-limit failover injects one retry, but that extension-sourced
// turn must not proactively route back and create turn-level thrash.
{
  const h = new PriorityHarness({
    members,
    authenticated: new Set(members),
    models: sharedModels,
    quota: async () => ({ kind: "ready" }),
  });
  h.current = { provider: "openai-codex-2", id: shared };
  assert.equal(await h.runtimeRateLimit(), true);
  await h.input("extension");
  assert.equal(h.current.provider, "openai-codex");
  assert.equal(h.followUps, 1);
  assert.deepEqual(h.switches, [`openai-codex:${shared}`]);
  assert.deepEqual(h.lookupCalls, []);
}

console.log("priority routing checks passed");
