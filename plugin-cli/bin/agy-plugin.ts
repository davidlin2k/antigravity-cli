#!/usr/bin/env node
import os from "node:os";
import { runCli } from "../src/cli/index.ts";
import { createNodeTerminal } from "../src/tui/terminal.ts";

const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  homeDir: os.homedir(),
  env: process.env,
  isTTY,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  terminal: isTTY ? createNodeTerminal() : undefined,
});

process.exitCode = exitCode;
