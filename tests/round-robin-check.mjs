import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
const inputHandler = source.match(/pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?\n\t\}\);/)?.[0];
const getNextMember = source.match(/\r?\n\tgetNextMember\([\s\S]*?\r?\n\t\}\r?\n/)?.[0];

assert.ok(inputHandler, "production input handler not found");
assert.ok(getNextMember, "production getNextMember not found");
assert.match(inputHandler, /event\.source !== "extension"/);
assert.match(inputHandler, /getPoolForProvider\(ctx\.model\.provider\)/);
assert.match(inputHandler, /\(pool\.strategy \|\| "round-robin"\) === "round-robin"/);
assert.match(inputHandler, /getNextMember\(\s*pool,\s*ctx\.model\.provider,\s*getAuthStorage\(ctx\),?\s*\)/);
assert.match(inputHandler, /ctx\.modelRegistry\.find\(selection\.provider, ctx\.model\.id\)/);
assert.match(inputHandler, /await pi\.setModel\(nextModel/);
assert.match(inputHandler, /commitRoundRobin\(pool\.name, selection\.index\)/,
  "round-robin pointer may only advance after a confirmed switch");
assert.ok(
  inputHandler.indexOf("commitRoundRobin") > inputHandler.indexOf("await pi.setModel"),
  "pointer commit must happen after the switch attempt",
);
assert.doesNotMatch(getNextMember, /state\.currentIndex\s*=/,
  "getNextMember must not pre-advance the round-robin pointer");
assert.ok(
  inputHandler.indexOf("enforceProjectRestriction") < inputHandler.indexOf("getNextMember"),
  "rotation must follow project restriction enforcement",
);
assert.ok(
  inputHandler.indexOf('event.source !== "extension"') < inputHandler.indexOf("getNextMember"),
  "extension guard must wrap rotation",
);
assert.match(getNextMember, /getAvailableMembers\(pool, authStorage\)/);
assert.match(source, /sendUserMessage\(lastUserPrompt, \{ deliverAs: "followUp" \}\)/);

class Harness {
  constructor(pool, authenticated, cooldown, modelId) {
    this.pool = pool;
    this.authenticated = authenticated;
    this.cooldown = cooldown;
    this.modelId = modelId;
    this.models = [];
  }

  getNextMember(currentProvider) {
    const available = this.pool.members.filter(
      (provider) => this.authenticated.has(provider) && !this.cooldown.has(provider),
    );
    const start = this.pool.members.indexOf(currentProvider);
    for (let step = 1; step <= this.pool.members.length; step++) {
      const candidate = this.pool.members[(start + step) % this.pool.members.length];
      if (candidate !== currentProvider && available.includes(candidate)) return candidate;
    }
    return undefined;
  }

  async input(event, ctx) {
    if (event.text.trimStart().startsWith("/")) return;
    if (event.source !== "extension" && ctx.model) {
      const pool = this.pool.enabled && this.pool.members.includes(ctx.model.provider) ? this.pool : undefined;
      if (pool && (pool.strategy || "round-robin") === "round-robin") {
        const nextProvider = this.getNextMember(ctx.model.provider);
        const nextModel = nextProvider ? ctx.modelRegistry.find(nextProvider, ctx.model.id) : undefined;
        if (nextModel && (await this.setModel(nextModel))) ctx.model = nextModel;
      }
    }
  }

  async setModel(model) {
    this.models.push(model);
    return true;
  }
}

const modelId = "gpt-5-codex";
const pool = { enabled: true, members: ["account-a", "account-b", "account-c", "account-d", "account-e"] };
const harness = new Harness(
  pool,
  new Set(["account-a", "account-b", "account-c", "account-e"]),
  new Set(["account-c"]),
  modelId,
);
const ctx = {
  model: { provider: "account-a", id: modelId },
  modelRegistry: {
    find(provider, id) {
      return id === modelId ? { provider, id } : undefined;
    },
  },
};

await harness.input({ text: "first", source: "interactive" }, ctx);
await harness.input({ text: "second", source: "rpc" }, ctx);
await harness.input({ text: "third", source: "interactive" }, ctx);
assert.deepEqual(
  harness.models.map(({ provider }) => provider),
  ["account-b", "account-e", "account-a"],
  "external turns must rotate in order, skipping cooldown and unauthenticated members",
);
assert.ok(harness.models.every(({ id }) => id === modelId), "rotation must preserve the exact model id");

await harness.input({ text: "retry", source: "extension" }, ctx);
assert.equal(harness.models.length, 3, "extension retries must not rotate");

console.log("round-robin checks passed");
