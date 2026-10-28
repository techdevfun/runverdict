import { execFile } from "node:child_process";

export type EolStatus = "EOL" | "Maintenance" | "Active LTS" | "UNKNOWN";

export interface EolInfo {
  status: EolStatus;
  eol: string | null;
}

export interface RuntimeInfo {
  name: "node" | "bun";
  installed: boolean;
  version: string | null;
  major: number | null;
  /** Node only. Bun has no LTS/EOL schedule, so this is always null for Bun. */
  eolStatus: EolStatus | "not-applicable";
  eol: string | null;
}

const NODE_EOL_TABLE: Record<number, EolInfo> = {
  20: { status: "EOL", eol: "2026-04-30" },
  22: { status: "Maintenance", eol: "2027-04-30" },
  24: { status: "Maintenance", eol: "2028-04-30" },
  26: { status: "Active LTS", eol: "2029-04-30" },
};

/** Node EOL schedule. Unknown majors return UNKNOWN with a null date, never a guess. */
export function nodeEol(major: number): EolInfo {
  const info = NODE_EOL_TABLE[major];
  if (info !== undefined) {
    return { ...info };
  }
  return { status: "UNKNOWN", eol: null };
}

/** Parse `v24.22.1` style output. Returns null when the format is unrecognised. */
export function parseNodeVersion(output: string): { version: string; major: number } | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  return { version: `${major}.${match[2]}.${match[3]}`, major };
}

/** Parse `1.4.4` style output. Returns null when the format is unrecognised. */
export function parseBunVersion(output: string): { version: string; major: number } | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  return { version: `${major}.${match[2]}.${match[3]}`, major };
}

function runVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 10000 }, (error, stdout) => {
      if (error !== null) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function detectRuntime(name: "node" | "bun"): Promise<RuntimeInfo> {
  const raw = await runVersion(name);
  if (raw === null) {
    return { name, installed: false, version: null, major: null, eolStatus: "not-applicable", eol: null };
  }
  if (name === "node") {
    const parsed = parseNodeVersion(raw);
    if (parsed === null) {
      return { name, installed: true, version: raw.trim(), major: null, eolStatus: "UNKNOWN", eol: null };
    }
    const eol = nodeEol(parsed.major);
    return { name, installed: true, version: parsed.version, major: parsed.major, eolStatus: eol.status, eol: eol.eol };
  }
  const parsed = parseBunVersion(raw);
  if (parsed === null) {
    return { name, installed: true, version: raw.trim(), major: null, eolStatus: "not-applicable", eol: null };
  }
  // Bun has no LTS/EOL schedule: report the version only, never invent an EOL date.
  return { name, installed: true, version: parsed.version, major: parsed.major, eolStatus: "not-applicable", eol: null };
}

export async function detectRuntimes(names: Array<"node" | "bun">): Promise<RuntimeInfo[]> {
  const out: RuntimeInfo[] = [];
  for (const name of names) {
    out.push(await detectRuntime(name));
  }
  return out;
}
