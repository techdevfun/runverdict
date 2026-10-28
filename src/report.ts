import type { RuntimeInfo } from "./runtimes.js";
import type { MeasuredRuntime, VerdictResult } from "./verdict.js";

export const MACHINE_NOTE = "single-machine measurement, not a general claim";

export interface Manifest {
  tool: string;
  version: string;
  entry: string;
  url: string;
  durationSeconds: number;
  connections: number;
  machineNote: string;
  runtimes: Array<{
    name: string;
    installed: boolean;
    version: string | null;
    eolStatus: string;
    eol: string | null;
    loadOk: boolean | null;
    stderrTail: string | null;
    startupMsMedian: number | null;
    requestsPerSecond: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    peakRssMb: number | null;
    requests: number;
    errors: number;
  }>;
  skipped: string[];
  verdict: string;
  reasons: string[];
  current: string | null;
  target: string | null;
}

function num(value: number | null, digits = 1): string {
  if (value === null) {
    return "-";
  }
  return value.toFixed(digits);
}

export function runtimeTableRow(info: RuntimeInfo): string {
  if (!info.installed) {
    return `${info.name}\t-\tnot installed\t-`;
  }
  if (info.name === "bun") {
    return `bun\t${info.version ?? "-"}\tNo EOL schedule (version only)\t-`;
  }
  return `node\t${info.version ?? "-"}\t${info.eolStatus}\t${info.eol ?? "-"}`;
}

export function runtimesTable(infos: RuntimeInfo[]): string {
  const lines = ["Runtime\tVersion\tEOL status\tEOL date"];
  for (const info of infos) {
    lines.push(runtimeTableRow(info));
  }
  return lines.join("\n");
}

export function measureTable(results: MeasuredRuntime[]): string {
  const lines = [
    "Runtime\tVersion\tEOL\tLoad\tStartup median (ms)\tReq/s\tp50 (ms)\tp95 (ms)\tPeak RSS (MB)",
  ];
  for (const r of results) {
    lines.push(
      [
        r.name,
        r.info.version ?? "-",
        r.info.name === "bun" ? "n/a" : r.info.eolStatus,
        r.loadOk ? "ok" : "FAILED",
        num(r.startupMsMedian, 0),
        num(r.requestsPerSecond),
        num(r.p50Ms),
        num(r.p95Ms),
        num(r.peakRssMb),
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

export function buildManifest(
  version: string,
  entry: string,
  url: string,
  durationSeconds: number,
  connections: number,
  all: MeasuredRuntime[],
  skipped: string[],
  verdictResult: VerdictResult,
): Manifest {
  return {
    tool: "runverdict",
    version,
    entry,
    url,
    durationSeconds,
    connections,
    machineNote: MACHINE_NOTE,
    runtimes: all.map((r) => ({
      name: r.name,
      installed: r.info.installed,
      version: r.info.version,
      eolStatus: r.info.eolStatus,
      eol: r.info.eol,
      loadOk: r.loadOk,
      stderrTail: r.stderrTail,
      startupMsMedian: r.startupMsMedian,
      requestsPerSecond: r.requestsPerSecond,
      p50Ms: r.p50Ms,
      p95Ms: r.p95Ms,
      peakRssMb: r.peakRssMb,
      requests: r.requests,
      errors: r.errors,
    })),
    skipped,
    verdict: verdictResult.verdict,
    reasons: verdictResult.reasons,
    current: verdictResult.current,
    target: verdictResult.target,
  };
}
