#!/usr/bin/env node
/**
 * delegate-skills · devin-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Devin CLI in print mode
 * (`devin -p --prompt-file <brief>`), capture its final response and its
 * exported trajectory, and write a structured result the orchestrating agent
 * can review. The orchestrator runs this one command and reads the result
 * JSON; every devin-specific mechanic lives in here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `devin`, `git`, and Windows `taskkill` for
 * process-tree termination. The `devin` process it launches does
 * authenticate, exactly as it does at the terminal. Read this file before you
 * run it.
 *
 * The brief is handed to devin with `--prompt-file <brief.txt>`, never argv:
 * it stays out of the host process list, is not bounded by the OS arg-length
 * cap, and a brief that begins with "-" cannot be misread as a flag.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's
 * job, after it reviews the diff and re-runs the project gates.
 *
 * Permission modes (devin's own `--permission-mode`): a write run uses
 * `accept-edits` (read-only tools and workspace edits are auto-approved);
 * `--read-only` uses `auto` (only read-only tools are auto-approved). Print
 * mode cannot ask for confirmation, so devin rejects any other tool call,
 * prints a warning on stderr, and ends the run with exit 0. The relay detects
 * that rejection and reports `status: "failed"`. `--permission-mode smart` and
 * `--permission-mode dangerous` are explicit opt-ins only.
 *
 * Print mode cannot show devin's workspace trust prompt and fails in an
 * untrusted directory, so the relay always passes
 * `--respect-workspace-trust false`: dispatching to --cd is the trust decision.
 *
 * Model guard: the relay always passes `--model`, defaulting to `swe-2-high`.
 * It refuses any model outside FREE_MODELS (the exact SWE-2 ids that
 * `devin models list` tags `Free`) unless `--allow-paid` is passed, so a run
 * never spends account credits by accident. Aliases such as `swe` are not on
 * the list. The list is static: if devin's pricing changes, check
 * `devin models list` and update FREE_MODELS. FREE_UNTIL holds ids that are
 * free only through a stated day (a promotion); after it they need --allow-paid.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root and devin's cwd (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <id>            Devin model id (default: swe-2-high). Letters,
 *                           digits, and . _ : / - only.
 *   --allow-paid            Allow a model outside the free SWE-2 list
 *                           (swe-2-high, swe-2-medium, swe-2-max). Paid models
 *                           spend account credits.
 *   --read-only             Use devin's `auto` permission mode (read-only tools
 *                           only). Conflicts with any other --permission-mode.
 *   --permission-mode <m>   accept-edits (default) | auto | smart | dangerous.
 *   --session <id>          Resume a specific devin session (`-r <id>`); send
 *                           only the delta brief.
 *   --resume-last           Continue the most recent devin session for this cwd
 *                           (`-c`); send only the delta brief.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Devin has no
 *                           timeout flag; durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout:
 *   status, exitCode, signal, devinVersion, model, actualModel, allowPaid,
 *   permissionMode, readOnly, resumed, sessionId (from the exported
 *   trajectory), finalMessage (devin's printed response), usage, touchedFiles
 *   (git porcelain, null if git cannot report), and paths to brief.txt,
 *   final.txt, trajectory.json (eventsPath), and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, a paid
 * model without --allow-paid) exits 2 before any run and writes no result
 * file; a missing `devin` binary exits 127; otherwise the exit code mirrors
 * devin's own (0 success, non-zero failure), except a run that ended on a
 * rejected tool call exits 1 even though devin exits 0. If the child dies on
 * a signal, the exit code is 128 plus the signal number and `result.json`
 * records the signal. Once the brief validates, `result.json` is written on
 * every outcome: completed, failed, timeout (the --timeout watchdog fired),
 * aborted (the relay itself was killed and forwarded the kill to devin), or
 * devin_unavailable.
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
const MAX_TRAJECTORY_BYTES = 64 * 1024 * 1024;

const DEFAULT_MODEL = "swe-2-high";
// Exact ids `devin models list` tags `Free` (SWE-2 family). Everything else,
// including aliases and the paid `-lightning` variants, needs --allow-paid.
const FREE_MODELS = new Set(["swe-2-high", "swe-2-medium", "swe-2-max"]);
// Ids tagged `Free` only for a promotion: free through the given day (inclusive), then they need
// --allow-paid again until someone re-checks `devin models list`. SWE-2 Flash: free for paid Devin
// users through 2026-11-30, price after that not announced (checked 2026-11-19). SWE-2.1: free on
// paid Devin plans in the desktop app and command line through 2026-12-08, price after that not
// verified (checked 2026-11-25); its `-lightning` (Ultrafast) variants are paid from day one.
const FREE_UNTIL = new Map([
  ["swe-2-flash-medium", "2026-11-30"],
  ["swe-2-flash-high", "2026-11-30"],
  ["swe-2-flash-max", "2026-11-30"],
  ["swe-2-1-medium", "2026-12-08"],
  ["swe-2-1-high", "2026-12-08"],
  ["swe-2-1-max", "2026-12-08"],
]);
const isFree = (model, today = new Date().toLocaleDateString("en-CA")) =>
  FREE_MODELS.has(model) || (FREE_UNTIL.has(model) && today <= FREE_UNTIL.get(model));
const PERMISSION_MODES = new Set(["auto", "accept-edits", "smart", "dangerous"]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// Print mode's warning when it refuses a tool call it would have to confirm.
const REJECTION_PATTERN = /rejected a tool call that requires confirmation/i;
// The observation devin records in the trajectory for the same refusal.
const REJECTED_OBSERVATION = "Tool execution was rejected by the user";

const IMPLEMENTER_KEY = "devin";

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
    if (field === "autonomy" && (flagged.has("autonomy") || flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "agent" && (flagged.has("agent") || flagged.has("readOnly"))) continue;
    if (field === "sandbox" && (flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "permissionMode" && (flagged.has("permissionMode") || flagged.has("readOnly"))) continue;
    if (field === "planOnly" && (flagged.has("planOnly") || flagged.has("readOnly"))) continue;
    if (field === "readOnly" && (flagged.has("readOnly") || flagged.has("permissionMode"))) continue;
    if (field === "force" && flagged.has("force")) continue;
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
    model: DEFAULT_MODEL,
    allowPaid: false,
    readOnly: false,
    permissionMode: null,
    resumeLast: false,
    session: null,
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
      case "--allow-paid": opts.allowPaid = true; break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--permission-mode": opts.permissionMode = next(); flagged.add("permissionMode"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.permissionMode !== null && !PERMISSION_MODES.has(opts.permissionMode)) {
    fail(`invalid --permission-mode "${opts.permissionMode}" (expected: ${[...PERMISSION_MODES].join(", ")})`);
  }
  if (opts.readOnly && opts.permissionMode !== null && opts.permissionMode !== "auto") {
    fail(`--read-only uses devin's auto permission mode and conflicts with --permission-mode ${opts.permissionMode}`);
  }
  opts.permissionMode = opts.readOnly ? "auto" : opts.permissionMode ?? "accept-edits";
  if (opts.permissionMode === "auto") opts.readOnly = true;
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.session !== null && !opts.session.trim()) fail("--session must not be empty");
  for (const flag of ["model", "session"]) {
    if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (!isFree(opts.model) && !opts.allowPaid) {
    fail(
      `--model ${opts.model} is not on the free SWE-2 list (${[...FREE_MODELS].join(", ")}); ` +
        "it may spend Devin account credits. Pass --allow-paid to dispatch it anyway, or check `devin models list`",
    );
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
  if (!match) return "relay.mjs - dispatch a brief to devin -p\n";
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

function devinVersion(timeoutMs) {
  const limit = Math.min(timeoutMs, PROBE_TIMEOUT_MS);
  // `devin --version` prints "devin X.Y.Z (<build>)".
  try {
    const raw = execFileSync("devin", ["--version"], {
      encoding: "utf8",
      shell: false,
      timeout: limit,
      killSignal: "SIGKILL",
    }).trim();
    const firstLine = raw.split("\n")[0].trim();
    const versionMatch = firstLine.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)/);
    return { version: versionMatch ? versionMatch[1] : firstLine || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    return { version: null, error };
  }
}

function buildArgv(opts, run) {
  const argv = [
    "-p",
    "--prompt-file", run.briefPath,
    "--model", opts.model,
    "--permission-mode", opts.permissionMode,
    "--respect-workspace-trust", "false",
    "--export", run.trajectoryPath,
  ];
  if (opts.session) argv.push("-r", opts.session);
  else if (opts.resumeLast) argv.push("-c");
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
    trajectoryPath: join(outDir, "trajectory.json"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not publish another run's report or trajectory.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  rmSync(run.trajectoryPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

// Devin's `--export` writes an ATIF trajectory after each turn: session_id,
// agent metadata, steps (with tool calls and observations), final_metrics.
function readTrajectory(path) {
  const empty = { sessionId: null, actualModel: null, usage: null, rejected: false };
  try {
    if (!existsSync(path) || statSync(path).size > MAX_TRAJECTORY_BYTES) return empty;
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object") return empty;
    const steps = Array.isArray(doc.steps) ? doc.steps : [];
    let actualModel = typeof doc.agent?.model_name === "string" ? doc.agent.model_name : null;
    let rejected = false;
    for (const step of steps) {
      if (step?.source !== "agent") continue;
      if (typeof step.model_name === "string") actualModel = step.model_name;
      const results = Array.isArray(step.observation?.results) ? step.observation.results : [];
      if (results.some((entry) => entry?.content === REJECTED_OBSERVATION)) rejected = true;
    }
    return {
      sessionId: typeof doc.session_id === "string" ? doc.session_id : null,
      actualModel,
      usage: doc.final_metrics && typeof doc.final_metrics === "object" ? doc.final_metrics : null,
      rejected,
    };
  } catch {
    return empty;
  }
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "devin",
      workdir: opts.cd,
      model: opts.model,
      actualModel: null,
      allowPaid: opts.allowPaid,
      permissionMode: opts.permissionMode,
      readOnly: opts.readOnly,
      resumed: Boolean(opts.resumeLast || opts.session),
      sessionId: null,
      usage: null,
      devinVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: existsSync(run.trajectoryPath) ? run.trajectoryPath : null,
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
    status: "devin_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
  });
  printSummary(result, resultPath);
  process.stderr.write(
    "relay: `devin` not found on PATH. Install the Devin CLI, sign in with `devin auth login`, and confirm with `devin auth status`.\n",
  );
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `devin --version preflight timed out after ${Math.min(timeoutMs, PROBE_TIMEOUT_MS)}ms; devin was not dispatched`
    : `devin --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; devin was not dispatched`;
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
        error: `the relay was killed by ${sig} during the devin version preflight; devin was not dispatched`,
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

function dispatchToDevin(opts, run, writeResult, onReady) {
  // devin is a native binary: no shell on any platform, so argv reaches it
  // unchanged. The brief rides --prompt-file; --cd is the child's cwd.
  const child = spawn("devin", buildArgv(opts, run), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let stdoutText = "";
  let rejectionSeen = false;
  const stderrTail = [];
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stderrPartial = "";

  child.stdout.on("data", (chunk) => {
    stdoutText += stdoutDecoder.write(chunk);
    // Keep the tail: devin prints its final response last.
    if (stdoutText.length > MAX_BUFFERED_CHARS) stdoutText = stdoutText.slice(-MAX_BUFFERED_CHARS);
  });

  const takeStderrLine = (line) => {
    if (REJECTION_PATTERN.test(line)) rejectionSeen = true;
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

  const assembleFinal = () => {
    const message = stdoutText.trim();
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

  const trajectoryFields = () => {
    const trajectory = readTrajectory(run.trajectoryPath);
    return {
      fields: {
        actualModel: trajectory.actualModel,
        sessionId: trajectory.sessionId,
        usage: trajectory.usage,
      },
      rejected: trajectory.rejected,
    };
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
        const result = writeResult({
          status: "aborted",
          exitCode,
          signal: sig,
          ...trajectoryFields().fields,
          finalMessage: assembleFinal(),
          touchedFiles: gitTouchedFiles(opts.cd),
          stderrTail: stderrTail.slice(-20),
          error: `the relay was killed by ${sig}; devin was terminated with it. Inspect the working tree before re-dispatching`,
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

  // A grandchild that outlives devin and inherited the pipes keeps stdout/stderr open, so
  // "close" never fires and the relay waits forever, writing no result. Once devin itself is
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
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      ...trajectoryFields().fields,
      finalMessage: assembleFinal(),
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
    const trajectory = trajectoryFields();
    // Print mode exits 0 after refusing a tool call it would have had to confirm,
    // with no final response. That is a failed run, not a quiet success.
    const rejectedRun = (rejectionSeen || trajectory.rejected) && !watchdogFired;
    const succeeded = code === 0 && !watchdogFired && !rejectedRun;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const rejectionError = rejectedRun
      ? `devin rejected a tool call that needs confirmation (permission mode ${opts.permissionMode}) and ended the run. ` +
        (opts.readOnly
          ? "Read-only runs approve read-only tools only; rephrase the brief so it does not ask for edits or side-effecting commands"
          : "accept-edits approves edits made with devin's file tools and read-only commands, not shell commands that write files or run test runners. Tell devin to edit only with its file tools, run the gates yourself, or re-dispatch with an explicit --permission-mode smart or dangerous")
      : null;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      ...trajectory.fields,
      finalMessage,
      touchedFiles,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired
        ? { error: `devin did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` }
        : {}),
      ...(rejectionError ? { error: rejectionError } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const run = prepareRunDir(opts, brief);
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  let writeResult = makeResultWriter(opts, null, run);
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult);
  const probe = devinVersion(timeoutMs);
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
  dispatchToDevin(opts, run, writeResult, clearPreflightSignals);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  devin ${result.devinVersion ?? "?"}`,
  );
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push(
      "hint: the host killed the process (commonly the OOM killer or a supervisor timeout); this is not a devin error. Check host memory and re-dispatch, or split the task into smaller briefs.",
    );
  }
  if (result.signal === "SIGTERM" && result.status === "failed") {
    lines.push(
      "hint: something outside the relay terminated devin; relay watchdogs and relay signals report timeout or aborted instead.",
    );
  }
  lines.push(`model: ${result.model}${result.allowPaid ? " (--allow-paid)" : ""}${result.actualModel ? ` · reported: ${result.actualModel}` : ""}`);
  lines.push(`permission mode: ${result.permissionMode}${result.readOnly ? " (read-only)" : ""}`);
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
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
  lines.push("--- devin final report ---");
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
