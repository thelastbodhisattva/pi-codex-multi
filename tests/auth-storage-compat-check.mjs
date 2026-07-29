import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");

assert.match(source, /readStoredCredential,/);
assert.match(source, /function getAuthStorage\(/);
assert.match(source, /getProviderAuthStatus\(provider\)\.configured/);
assert.doesNotMatch(source, /ctx\.modelRegistry\.authStorage/);

console.log("auth storage compatibility checks passed");
