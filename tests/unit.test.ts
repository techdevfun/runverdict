import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCheck, median, p50, p95 } from "../src/measure.js";
import { nodeEol, parseBunVersion, parseNodeVersion } from "../src/runtimes.js";
import { decideVerdict, type MeasuredRuntime } from "../src/verdict.js";
import type { RuntimeInfo } from "../src/runtimes.js";

function info(name: "node" | "bun", eolStatus: RuntimeInfo["eolStatus"], eol: string | null): RuntimeInfo {
  return {
    name,
    installed: true,
    version: name === "node" ? "24.0.0" : "1.4.4",
    major: name === "node" ? 24 : 1,
    eolStatus,
    eol,
  };
}

function measured(
  name: string,
  runtimeInfo: RuntimeInfo,
  rps: number | null,
): MeasuredRuntime {
  return {
    name,
    info: runtimeInfo,
    loadOk: true,
    stderrTail: null,
    startupMsMedian: 40,
    requestsPerSecond: rps,
    p50Ms: 2,
    p95Ms: 5,
    peakRssMb: 30,
    requests: 100,
    errors: 0,
  };
}

test("EOL table: Node 20 is EOL, 22 and 24 are Maintenance, 26 is Active LTS", () => {
  assert.deepEqual(nodeEol(20), { status: "EOL", eol: "2026-04-30" });
  assert.deepEqual(nodeEol(22), { status: "Maintenance", eol: "2027-04-30" });
  assert.deepEqual(nodeEol(24), { status: "Maintenance", eol: "2028-04-30" });
  assert.deepEqual(nodeEol(26), { status: "Active LTS", eol: "2029-04-30" });
});

test("EOL table: unknown majors are UNKNOWN with no invented date", () => {
  assert.deepEqual(nodeEol(18), { status: "UNKNOWN", eol: null });
  assert.deepEqual(nodeEol(99), { status: "UNKNOWN", eol: null });
});

test("inventory parsing: node and bun version strings", () => {
  assert.deepEqual(parseNodeVersion("v24.22.1\n"), { version: "24.22.1", major: 24 });
  assert.deepEqual(parseBunVersion("1.4.4\n"), { version: "1.4.4", major: 1 });
  assert.equal(parseNodeVersion("not a version"), null);
  assert.equal(parseBunVersion(""), null);
});

test("stats: median, p50 and p95", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(p50([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 5);
  assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  assert.equal(p95([]), null);
});

test("verdict: UPGRADE-READY when current is Maintenance and target is within 10%", () => {
  const current = measured("node", info("node", "Maintenance", "2028-04-30"), 1000);
  const target = measured("bun", info("bun", "not-applicable", null), 950);
  const result = decideVerdict([current, target], []);
  assert.equal(result.verdict, "UPGRADE-READY");
  assert.equal(result.current, "node");
  assert.equal(result.target, "bun");
});

test("verdict: STAY when the target regresses by more than 10%, with both numbers", () => {
  const current = measured("node", info("node", "Maintenance", "2028-04-30"), 1000);
  const target = measured("bun", info("bun", "not-applicable", null), 800);
  const result = decideVerdict([current, target], []);
  assert.equal(result.verdict, "STAY");
  assert.match(result.reasons.join(" "), /800/);
  assert.match(result.reasons.join(" "), /1000/);
});

test("verdict: STAY when the current runtime has no EOL or maintenance pressure", () => {
  const current = measured("node", info("node", "Active LTS", "2029-04-30"), 1000);
  const target = measured("bun", info("bun", "not-applicable", null), 2000);
  const result = decideVerdict([current, target], []);
  assert.equal(result.verdict, "STAY");
});

test("verdict: BLOCKED when a runtime fails the load check, naming it", () => {
  const current = measured("node", info("node", "Maintenance", "2028-04-30"), 1000);
  const failed = { ...measured("bun", info("bun", "not-applicable", null), null), loadOk: false, stderrTail: "Cannot find module 'missing-dep'" };
  const result = decideVerdict([current], [failed]);
  assert.equal(result.verdict, "BLOCKED");
  assert.match(result.reasons.join(" "), /bun/);
  assert.match(result.reasons.join(" "), /missing-dep/);
});

test("verdict: BLOCKED when no runtime produced a measurement", () => {
  const result = decideVerdict([], []);
  assert.equal(result.verdict, "BLOCKED");
});

test("verdict: STAY with a single measured runtime", () => {
  const current = measured("node", info("node", "Maintenance", "2028-04-30"), 1000);
  const result = decideVerdict([current], []);
  assert.equal(result.verdict, "STAY");
  assert.equal(result.target, null);
});

test("load check: a fixture that throws is captured, not a crash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runverdict-broken-"));
  const entry = path.join(dir, "broken.js");
  fs.writeFileSync(entry, "throw new Error('boom-missing-addon');\n");
  const result = await loadCheck("node", entry, dir);
  assert.equal(result.ok, false);
  assert.match(result.stderrTail ?? "", /boom-missing-addon/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("load check: a healthy entry passes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runverdict-ok-"));
  const entry = path.join(dir, "ok.js");
  fs.writeFileSync(entry, "console.log('ready');\n");
  const result = await loadCheck("node", entry, dir);
  assert.equal(result.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
