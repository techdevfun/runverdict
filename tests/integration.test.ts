import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { detectRuntimes } from "../src/runtimes.js";
import { httpWorkload, loadCheck } from "../src/measure.js";

// dist/tests/integration.test.js -> repo root is two levels up.
const ROOT = path.resolve(__dirname, "..", "..");
const SAMPLE_APP = path.join(ROOT, "examples", "sample-app.js");
const CLI = path.join(ROOT, "dist", "src", "cli.js");

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { timeout: 120000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test("integration: runtimes command lists node and bun with correct versions and EOL statuses", async () => {
  const { code, stdout } = await runCli(["runtimes"]);
  assert.equal(code, 0);
  assert.match(stdout, /node/);
  assert.match(stdout, /Maintenance/);
  assert.match(stdout, /bun/);
  // Bun must never carry an invented EOL date.
  assert.match(stdout, /No EOL schedule/);
  const infos = await detectRuntimes(["node", "bun"]);
  const nodeInfo = infos.find((i) => i.name === "node");
  const bunInfo = infos.find((i) => i.name === "bun");
  assert.equal(nodeInfo?.installed, true);
  assert.equal(nodeInfo?.eolStatus, "Maintenance");
  assert.equal(bunInfo?.installed, true);
  assert.equal(bunInfo?.eol, null);
});

test("integration: sample app loads and serves under node AND bun", async () => {
  for (const runtime of ["node", "bun"] as const) {
    const load = await loadCheck(runtime, SAMPLE_APP, ROOT);
    assert.equal(load.ok, true, `${runtime} load check failed: ${load.stderrTail ?? ""}`);
    const workload = await httpWorkload(runtime, SAMPLE_APP, ROOT, "/json", 2, 4);
    assert.ok(workload !== null, `${runtime} workload returned null`);
    assert.ok(workload.requests > 0, `${runtime} served zero requests`);
    assert.ok((workload.requestsPerSecond ?? 0) > 0);
    assert.ok((workload.p50Ms ?? 0) >= 0);
    assert.ok((workload.p95Ms ?? 0) >= 0);
    assert.ok((workload.peakRssMb ?? 0) > 0);
  }
});

test("integration: measure on the sample app produces a JSON manifest matching the table", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runverdict-measure-"));
  const outJson = path.join(dir, "out.json");
  const { code, stdout } = await runCli([
    "measure",
    "--entry",
    SAMPLE_APP,
    "--url",
    "/json",
    "--runtimes",
    "node,bun",
    "--duration",
    "2",
    "--connections",
    "4",
    "--json",
    outJson,
  ]);
  // Both runtimes load; the verdict is STAY or UPGRADE-READY, both exit 0.
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Verdict: (STAY|UPGRADE-READY)/);
  const manifest = JSON.parse(fs.readFileSync(outJson, "utf8")) as {
    runtimes: Array<{ name: string; requestsPerSecond: number | null }>;
    verdict: string;
    machineNote: string;
  };
  assert.equal(manifest.machineNote, "single-machine measurement, not a general claim");
  assert.equal(manifest.runtimes.length, 2);
  for (const row of manifest.runtimes) {
    assert.ok((row.requestsPerSecond ?? 0) > 0, `${row.name} manifest req/s missing`);
    assert.match(stdout, new RegExp(row.name));
  }
  assert.match(stdout, new RegExp(manifest.verdict));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("integration: a throwing fixture yields BLOCKED with exit 1, not a crash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runverdict-blocked-"));
  const entry = path.join(dir, "broken.js");
  fs.writeFileSync(entry, "throw new Error('boom-blocked-fixture');\n");
  const { code, stdout } = await runCli([
    "measure",
    "--entry",
    entry,
    "--url",
    "/json",
    "--runtimes",
    "node",
    "--duration",
    "1",
    "--connections",
    "2",
  ]);
  assert.equal(code, 1);
  assert.match(stdout, /BLOCKED/);
  assert.match(stdout, /boom-blocked-fixture/);
  fs.rmSync(dir, { recursive: true, force: true });
});
