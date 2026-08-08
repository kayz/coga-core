#!/usr/bin/env node

import { resolve } from "node:path";
import { createWorkbenchServer } from "./server.js";

const usage = `Usage:
  coga-workbench --profile <path> [--state <directory>] [--binding <path> ...] [--port <1024-65535>]`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

async function main(args: string[]): Promise<void> {
  const profile = option(args, "--profile");
  if (!profile) throw new Error(usage);
  const state = option(args, "--state");
  const portText = option(args, "--port");
  const port = portText === undefined ? 4376 : Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("--port is invalid.");
  const bindingPaths = options(args, "--binding").map((path) => resolve(path));
  const running = await createWorkbenchServer({
    profilePath: resolve(profile),
    port,
    ...(state ? { stateDirectory: resolve(state) } : {}),
    ...(bindingPaths.length ? { bindingPaths } : {}),
  });
  process.stdout.write(`COGA Workbench: ${running.url}\n`);
  process.stdout.write(
    "Local-only governance surface. Production release capability: absent.\n",
  );
  const close = async (): Promise<void> => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
