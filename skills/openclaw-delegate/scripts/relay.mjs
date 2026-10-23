#!/usr/bin/env node
/**
 * delegate-skills · openclaw-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to OpenClaw's headless embedded agent
 * (`openclaw agent exec --message-file - --json`), capture its JSON envelope
 * and final response, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON;
 * every openclaw-specific mechanic lives in here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `openclaw`, `git`, and Windows `where.exe` and
 * `taskkill` for the npm shim lookup and process-tree termination. The
 * `openclaw` process it launches does authenticate and does reach its
 * configured model provider, exactly as it does at the terminal. Read this file
 * before you run it.
 *
 * The brief is streamed to openclaw on stdin (`--message-file -`), never argv:
 * it stays out of the host process list, is not bounded by the OS arg-length
 * cap, and nothing in it is shell-interpreted or read as a flag. OpenClaw caps
 * a message file at 4 MiB, so the relay refuses a larger brief before dispatch.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's
 * job, after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: `agent exec` runs OpenClaw's `coding` tool profile with the agent
 * sandbox off, filesystem tools restricted to the working directory, and the
 * execution policy a headless turn needs, unless the user's own OpenClaw config
 * sets otherwise (config the user set wins over those defaults). A shell command
 * the agent runs is not confined to the working directory. The relay has no
 * `--read-only`: the installed `agent exec` has no read-only flag, so the relay
 * refuses the flag rather than imply a guarantee. Workspace files such as
 * AGENTS.md are injected as normal.
 *
 * Account home: OpenClaw keeps its config and logins under `$OPENCLAW_STATE_DIR`
 * and `$OPENCLAW_CONFIG_PATH` (default `~/.openclaw`), or `~/.openclaw-<name>`
 * for `openclaw --profile <name>`. The relay passes its environment through
 * unchanged, so exporting those variables before the relay selects the account.
 * The relay never reads or writes that directory. `agent exec` keeps no session
 * between runs (it uses a temporary state directory it removes afterwards), so
 * the relay offers no resume; `sessionId` in the result is informational.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root and openclaw's cwd, which `agent exec` uses as
 *                           both the agent workspace and the tool working directory
 *                           (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <id>            OpenClaw model as provider/model (e.g. openai/gpt-5.6-luna).
 *                           Default: OpenClaw's own configured model. Letters, digits,
 *                           and . _ : / - only.
 *   --effort <level>        Thinking level, passed as `--thinking`: off | minimal | low |
 *                           medium | high | xhigh | adaptive | max | ultra (where the
 *                           model supports it).
 *   --timeout <dur>         Relay-side watchdog (default: 30m); h/m/s strings. The same
 *                           budget is passed to openclaw as `--timeout <seconds>` so its
 *                           own 600-second default does not cut a longer run short.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout:
 *   status, exitCode, signal, openclawVersion, model, actualModel, effort,
 *   sessionId (from the JSON envelope), finalMessage (the envelope's final text),
 *   usage and costUsd (from the envelope), touchedFiles (git porcelain, null if
 *   git cannot report), and paths to brief.txt, final.txt, events.json
 *   (eventsPath, the raw envelope), and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty or oversized
 * brief, --read-only) exits 2 before any run and writes no result file; a
 * missing `openclaw` binary exits 127; otherwise the exit code mirrors
 * openclaw's own (0 success, 1 a model or result error, 2 its own deadline),
 * except a run whose envelope reports failure or that ended without a parseable
 * envelope exits 1 even if openclaw exits 0. If the child dies on a signal, the
 * exit code is 128 plus the signal number and `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome:
 * completed, failed, timeout (the --timeout watchdog or openclaw's own deadline
 * fired), aborted (the relay itself was killed and forwarded the kill to
 * openclaw), or openclaw_unavailable.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const MAX_BUFFERED_CHARS = 1_048_576;

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const PROBE_TIMEOUT_MS = 10_000;
// The JSON envelope is one object, so truncating it would make it unparseable.
const MAX_ENVELOPE_CHARS = 16 * 1024 * 1024;
const MAX_BRIEF_BYTES = 4 * 1024 * 1024;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"]);
// --model reaches a shell on win32 (shell:true for the npm .cmd shim), so it is
// restricted to safe tokens.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// openclaw's own deadline (`--timeout`) ends the process with this status.
const OPENCLAW_TIMEOUT_EXIT = 2;

const IMPLEMENTER_KEY = "openclaw";

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the delegate-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
    { encoding: "utf8", env: process.env },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    if (flagged.has(field)) continue;
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    timeout: DEFAULT_TIMEOUT,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--read-only":
        fail("openclaw agent exec has no read-only flag, so the relay does not offer --read-only; route read-only work to an implementer that has one");
        break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.model !== null && !SAFE_TOKEN.test(opts.model)) {
    fail("--model value contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.effort !== null && !THINKING_LEVELS.has(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: ${[...THINKING_LEVELS].join(", ")})`);
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a positive schedulable duration; use h/m/s strings like 30m, 90s, or 1h30m (maximum ~24.8 days)`);
  }
  try {
    if (!statSync(opts.cd).isDirectory()) fail(`--cd is not a directory: ${opts.cd}`);
  } catch {
    fail(`--cd directory not found: ${opts.cd}`);
  }
  if (opts.outDir && existsSync(opts.outDir)) {
    try {
      if (!statSync(opts.outDir).isDirectory()) fail(`--out-dir is not a directory: ${opts.outDir}`);
    } catch {
      fail(`cannot inspect --out-dir: ${opts.outDir}`);
    }
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to openclaw agent exec\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n +
      BigInt(match[2] || 0) * 60n +
      BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function openclawVersion(timeoutMs) {
  const limit = Math.min(timeoutMs, PROBE_TIMEOUT_MS);
  // `openclaw --version` prints "OpenClaw X.Y.Z (<build>)".
  const options = { encoding: "utf8", timeout: limit, killSignal: "SIGKILL" };
  try {
    let raw;
    if (process.platform === "win32") {
      // shell:true resolves the npm openclaw.cmd shim, but a missing command is only an exit 1
      // from cmd.exe. Ask the in-box where.exe first so absence stays openclaw_unavailable.
      const wherePath = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "where.exe");
      try {
        execFileSync(wherePath, ["openclaw"], { ...options, stdio: ["ignore", "ignore", "ignore"] });
      } catch (error) {
        if (error?.code === "ETIMEDOUT") throw error;
        return { version: null, error: null };
      }
      raw = execFileSync("openclaw --version", { ...options, shell: true }).trim();
    } else {
      raw = execFileSync("openclaw", ["--version"], { ...options, shell: false }).trim();
    }
    const firstLine = raw.split("\n")[0].trim();
    const versionMatch = firstLine.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)/);
    return { version: versionMatch ? versionMatch[1] : firstLine || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    return { version: null, error };
  }
}

function buildArgv(opts) {
  const seconds = Math.ceil((parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT)) / 1000);
  const argv = [
    "agent", "exec",
    "--message-file", "-",
    "--json",
    "--timeout", String(seconds),
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--thinking", opts.effort);
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir =
    opts.outDir ||
    join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.json"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not publish another run's report or envelope.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  rmSync(run.eventsPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

// The envelope is the whole of stdout in --json mode. Tolerate a notice line before
// it: if the whole text does not parse, take the last line that is a JSON object.
function parseEnvelope(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const attempts = [trimmed, ...trimmed.split("\n").reverse().map((line) => line.trim()).filter((line) => line.startsWith("{"))];
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function envelopeFields(envelope) {
  if (!envelope) return { actualModel: null, sessionId: null, usage: null, costUsd: null };
  const provider = typeof envelope.provider === "string" ? envelope.provider : null;
  const model = typeof envelope.model === "string" ? envelope.model : null;
  return {
    actualModel: model ? (provider && !model.includes("/") ? `${provider}/${model}` : model) : null,
    sessionId: typeof envelope.sessionId === "string" ? envelope.sessionId : null,
    usage: envelope.usage && typeof envelope.usage === "object" ? envelope.usage : null,
    costUsd: typeof envelope.costUsd === "number" ? envelope.costUsd : null,
  };
}

function envelopeError(envelope) {
  if (!envelope) return null;
  const error = envelope.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = [error.type || error.kind, error.message].filter((part) => typeof part === "string" && part).join(": ");
    if (message) return message;
  }
  return envelope.ok === false ? `envelope ok:false (status ${envelope.status ?? "unknown"})` : null;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "openclaw",
      workdir: opts.cd,
      model: opts.model,
      actualModel: null,
      effort: opts.effort,
      autonomy: "agent exec defaults: coding tool profile, sandbox off unless the user's config enables it",
      readOnly: false,
      resumed: false,
      sessionId: null,
      usage: null,
      costUsd: null,
      openclawVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: existsSync(run.eventsPath) ? run.eventsPath : null,
      stderrPath: run.stderrPath,
      ...extra,
    };
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(opts, writeResult, resultPath) {
  const result = writeResult({
    status: "openclaw_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
  });
  printSummary(result, resultPath);
  process.stderr.write(
    "relay: `openclaw` not found on PATH. Install OpenClaw (`npm install -g openclaw`), configure a model provider with `openclaw configure`, and confirm with `openclaw models status`.\n",
  );
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `openclaw --version preflight timed out after ${Math.min(timeoutMs, PROBE_TIMEOUT_MS)}ms; openclaw was not dispatched`
    : `openclaw --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; openclaw was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function installPreflightSignalHandlers(opts, run, writeResult) {
  let active = true;
  const handlers = new Map();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (!active) return;
      active = false;
      const result = writeResult({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the openclaw version preflight; openclaw was not dispatched`,
      });
      printSummary(result, run.resultPath);
      process.exit(result.exitCode);
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return () => {
    active = false;
    for (const [sig, handler] of handlers) process.off(sig, handler);
  };
}

function spawnShellLaunch(binary, argv, options, useShell) {
  if (!useShell) return spawn(binary, argv, options);
  // Node 24 warns when shell:true is paired with an args array. The args here are
  // fixed flag names, a token-validated --model, and numeric values, so serialize once.
  return spawn([binary, ...argv].join(" "), { ...options, shell: true });
}

function dispatchToOpenclaw(opts, brief, run, writeResult, onReady) {
  // shell:true on win32 so the openclaw.cmd shim resolves. Safe: the brief is fed via
  // stdin, never argv, and argv holds only fixed flag names and token-validated values.
  const child = spawnShellLaunch("openclaw", buildArgv(opts), {
    cwd: opts.cd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  }, process.platform === "win32");

  // A child that exits before reading the brief closes the pipe; that is its verdict to
  // report, not a relay crash.
  child.stdin.on("error", () => {});
  child.stdin.end(brief, "utf8");

  let stdoutText = "";
  let stdoutTruncated = false;
  const stderrTail = [];
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stderrPartial = "";

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    if (stdoutText.length < MAX_ENVELOPE_CHARS) stdoutText += stdoutDecoder.write(chunk);
    else stdoutTruncated = true;
  });

  const takeStderrLine = (line) => {
    if (line.trim()) stderrTail.push(line.trimEnd());
    while (stderrTail.length > 20) stderrTail.shift();
  };
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    const lines = (stderrPartial + stderrDecoder.write(chunk)).split("\n");
    stderrPartial = lines.pop() ?? "";
    if (stderrPartial.length > MAX_BUFFERED_CHARS) stderrPartial = stderrPartial.slice(-MAX_BUFFERED_CHARS);
    for (const line of lines) takeStderrLine(line);
  });

  let envelope = null;
  const assembleFinal = () => {
    envelope = stdoutTruncated ? null : parseEnvelope(stdoutText);
    const message = typeof envelope?.final === "string" ? envelope.final.trim() : "";
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.once("exit", () => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
    killChild(child);
    sigkillTimer = setTimeout(() => {
      if (!settled) killChild(child, "SIGKILL");
    }, 10_000);
  }, timeoutMs);

  const clearWatchdog = () => {
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const exitCode = 128 + (constants.signals[sig] || 15);
      let finalized = false;
      const finishAbort = () => {
        if (finalized) return;
        finalized = true;
        if (sigkillTimer) clearTimeout(sigkillTimer);
        killChild(child, "SIGKILL");
        stdoutText += stdoutDecoder.end();
        const finalMessage = assembleFinal();
        const result = writeResult({
          status: "aborted",
          exitCode,
          signal: sig,
          ...envelopeFields(envelope),
          finalMessage,
          touchedFiles: gitTouchedFiles(opts.cd),
          stderrTail: stderrTail.slice(-20),
          error: `the relay was killed by ${sig}; openclaw was terminated with it. Inspect the working tree before re-dispatching`,
        });
        printSummary(result, run.resultPath);
        process.exit(exitCode);
      };
      child.once("exit", finishAbort);
      killChild(child);
      sigkillTimer = setTimeout(finishAbort, 2000);
    });
  }
  onReady();

  // A grandchild that outlives openclaw and inherited the pipes keeps stdout/stderr open, so
  // "close" never fires and the relay waits forever, writing no result. Once openclaw itself is
  // gone the pipes hold nothing we still need, so drop them after a short drain grace and let
  // "close" run.
  child.once("exit", () => {
    // The implementer already exited. Leaving the watchdog armed lets a drain that
    // overlaps the remaining budget fire, set watchdogFired, and report timeout.
    if (!watchdogFired) clearWatchdog();
    const drain = setTimeout(() => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500);
    if (typeof drain.unref === "function") drain.unref();
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    stdoutText += stdoutDecoder.end();
    const finalMessage = assembleFinal();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      ...envelopeFields(envelope),
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    if (watchdogFired) killChild(child, "SIGKILL");
    stdoutText += stdoutDecoder.end();
    const stderrEnd = stderrPartial + stderrDecoder.end();
    if (stderrEnd) takeStderrLine(stderrEnd);
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    // The envelope is openclaw's own verdict. It can report failure while the
    // process exits 0, and a run with no parseable envelope proves nothing.
    const reportedError = envelopeError(envelope);
    const ownDeadline = code === OPENCLAW_TIMEOUT_EXIT && !watchdogFired;
    const succeeded = code === 0 && !watchdogFired && envelope !== null && !reportedError;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    let error = null;
    if (watchdogFired) {
      error = `openclaw did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`;
    } else if (ownDeadline) {
      error = `openclaw's own deadline (--timeout ${Math.ceil(timeoutMs / 1000)}s) elapsed and it ended the run${reportedError ? `: ${reportedError}` : ""}`;
    } else if (reportedError) {
      error = `openclaw reported a failed run: ${reportedError}`;
    } else if (code === 0 && envelope === null) {
      error = stdoutTruncated
        ? "openclaw exited 0 but its JSON envelope exceeded the relay buffer, so the run is not trusted as complete"
        : "openclaw exited 0 but printed no parseable JSON envelope, so the run is not trusted as complete";
    }
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired || ownDeadline ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      ...envelopeFields(envelope),
      finalMessage,
      touchedFiles,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(error ? { error } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  if (Buffer.byteLength(brief, "utf8") > MAX_BRIEF_BYTES) {
    fail("brief is larger than 4 MiB, the most openclaw reads from a message file; shorten it");
  }

  const run = prepareRunDir(opts, brief);
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  let writeResult = makeResultWriter(opts, null, run);
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult);
  const probe = openclawVersion(timeoutMs);
  // execFileSync defers JS signal handlers; yield once so a signal received
  // during the bounded preflight becomes "aborted" before any dispatch.
  await new Promise((resolve) => setImmediate(resolve));
  writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    return reportUnavailable(opts, writeResult, run.resultPath);
  }
  if (probe.error) {
    clearPreflightSignals();
    return reportVersionFailure(opts, writeResult, run, probe.error, timeoutMs);
  }
  dispatchToOpenclaw(opts, brief, run, writeResult, clearPreflightSignals);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  openclaw ${result.openclawVersion ?? "?"}`,
  );
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push(
      "hint: the host killed the process (commonly the OOM killer or a supervisor timeout); this is not an openclaw error. Check host memory and re-dispatch, or split the task into smaller briefs.",
    );
  }
  if (result.signal === "SIGTERM" && result.status === "failed") {
    lines.push(
      "hint: something outside the relay terminated openclaw; relay watchdogs and relay signals report timeout or aborted instead.",
    );
  }
  lines.push(
    `model: ${result.model ?? "(openclaw default)"}${result.actualModel ? ` · reported: ${result.actualModel}` : ""}${result.effort ? ` · thinking: ${result.effort}` : ""}`,
  );
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.sessionId) lines.push(`session id (informational, agent exec keeps no session to resume): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- openclaw final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push(
    "relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
