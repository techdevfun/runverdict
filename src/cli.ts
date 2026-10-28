#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { detectRuntimes, type RuntimeInfo } from "./runtimes.js";
import { httpWorkload, loadCheck, startupMedianMs } from "./measure.js";
import { decideVerdict, type MeasuredRuntime } from "./verdict.js";
import { buildManifest, measureTable, runtimesTable } from "./report.js";

export const VERSION = "0.1.0";

const USAGE = [
  "runverdict - measure your app across installed JS runtimes and get an upgrade verdict.",
  "",
  "Usage:",
  "  runverdict runtimes",
  "  runverdict measure --entry <file> --url <http-path> [--runtimes node,bun] [--duration <seconds>] [--connections <n>] [--json <out.json>]",
  "  runverdict --version",
  "",
  "Notes:",
  "  runtimes are never downloaded; a runtime that is not installed is reported as skipped.",
  "  measurement is local only and never touches the network beyond localhost.",
].join("\n");

function parseOptions(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

async function runRuntimes(): Promise<number> {
  const infos = await detectRuntimes(["node", "bun"]);
  console.log(runtimesTable(infos));
  return 0;
}

async function runMeasure(args: string[]): Promise<number> {
  let options: Record<string, string>;
  try {
    options = parseOptions(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const entry = options["entry"];
  const url = options["url"];
  if (entry === undefined || entry === "") {
    console.error("--entry is required.");
    return 2;
  }
  if (url === undefined || !url.startsWith("/")) {
    console.error("--url is required and must start with /.");
    return 2;
  }
  const entryPath = path.resolve(entry);
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    console.error(`Entry file not found: ${entry}`);
    return 2;
  }
  const duration = options["duration"] !== undefined ? Number(options["duration"]) : 10;
  const connections = options["connections"] !== undefined ? Number(options["connections"]) : 20;
  if (!Number.isFinite(duration) || duration <= 0) {
    console.error("--duration must be a positive number of seconds.");
    return 2;
  }
  if (!Number.isInteger(connections) || connections < 1) {
    console.error("--connections must be a positive integer.");
    return 2;
  }
  const requested = (options["runtimes"] ?? "node,bun")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const name of requested) {
    if (name !== "node" && name !== "bun") {
      console.error(`Unsupported runtime: ${name}. v1 supports node and bun only; deno is out of scope.`);
      return 2;
    }
  }
  const infos = await detectRuntimes(requested as Array<"node" | "bun">);
  const byName = new Map<string, RuntimeInfo>(infos.map((info) => [info.name, info]));
  const cwd = path.dirname(entryPath);
  const skipped: string[] = [];
  const all: MeasuredRuntime[] = [];
  const measured: MeasuredRuntime[] = [];
  const loadFailures: MeasuredRuntime[] = [];
  for (const name of requested) {
    const info = byName.get(name);
    if (info === undefined || !info.installed) {
      skipped.push(name);
      console.log(`${name}: not installed, skipped (never downloaded).`);
      continue;
    }
    const load = await loadCheck(name, entryPath, cwd);
    if (!load.ok) {
      const failed: MeasuredRuntime = {
        name,
        info,
        loadOk: false,
        stderrTail: load.stderrTail,
        startupMsMedian: null,
        requestsPerSecond: null,
        p50Ms: null,
        p95Ms: null,
        peakRssMb: null,
        requests: 0,
        errors: 0,
      };
      all.push(failed);
      loadFailures.push(failed);
      continue;
    }
    const startup = await startupMedianMs(name, entryPath, cwd);
    const workload = await httpWorkload(name, entryPath, cwd, url, duration, connections);
    if (workload === null || workload.requests === 0) {
      const failed: MeasuredRuntime = {
        name,
        info,
        loadOk: true,
        stderrTail: null,
        startupMsMedian: startup,
        requestsPerSecond: null,
        p50Ms: null,
        p95Ms: null,
        peakRssMb: null,
        requests: workload?.requests ?? 0,
        errors: workload?.errors ?? 0,
      };
      all.push(failed);
      continue;
    }
    const result: MeasuredRuntime = {
      name,
      info,
      loadOk: true,
      stderrTail: null,
      startupMsMedian: startup,
      requestsPerSecond: workload.requestsPerSecond,
      p50Ms: workload.p50Ms,
      p95Ms: workload.p95Ms,
      peakRssMb: workload.peakRssMb,
      requests: workload.requests,
      errors: workload.errors,
    };
    all.push(result);
    measured.push(result);
  }
  const verdictResult = decideVerdict(measured, loadFailures);
  console.log(measureTable(all));
  if (skipped.length > 0) {
    console.log(`Skipped (not installed): ${skipped.join(", ")}`);
  }
  console.log(`Verdict: ${verdictResult.verdict}`);
  for (const reason of verdictResult.reasons) {
    console.log(`Reason: ${reason}`);
  }
  console.log("Note: single-machine measurement, not a general claim.");
  const jsonOut = options["json"];
  if (jsonOut !== undefined) {
    const manifest = buildManifest(
      VERSION,
      entryPath,
      url,
      duration,
      connections,
      all,
      skipped,
      verdictResult,
    );
    fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`JSON manifest written to ${jsonOut}`);
  }
  if (verdictResult.verdict === "BLOCKED" || measured.length === 0) {
    return 1;
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(`runverdict ${VERSION}`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "runtimes") {
    return runRuntimes();
  }
  if (command === "measure") {
    return runMeasure(rest);
  }
  console.error(`Unknown command: ${command}`);
  console.error(USAGE);
  return 2;
}

// This file is the CLI entry point (dist/cli.js); it always runs main.
// Unit tests import the library modules, never this file.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
