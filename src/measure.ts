import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Percentile over sorted-ascending values, nearest-rank method. */
export function percentile(sortedAscending: number[], p: number): number | null {
  if (sortedAscending.length === 0) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

export function p50(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 50);
}

export function p95(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 95);
}

export function stderrTail(stderr: string, maxChars = 1000): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(trimmed.length - maxChars);
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function readPeakRssMb(pid: number | undefined): number | null {
  if (pid === undefined) {
    return null;
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const hwm = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    if (hwm !== null) {
      return Number(hwm[1]) / 1024;
    }
    const rss = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (rss !== null) {
      return Number(rss[1]) / 1024;
    }
  } catch {
    return null;
  }
  return null;
}

function readRssMb(pid: number | undefined): number | null {
  if (pid === undefined) {
    return null;
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (rss !== null) {
      return Number(rss[1]) / 1024;
    }
  } catch {
    return null;
  }
  return null;
}

export interface LoadResult {
  ok: boolean;
  stderrTail: string | null;
}

/**
 * Load check: spawn the entry and watch briefly. A process that stays up
 * or exits 0 passes; a non-zero exit fails and its stderr tail is kept
 * verbatim. A load failure is a reason, not a crash.
 */
export function loadCheck(
  runtime: string,
  entry: string,
  cwd: string,
  timeoutMs = 5000,
): Promise<LoadResult> {
  return new Promise((resolve) => {
    const child = spawn(runtime, [entry], { cwd, env: { ...process.env } });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void killChild(child).then(() => resolve({ ok: true, stderrTail: null }));
    }, Math.min(timeoutMs, 1500));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stderrTail: stderrTail(stderr) });
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stderrTail: null });
      } else {
        resolve({ ok: false, stderrTail: stderrTail(stderr) });
      }
    });
  });
}

function firstStdoutLineMs(
  runtime: string,
  entry: string,
  cwd: string,
  timeoutMs = 5000,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(runtime, [entry], { cwd, env: { ...process.env } });
    const started = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void killChild(child).then(() => resolve(null));
    }, timeoutMs);
    const finish = (value: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void killChild(child).then(() => resolve(value));
    };
    child.stdout?.on("data", () => finish(Date.now() - started));
    child.on("exit", () => finish(null));
    child.on("error", () => finish(null));
  });
}

/** Startup timing: median of 5 spawns, spawn to first stdout line. */
export async function startupMedianMs(
  runtime: string,
  entry: string,
  cwd: string,
): Promise<number | null> {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const ms = await firstStdoutLineMs(runtime, entry, cwd);
    if (ms !== null) {
      samples.push(ms);
    }
  }
  return median(samples);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function probe(port: number, urlPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port: number, urlPath: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, urlPath)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function singleRequest(port: number, urlPath: string, agent: http.Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(Date.now() - started));
    });
    req.on("error", reject);
  });
}

export interface WorkloadResult {
  requests: number;
  errors: number;
  requestsPerSecond: number;
  p50Ms: number | null;
  p95Ms: number | null;
  peakRssMb: number | null;
  elapsedSeconds: number;
}

export async function httpWorkload(
  runtime: string,
  entry: string,
  cwd: string,
  urlPath: string,
  durationSeconds: number,
  connections: number,
): Promise<WorkloadResult | null> {
  const port = await freePort();
  const child = spawn(runtime, [entry], {
    cwd,
    env: { ...process.env, PORT: String(port) },
  });
  // Drain output so a chatty app cannot block on a full pipe.
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  try {
    const ready = await waitForServer(port, urlPath);
    if (!ready) {
      return null;
    }
    let peakRssMb: number | null = readRssMb(child.pid);
    const rssTimer = setInterval(() => {
      const current = readRssMb(child.pid);
      if (current !== null && (peakRssMb === null || current > peakRssMb)) {
        peakRssMb = current;
      }
    }, 100);
    const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
    const latencies: number[] = [];
    let requests = 0;
    let errors = 0;
    const deadline = Date.now() + durationSeconds * 1000;
    const startedAt = Date.now();
    async function worker(): Promise<void> {
      while (Date.now() < deadline) {
        try {
          const ms = await singleRequest(port, urlPath, agent);
          latencies.push(ms);
          requests += 1;
        } catch {
          errors += 1;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < connections; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    clearInterval(rssTimer);
    const hwm = readPeakRssMb(child.pid);
    if (hwm !== null && (peakRssMb === null || hwm > peakRssMb)) {
      peakRssMb = hwm;
    }
    agent.destroy();
    return {
      requests,
      errors,
      requestsPerSecond: elapsedSeconds > 0 ? requests / elapsedSeconds : 0,
      p50Ms: p50(latencies),
      p95Ms: p95(latencies),
      peakRssMb,
      elapsedSeconds,
    };
  } finally {
    await killChild(child);
  }
}
