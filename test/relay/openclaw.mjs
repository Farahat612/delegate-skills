import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// openclaw is an npm .cmd shim on Windows, so the .cjs fake (JSON args) serves every platform.
const readCapturedArgs = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);

export async function runOpenclaw(h) {
  const expectedArgv = (seconds, extra = []) => [
    "agent", "exec",
    "--message-file", "-",
    "--json",
    "--timeout", String(seconds),
    ...extra,
  ];

  for (const scenario of [
    { name: "default", relayArgs: [], seconds: 1800, extra: [] },
    { name: "model", relayArgs: ["--model", "openai/gpt-5.6-luna"], seconds: 1800, extra: ["--model", "openai/gpt-5.6-luna"] },
    { name: "effort", relayArgs: ["--effort", "adaptive"], seconds: 1800, extra: ["--thinking", "adaptive"] },
    { name: "timeout seconds", relayArgs: ["--timeout", "90s"], seconds: 90, extra: [] },
    { name: "timeout hours and minutes", relayArgs: ["--timeout", "1h30m"], seconds: 5400, extra: [] },
  ]) {
    const slug = scenario.name.replace(/\W+/g, "-");
    const outDir = join(h.scratch, `out-${slug}-openclaw`);
    const workDir = h.freshRepo(`work-${slug}-openclaw`);
    const argsFile = join(h.scratch, `args-${slug}-openclaw`);
    const run = spawnSync(process.execPath, [
      h.relayPath("openclaw"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...scenario.relayArgs,
    ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
    const args = readCapturedArgs(argsFile);
    h.check(`openclaw ${scenario.name}: a run with no envelope is not trusted as complete`, run.status === 1);
    h.check(`openclaw ${scenario.name}: documented argv is exact`,
      JSON.stringify(args) === JSON.stringify(expectedArgv(scenario.seconds, scenario.extra)));
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check(`openclaw ${scenario.name}: result speaks the shared schema`,
      value.schema === "delegate-relay.result.v1" &&
      value.tool === "openclaw" &&
      value.resumed === false &&
      value.readOnly === false);
  }

  // The brief streams on stdin and never rides argv. A successful run reads its report,
  // session id, model, usage, and cost from the JSON envelope; a notice line before it is skipped.
  if (!h.WIN) {
    for (const mode of ["openclaw-success", "openclaw-notice"]) {
      const outDir = join(h.scratch, `out-${mode}`);
      const workDir = h.freshRepo(`work-${mode}`);
      const argsFile = join(h.scratch, `args-${mode}`);
      const run = spawnSync(process.execPath, [
        h.relayPath("openclaw"),
        "--brief", h.briefPath,
        "--cd", workDir,
        "--out-dir", outDir,
      ], {
        env: { ...h.baseEnv, SMOKE_MODE: mode, SMOKE_ARGS_FILE: argsFile, SMOKE_WRITE_FILE: join(workDir, "hello.txt") },
        encoding: "utf8",
      });
      const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
      const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
      h.check(`${mode}: relay exits zero`, run.status === 0);
      h.check(`${mode}: brief is delivered on stdin, not argv`,
        captured.brief === readFileSync(h.briefPath, "utf8") &&
        !captured.args?.includes(readFileSync(h.briefPath, "utf8")));
      h.check(`${mode}: the child cwd is --cd`, captured.cwd && captured.cwd.endsWith(`work-${mode}`));
      h.check(`${mode}: report, session, model, usage, and cost are captured`,
        value.status === "completed" &&
        value.exitCode === 0 &&
        value.finalMessage === "fake openclaw completed" &&
        value.sessionId === "openclaw-smoke-session" &&
        value.actualModel === "openai/gpt-smoke" &&
        value.usage?.total === 7 &&
        value.costUsd === 0.001 &&
        value.eventsPath === join(outDir, "events.json") &&
        value.finalPath === join(outDir, "final.txt"));
      h.check(`${mode}: touchedFiles lists the written file`,
        Array.isArray(value.touchedFiles) && value.touchedFiles.some((line) => line.endsWith("hello.txt")));
      const head = spawnSync("git", ["-C", workDir, "rev-list", "--all", "--count"], { encoding: "utf8" });
      h.check(`${mode}: the relay did not commit`, head.stdout.trim() === "0");
    }

    for (const [mode, label, expectedExit, expectedStatus, errorPattern] of [
      ["openclaw-failed", "envelope ok:false and exit 1", 1, "failed", /provider refused/],
      ["openclaw-failed-exit0", "envelope ok:false but exit 0", 1, "failed", /provider refused/],
      ["openclaw-deadline", "openclaw's own deadline, exit 2", 2, "timeout", /own deadline \(--timeout 1800s\)/],
      ["openclaw-garbled", "exit 0 with no JSON envelope", 1, "failed", /no parseable JSON envelope/],
    ]) {
      const failedOut = join(h.scratch, `out-${mode}`);
      const failed = spawnSync(process.execPath, [
        h.relayPath("openclaw"),
        "--brief", h.briefPath,
        "--cd", h.freshRepo(`work-${mode}`),
        "--out-dir", failedOut,
      ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8" });
      const failedValue = existsSync(join(failedOut, "result.json")) ? h.result(failedOut) : {};
      h.check(`openclaw failure (${label}): never reported completed`,
        failed.status === expectedExit &&
        failedValue.status === expectedStatus &&
        failedValue.exitCode === expectedExit &&
        errorPattern.test(failedValue.error ?? "") &&
        failedValue.finalPath === null);
    }
  }

  // Lane dials apply, an explicit flag wins over them, and a readOnly lane cannot be written.
  {
    const setupDir = join(h.testDir, "..", "skills", "delegate-setup", "scripts");
    const cfgHome = join(h.scratch, "home-lane-openclaw");
    const cfgRepo = h.freshRepo("work-lane-openclaw");
    mkdirSync(cfgHome, { recursive: true });
    const laneFile = join(cfgRepo, "openclaw-lanes.json");
    writeFileSync(laneFile, `${JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { build: { implementer: "openclaw", model: "zai/glm-5.3", effort: "high", timeout: "20m" } },
    })}\n`);
    const readOnlyFile = join(cfgRepo, "openclaw-readonly.json");
    writeFileSync(readOnlyFile, `${JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "openclaw", readOnly: true } },
    })}\n`);
    const fleetEnv = { ...h.baseEnv, HOME: cfgHome, USERPROFILE: cfgHome };
    delete fleetEnv.XDG_CONFIG_HOME;
    const rejected = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", readOnlyFile], {
      encoding: "utf8",
      env: fleetEnv,
    });
    h.check("openclaw lane: a readOnly lane is refused because openclaw has no read-only flag",
      rejected.status !== 0 && /does not support readOnly/.test(`${rejected.stderr}${rejected.stdout}`));
    const writeCfg = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", laneFile], {
      encoding: "utf8",
      env: fleetEnv,
    });
    h.check("openclaw lane: global lane is written", writeCfg.status === 0);
    for (const [name, extra, model, effort, seconds] of [
      ["dials apply", [], "zai/glm-5.3", "high", "1200"],
      ["explicit flags win", ["--model", "openai/other", "--effort", "low", "--timeout", "5m"], "openai/other", "low", "300"],
    ]) {
      const slug = name.replace(/\W+/g, "-");
      const outDir = join(h.scratch, `out-lane-${slug}-openclaw`);
      const argsFile = join(h.scratch, `args-lane-${slug}-openclaw`);
      const run = spawnSync(process.execPath, [
        h.relayPath("openclaw"),
        "--brief", h.briefPath,
        "--cd", cfgRepo,
        "--out-dir", outDir,
        "--lane", "build",
        ...extra,
      ], { env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
      const args = readCapturedArgs(argsFile);
      const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
      h.check(`openclaw lane: ${name}`,
        h.pair(args, "--model", model) &&
        h.pair(args, "--thinking", effort) &&
        h.pair(args, "--timeout", seconds) &&
        value.lane === "build" &&
        value.effort === effort);
    }
  }

  // Usage errors exit 2 before any artifact or dispatch.
  const oversized = join(h.scratch, "oversized-brief-openclaw.txt");
  writeFileSync(oversized, "x".repeat(4 * 1024 * 1024 + 1));
  for (const [name, relayArgs, pattern, brief] of [
    ["read-only is refused", ["--read-only"], /no read-only flag/, h.briefPath],
    ["unknown effort", ["--effort", "turbo"], /invalid --effort/, h.briefPath],
    ["unsafe model token", ["--model", "-bad"], /unsupported characters/, h.briefPath],
    ["model with a shell metacharacter", ["--model", "a&b"], /unsupported characters/, h.briefPath],
    ["session is not offered", ["--session", "abc"], /unknown option/, h.briefPath],
    ["brief over 4 MiB", [], /larger than 4 MiB/, oversized],
  ]) {
    const slug = name.replace(/\W+/g, "-");
    const outDir = join(h.scratch, `out-usage-${slug}-openclaw`);
    const argsFile = join(h.scratch, `args-usage-${slug}-openclaw`);
    const rejected = spawnSync(process.execPath, [
      h.relayPath("openclaw"),
      "--brief", brief,
      "--cd", h.freshRepo(`work-usage-${slug}-openclaw`),
      "--out-dir", outDir,
      ...relayArgs,
    ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
    h.check(`openclaw usage: ${name} exits 2 before dispatch`,
      rejected.status === 2 && pattern.test(rejected.stderr) && !existsSync(outDir) && !existsSync(argsFile));
  }

  {
    const workDir = h.freshRepo("work-unavailable-openclaw");
    const outDir = join(h.scratch, "out-stale-unavailable-openclaw");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
    writeFileSync(join(outDir, "final.txt"), "stale final\n");
    writeFileSync(join(outDir, "events.json"), "{\"sessionId\":\"stale\"}\n");
    const missing = spawnSync(process.execPath, [
      h.relayPath("openclaw"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("openclaw unavailable: structured result replaces stale artifacts",
      missing.status === 127 &&
      value.status === "openclaw_unavailable" &&
      value.sessionId === null &&
      value.eventsPath === null &&
      !existsSync(join(outDir, "final.txt")));
  }

  if (!h.WIN) {
    const workDir = h.freshRepo("work-abort-preflight-openclaw");
    const outDir = join(h.scratch, "out-abort-preflight-openclaw");
    const preflight = h.runRelay("openclaw", workDir, outDir, ["--timeout", "1s"], {
      SMOKE_MODE: "openclaw-version-hang",
    });
    // Attach the close promise immediately so an early exit cannot miss it.
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      preflight.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    h.check("openclaw preflight abort: run artifacts are prepared",
      await h.until(() => existsSync(join(outDir, "brief.txt")), 2000));
    preflight.kill("SIGTERM");
    const didExit = await exited;
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("openclaw preflight abort: result is aborted and dispatch never starts",
      didExit &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
