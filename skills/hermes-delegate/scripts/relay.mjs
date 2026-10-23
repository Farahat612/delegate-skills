#!/usr/bin/env node
/**
 * delegate-skills · hermes-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Hermes Agent in single-query mode
 * (`hermes chat --query-file <brief> -Q --format stream-json`), capture its
 * event stream and final response, and write a structured result the
 * orchestrating agent can review. The orchestrator runs this one command and
 * reads the result JSON; every hermes-specific mechanic lives in here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `hermes`, `git`, and Windows `taskkill` for
 * process-tree termination. The `hermes` process it launches does
 * authenticate and does reach its configured model provider, exactly as it does
 * at the terminal. Read this file before you run it.
 *
 * The brief is handed to hermes with `--query-file <brief.txt>`, never argv:
 * it stays out of the host process list, is not bounded by the OS arg-length
 * cap, and nothing in it is shell-interpreted or read as a flag.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's
 * job, after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: Hermes has no sandbox and no read-only mode. A run edits files and
 * runs shell commands with the user's own permissions. Single-query mode has
 * nobody to answer an approval prompt, so Hermes itself blocks the commands its
 * dangerous-command patterns match (recursive deletes and the like) unless
 * `approvals.single_query_mode: approve` is set in its config; the relay does
 * not touch that config. `--yolo` is an explicit per-dispatch opt-in that
 * passes Hermes's own `--yolo` and bypasses those prompts entirely. The relay
 * has no `--read-only`: Hermes cannot enforce one, so it refuses the flag
 * rather than imply a guarantee. Hermes also loads its tools, memory, rules,
 * and the AGENTS.md in the working directory as normal.
 *
 * Account home: Hermes keeps its login, config, and sessions under
 * `$HERMES_HOME` (default `~/.hermes`). The relay passes its environment
 * through unchanged, so exporting `HERMES_HOME` before the relay selects the
 * account. The relay never reads or writes that directory.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root; hermes runs with `--in <dir>` and this cwd
 *                           (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <id>            Hermes model id (e.g. glm-5.2). Default: Hermes's own
 *                           configured model and fallback chain. Letters, digits,
 *                           and . _ : / - only.
 *   --provider <name>       Hermes inference provider (e.g. zai). Default: Hermes's
 *                           own configuration. Same character set as --model.
 *   --effort <level>        Reasoning effort, passed as `--reasoning`: none | minimal |
 *                           low | medium | high | xhigh | max | ultra.
 *   --yolo                  Pass Hermes's `--yolo`: bypass its dangerous-command
 *                           approval prompts. Opt-in only.
 *   --session <id>          Resume a specific hermes session (`--resume <id>`); send
 *                           only the delta brief.
 *   --resume-last           Resume the most recent hermes session for this directory
 *                           (`--resume latest`); send only the delta brief.
 *   --timeout <dur>         Relay-side watchdog (default: 30m); h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout:
 *   status, exitCode, signal, hermesVersion, model, provider, effort, yolo,
 *   resumed, sessionId (from the stream-json init and result events),
 *   finalMessage (the result event's text), usage (its token counts),
 *   touchedFiles (git porcelain, null if git cannot report), and paths to
 *   brief.txt, final.txt, events.jsonl (eventsPath), and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, --read-only)
 * exits 2 before any run and writes no result file; a missing `hermes` binary
 * exits 127; otherwise the exit code mirrors hermes's own (0 success, non-zero
 * failure), except a run whose result event reports failure or that ended
 * without a result event exits 1 even if hermes exits 0. If the child dies on a
 * signal, the exit code is 128 plus the signal number and `result.json`
 * records the signal. Once the brief validates, `result.json` is written on
 * every outcome: completed, failed, timeout (the --timeout watchdog fired),
 * aborted (the relay itself was killed and forwarded the kill to hermes), or
 * hermes_unavailable.
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

const EFFORT_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// Hermes prints `session_id: <id>` on stderr when a single-query run ends.
const STDERR_SESSION = /^session_id:\s*(\S+)/m;

const IMPLEMENTER_KEY = "hermes";

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
    provider: null,
    effort: null,
    yolo: false,
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
      case "--provider": opts.provider = next(); flagged.add("provider"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--yolo": opts.yolo = true; break;
      case "--read-only":
        fail("hermes has no read-only mode or sandbox, so the relay does not offer --read-only; route read-only work to an implementer that has one");
        break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.session !== null && !opts.session.trim()) fail("--session must not be empty");
  for (const flag of ["model", "provider", "session"]) {
    if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (opts.effort !== null && !EFFORT_LEVELS.has(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: ${[...EFFORT_LEVELS].join(", ")})`);
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
  if (!match) return "relay.mjs - dispatch a brief to hermes chat\n";
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

function hermesVersion(timeoutMs) {
  const limit = Math.min(timeoutMs, PROBE_TIMEOUT_MS);
  // `hermes --version` prints "Hermes Agent vX.Y.Z+<build> (<date>) ..." and then
  // install details, so only the first line is read.
  try {
    const raw = execFileSync("hermes", ["--version"], {
      encoding: "utf8",
      shell: false,
      timeout: limit,
      killSignal: "SIGKILL",
    }).trim();
    const firstLine = raw.split("\n")[0].trim();
    const versionMatch = firstLine.match(/(\d+\.\d+\.\d+(?:\+[A-Za-z0-9._-]+)?)/);
    return { version: versionMatch ? versionMatch[1] : firstLine || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    return { version: null, error };
  }
}

function buildArgv(opts, run) {
  const argv = [
    "chat",
    "--query-file", run.briefPath,
    "-Q",
    "--format", "stream-json",
    "--in", opts.cd,
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.provider) argv.push("--provider", opts.provider);
  if (opts.effort) argv.push("--reasoning", opts.effort);
  if (opts.yolo) argv.push("--yolo");
  if (opts.session) argv.push("--resume", opts.session);
  else if (opts.resumeLast) argv.push("--resume", "latest");
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
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not publish another run's report or events.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  rmSync(run.eventsPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "hermes",
      workdir: opts.cd,
      model: opts.model,
      provider: opts.provider,
      effort: opts.effort,
      yolo: opts.yolo,
      autonomy: opts.yolo ? "--yolo (dangerous-command approvals bypassed)" : "single-query guard (dangerous commands blocked)",
      readOnly: false,
      resumed: Boolean(opts.resumeLast || opts.session),
      sessionId: null,
      usage: null,
      hermesVersion: version,
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
    status: "hermes_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
  });
  printSummary(result, resultPath);
  process.stderr.write(
    "relay: `hermes` not found on PATH. Install Hermes Agent, sign in with `hermes model` (or `hermes auth add <provider>`), and confirm with `hermes status`.\n",
  );
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `hermes --version preflight timed out after ${Math.min(timeoutMs, PROBE_TIMEOUT_MS)}ms; hermes was not dispatched`
    : `hermes --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; hermes was not dispatched`;
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
        error: `the relay was killed by ${sig} during the hermes version preflight; hermes was not dispatched`,
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

function dispatchToHermes(opts, run, writeResult, onReady) {
  // hermes is a native launcher: no shell on any platform, so argv reaches it
  // unchanged. The brief rides --query-file; --cd is the child's cwd and --in.
  const child = spawn("hermes", buildArgv(opts, run), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  // stream-json is one JSON object per line, but hermes also prints plain notices
  // (provider fallbacks, toolset warnings) on stdout, so a line that does not
  // parse is skipped rather than treated as a protocol error.
  let sessionId = null;
  let resultEvent = null;
  let stdoutPartial = "";
  const stderrTail = [];
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stderrPartial = "";
  let stderrAll = "";

  const takeStdoutLine = (line) => {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (typeof event.session_id === "string" && event.session_id) sessionId = event.session_id;
    if (event.type === "result") resultEvent = event;
  };
  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    const lines = (stdoutPartial + stdoutDecoder.write(chunk)).split("\n");
    stdoutPartial = lines.pop() ?? "";
    if (stdoutPartial.length > MAX_BUFFERED_CHARS) stdoutPartial = stdoutPartial.slice(-MAX_BUFFERED_CHARS);
    for (const line of lines) takeStdoutLine(line);
  });

  const takeStderrLine = (line) => {
    if (line.trim()) stderrTail.push(line.trimEnd());
    while (stderrTail.length > 20) stderrTail.shift();
  };
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    const decoded = stderrDecoder.write(chunk);
    stderrAll = (stderrAll + decoded).slice(-MAX_BUFFERED_CHARS);
    const lines = (stderrPartial + decoded).split("\n");
    stderrPartial = lines.pop() ?? "";
    if (stderrPartial.length > MAX_BUFFERED_CHARS) stderrPartial = stderrPartial.slice(-MAX_BUFFERED_CHARS);
    for (const line of lines) takeStderrLine(line);
  });

  const assembleFinal = () => {
    const message = typeof resultEvent?.text === "string" ? resultEvent.text.trim() : "";
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };
  const sessionFields = () => {
    const fromStderr = STDERR_SESSION.exec(stderrAll);
    return {
      sessionId: sessionId ?? (fromStderr ? fromStderr[1] : null),
      usage: resultEvent?.tokens && typeof resultEvent.tokens === "object" ? resultEvent.tokens : null,
    };
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
        const result = writeResult({
          status: "aborted",
          exitCode,
          signal: sig,
          ...sessionFields(),
          finalMessage: assembleFinal(),
          touchedFiles: gitTouchedFiles(opts.cd),
          stderrTail: stderrTail.slice(-20),
          error: `the relay was killed by ${sig}; hermes was terminated with it. Inspect the working tree before re-dispatching`,
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

  // A grandchild that outlives hermes and inherited the pipes keeps stdout/stderr open, so
  // "close" never fires and the relay waits forever, writing no result. Once hermes itself is
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
      ...sessionFields(),
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
    const stdoutEnd = stdoutPartial + stdoutDecoder.end();
    if (stdoutEnd) takeStdoutLine(stdoutEnd);
    const stderrEnd = stderrPartial + stderrDecoder.end();
    if (stderrEnd) {
      stderrAll += stderrEnd;
      takeStderrLine(stderrEnd);
    }
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    // The result event is hermes's own verdict. It can report failure while the
    // process exits 0, and a run that ends with no result event proves nothing.
    const resultExit = resultEvent === null ? null : Number(resultEvent.exit_code);
    const resultFailed = resultEvent !== null && (resultExit !== 0 || Boolean(resultEvent.error));
    const succeeded = code === 0 && !watchdogFired && resultEvent !== null && !resultFailed;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? (Number.isInteger(resultExit) && resultExit !== 0 ? resultExit : 1) : mapped;
    let error = null;
    if (watchdogFired) {
      error = `hermes did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`;
    } else if (resultFailed) {
      error = `hermes reported a failed run: ${resultEvent.error || `result exit_code ${resultEvent.exit_code}`}`;
    } else if (!succeeded && resultEvent === null && code === 0) {
      error = "hermes exited 0 but emitted no result event, so the run is not trusted as complete";
    }
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      ...sessionFields(),
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

  const run = prepareRunDir(opts, brief);
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  let writeResult = makeResultWriter(opts, null, run);
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult);
  const probe = hermesVersion(timeoutMs);
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
  dispatchToHermes(opts, run, writeResult, clearPreflightSignals);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  hermes ${result.hermesVersion ?? "?"}`,
  );
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push(
      "hint: the host killed the process (commonly the OOM killer or a supervisor timeout); this is not a hermes error. Check host memory and re-dispatch, or split the task into smaller briefs.",
    );
  }
  if (result.signal === "SIGTERM" && result.status === "failed") {
    lines.push(
      "hint: something outside the relay terminated hermes; relay watchdogs and relay signals report timeout or aborted instead.",
    );
  }
  lines.push(
    `model: ${result.model ?? "(hermes default)"}${result.provider ? ` · provider: ${result.provider}` : ""}${result.effort ? ` · reasoning: ${result.effort}` : ""}`,
  );
  lines.push(`autonomy: ${result.autonomy}`);
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
  lines.push("--- hermes final report ---");
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
