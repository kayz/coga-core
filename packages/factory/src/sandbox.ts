import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ProcessResult,
  SandboxEvidence,
  SandboxRequest,
  SandboxRunner,
} from "./types.js";
import {
  compareText,
  runChecked,
  runProcess,
  sanitizeIdentifier,
} from "./utils.js";

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,100}$/;

export class DockerSandbox implements SandboxRunner {
  evidence(image: string): SandboxEvidence {
    if (!IMAGE_PATTERN.test(image)) {
      throw new Error(
        "Factory sandbox image must be pinned by an exact sha256 digest.",
      );
    }
    return {
      runner: { id: "coga.docker.sandbox", version: "1" },
      image,
      isolation: "docker",
      network: "none",
      rootFilesystem: "read-only",
      repositoryMount: "read-only",
      credentialAccess: "none",
      user: "1000:1000",
      limits: { pids: 64, memoryBytes: 512 * 1024 * 1024, cpus: 1 },
    };
  }

  async run(request: SandboxRequest): Promise<ProcessResult> {
    this.evidence(request.image);
    const name = `coga-factory-${sanitizeIdentifier(request.name)}`;
    await runChecked(
      "docker",
      ["image", "inspect", request.image],
      {
        cwd: request.workspacePath,
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      },
      "Docker image preflight",
    );
    if (request.outputPath) mkdirSync(request.outputPath, { recursive: true });

    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--mount",
      `type=bind,source=${resolve(request.workspacePath)},target=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--env",
      "CI=1",
      "--env",
      "HOME=/tmp",
      "--env",
      "NO_COLOR=1",
    ];
    if (request.outputPath) {
      args.push(
        "--mount",
        `type=bind,source=${resolve(request.outputPath)},target=/output`,
      );
    }
    for (const [key, value] of Object.entries(request.env ?? {}).sort(
      ([left], [right]) => compareText(left, right),
    )) {
      if (!ENV_NAME_PATTERN.test(key) || value.includes("\0")) {
        throw new Error(`Unsafe sandbox environment entry '${key}'.`);
      }
      args.push("--env", `${key}=${value}`);
    }
    args.push(request.image, ...request.args);

    const result = await runProcess("docker", args, {
      cwd: request.workspacePath,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        DOCKER_HOST: process.env.DOCKER_HOST,
      },
    });
    if (result.timedOut) {
      await runProcess("docker", ["rm", "--force", name], {
        cwd: request.workspacePath,
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
    }
    return result;
  }
}
