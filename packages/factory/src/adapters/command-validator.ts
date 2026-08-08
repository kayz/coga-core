import { spawn } from "node:child_process";
import { basename } from "node:path";

import { sha256 } from "../canonical.js";
import {
  assertDirectory,
  redactText,
  resolveWithin,
  safeEnvironment,
} from "../security.js";
import type { AdapterDescriptor, CommandResult } from "../types.js";

export interface RunCommandOptions {
  root: string;
  action: string;
  signal?: AbortSignal;
  now?: () => number;
}

const blockedExecutables = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "zsh",
]);

function appendBounded(
  current: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void {
  const remaining = limit - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.byteLength <= remaining) {
    current.push(chunk);
    state.bytes += chunk.byteLength;
    return;
  }
  current.push(chunk.subarray(0, remaining));
  state.bytes += remaining;
  state.truncated = true;
}

export async function runCommandAdapter(
  descriptor: AdapterDescriptor,
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (
    descriptor.runtime !== "process" ||
    !descriptor.config?.executable ||
    !descriptor.config.cwd
  ) {
    throw new Error(
      "Command adapter requires a process descriptor with executable and cwd.",
    );
  }
  if (!descriptor.actions.includes(options.action)) {
    throw new Error(
      `Adapter '${descriptor.ref.id}' does not allow action '${options.action}'.`,
    );
  }
  const executable = descriptor.config.executable;
  if (blockedExecutables.has(basename(executable).toLowerCase())) {
    throw new Error(`Shell executable '${basename(executable)}' is forbidden.`);
  }
  if (/[;&|<>`\r\n]/u.test(executable)) {
    throw new Error(
      "Executable must be a plain program path, not a shell expression.",
    );
  }
  const args = [...(descriptor.config.args ?? [])];
  if (args.some((entry) => /[\r\n\0]/u.test(entry))) {
    throw new Error("Command arguments may not contain control characters.");
  }
  const cwd = resolveWithin(options.root, descriptor.config.cwd);
  assertDirectory(cwd);
  const timeoutMs = descriptor.config.timeoutMs ?? 120_000;
  const outputLimit = descriptor.config.outputLimitBytes ?? 1_048_576;
  const start = (options.now ?? Date.now)();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };

  return await new Promise<CommandResult>((resolveResult, reject) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      env: safeEnvironment(descriptor.config?.envAllowlist ?? []),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const terminate = (reason: "timeout" | "cancel"): void => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    };
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    const abort = (): void => terminate("cancel");
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) =>
      appendBounded(stdout, chunk, stdoutState, outputLimit),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      appendBounded(stderr, chunk, stderrState, outputLimit),
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      settled = true;
      reject(
        new Error(
          `Unable to start allowlisted executable '${basename(executable)}': ${redactText(error.message)}`,
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      settled = true;
      const stdoutText = redactText(Buffer.concat(stdout).toString("utf8"));
      const stderrText = redactText(Buffer.concat(stderr).toString("utf8"));
      resolveResult({
        executable: basename(executable),
        args,
        cwd,
        exitCode,
        signal,
        timedOut,
        cancelled,
        durationMs: Math.max(0, (options.now ?? Date.now)() - start),
        stdout: stdoutText,
        stderr: stderrText,
        stdoutDigest: sha256(stdoutText),
        stderrDigest: sha256(stderrText),
        truncated: stdoutState.truncated || stderrState.truncated,
      });
    });
  });
}
