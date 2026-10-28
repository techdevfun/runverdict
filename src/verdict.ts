import type { RuntimeInfo } from "./runtimes.js";

export type Verdict = "UPGRADE-READY" | "STAY" | "BLOCKED";

export interface MeasuredRuntime {
  name: string;
  info: RuntimeInfo;
  loadOk: boolean;
  stderrTail: string | null;
  startupMsMedian: number | null;
  requestsPerSecond: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  peakRssMb: number | null;
  requests: number;
  errors: number;
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  current: string | null;
  target: string | null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Deterministic verdict rules. No model, no guessing.
 * current = first measured runtime in the requested order.
 * target  = the best-performing other measured runtime, if any.
 */
export function decideVerdict(
  measured: MeasuredRuntime[],
  loadFailures: MeasuredRuntime[],
): VerdictResult {
  if (loadFailures.length > 0) {
    const reasons = loadFailures.map((f) => {
      const tail = f.stderrTail !== null && f.stderrTail !== "" ? `: ${f.stderrTail}` : "";
      return `${f.name} failed the load check${tail}`;
    });
    return { verdict: "BLOCKED", reasons, current: null, target: null };
  }
  if (measured.length === 0) {
    return {
      verdict: "BLOCKED",
      reasons: ["No runtime produced a usable measurement."],
      current: null,
      target: null,
    };
  }
  const current = measured[0];
  const others = measured.slice(1);
  if (others.length === 0) {
    return {
      verdict: "STAY",
      reasons: [
        `Only one runtime measured (${current.name}); there is no target runtime to compare against.`,
      ],
      current: current.name,
      target: null,
    };
  }
  let target = others[0];
  for (const candidate of others) {
    if (
      (candidate.requestsPerSecond ?? 0) > (target.requestsPerSecond ?? 0)
    ) {
      target = candidate;
    }
  }
  const currentRps = current.requestsPerSecond ?? 0;
  const targetRps = target.requestsPerSecond ?? 0;
  const currentStatus = current.info.eolStatus;
  const upgradePressure = currentStatus === "EOL" || currentStatus === "Maintenance";
  if (!upgradePressure) {
    return {
      verdict: "STAY",
      reasons: [
        `Current runtime ${current.name} is ${currentStatus}, so there is no EOL or maintenance pressure to move. Target ${target.name} measured ${fmt(targetRps)} req/s against ${fmt(currentRps)} req/s on ${current.name}.`,
      ],
      current: current.name,
      target: target.name,
    };
  }
  if (targetRps >= currentRps * 0.9) {
    return {
      verdict: "UPGRADE-READY",
      reasons: [
        `Current runtime ${current.name} is ${currentStatus} (EOL ${current.info.eol ?? "unknown"}). Target ${target.name} loads and measured ${fmt(targetRps)} req/s against ${fmt(currentRps)} req/s on ${current.name}, within the 10% regression allowance.`,
      ],
      current: current.name,
      target: target.name,
    };
  }
  return {
    verdict: "STAY",
    reasons: [
      `Target ${target.name} measured ${fmt(targetRps)} req/s against ${fmt(currentRps)} req/s on current runtime ${current.name}, a regression beyond 10%, so staying is the measured choice.`,
    ],
    current: current.name,
    target: target.name,
  };
}
