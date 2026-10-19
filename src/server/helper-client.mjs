// Parent side of the PipeCom protocol: owns the license helper child process,
// correlates requests and replies by id, and restarts the helper if it dies.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HELPER_PATH = fileURLToPath(new URL("../helper/mtlib.mjs", import.meta.url));
const REQUEST_TIMEOUT_MS = 15_000;

export class HelperUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = "helper_unavailable";
  }
}

/** The helper answered, but with { ok: false, error: { code, message } }. */
export class HelperReplyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class HelperClient {
  constructor({ env = process.env, logFile = process.env.MINIMATH_PIPE_LOG } = {}) {
    this.env = env;
    this.logFile = logFile;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  log(line) {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging is diagnostic only.
    }
  }

  start() {
    if (this.child || this.closed) return;
    this.log(`Launching helper ${HELPER_PATH}`);
    const child = spawn(process.execPath, [HELPER_PATH], {
      env: this.env,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
    child.on("error", (error) => this.onExit(`spawn failed: ${error.message}`));
    child.on("exit", (code, signal) => this.onExit(`exited (code ${code}, signal ${signal})`));
    // First message, as in MathType: tell the helper whom to watch.
    this.send({ command: "setParentPID", parentPID: process.pid }).catch(() => {});
  }

  onLine(line) {
    this.log(`Received: ${line}`);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new HelperReplyError(message.error?.code ?? "helper_error", message.error?.message ?? "helper error"));
  }

  onExit(reason) {
    if (!this.child) return;
    this.log(`Helper ${reason}`);
    this.child = null;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new HelperUnavailableError(`License helper ${reason}`));
    }
    this.pending.clear();
  }

  /** Send one command; the helper is (re)started on demand. */
  send(message) {
    if (this.closed) return Promise.reject(new HelperUnavailableError("License helper has been shut down"));
    this.start();
    const id = this.nextId++;
    const line = JSON.stringify({ ...message, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperUnavailableError(`License helper did not answer ${message.command} in time`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.log(`Sending: ${line}`);
      this.child.stdin.write(`${line}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new HelperUnavailableError(`Could not write to license helper: ${error.message}`));
        }
      });
    });
  }

  /** Ask the helper to flush and exit; fall back to closing its stdin. */
  async close() {
    if (this.closed) return;
    const child = this.child;
    if (child) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        await Promise.race([this.send({ command: "shutdown" }), new Promise((r) => setTimeout(r, 3_000))]);
      } catch {
        // Already gone.
      }
      this.closed = true;
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 5_000);
      await exited;
      clearTimeout(timeout);
    }
    this.closed = true;
  }
}
