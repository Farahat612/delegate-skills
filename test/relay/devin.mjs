import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The native Windows fake writes captured args one per line; the .cjs fake writes JSON.
const readCapturedArgs = (h, file) => {
  if (!existsSync(file)) return [];
  return h.WIN
    ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
    : JSON.parse(readFileSync(file, "utf8"));
};

export async function runDevin(h) {
  const expectedArgv = (outDir, model, permissionMode, resume = []) => [
    "-p",
    "--prompt-file", join(outDir, "brief.txt"),
    "--model", model,
    "--permission-mode", permissionMode,
    "--respect-workspace-trust", "false",
    "--export", join(outDir, "trajectory.json"),
    ...resume,
  ];

  for (const scenario of [
    { name: "default", relayArgs: [], model: "swe-2-high", permissionMode: "accept-edits", readOnly: false, resume: [] },
    { name: "read only", relayArgs: ["--read-only"], model: "swe-2-high", permissionMode: "auto", readOnly: true, resume: [] },
    { name: "explicit auto", relayArgs: ["--permission-mode", "auto"], model: "swe-2-high", permissionMode: "auto", readOnly: true, resume: [] },
    { name: "free model", relayArgs: ["--model", "swe-2-medium"], model: "swe-2-medium", permissionMode: "accept-edits", readOnly: false, resume: [] },
    { name: "paid model allowed", relayArgs: ["--model", "fake-paid-model", "--allow-paid"], model: "fake-paid-model", permissionMode: "accept-edits", readOnly: false, resume: [] },
    { name: "smart", relayArgs: ["--permission-mode", "smart"], model: "swe-2-high", permissionMode: "smart", readOnly: false, resume: [] },
    { name: "session", relayArgs: ["--session", "smoke-session"], model: "swe-2-high", permissionMode: "accept-edits", readOnly: false, resume: ["-r", "smoke-session"] },
    { name: "resume last", relayArgs: ["--resume-last"], model: "swe-2-high", permissionMode: "accept-edits", readOnly: false, resume: ["-c"] },
  ]) {
    const outDir = join(h.scratch, `out-${scenario.name}-devin`);
    const workDir = h.freshRepo(`work-${scenario.name}-devin`);
    const argsFile = join(h.scratch, `args-${scenario.name}-devin`);
    const run = spawnSync(process.execPath, [
      h.relayPath("devin"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...scenario.relayArgs,
    ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
    const args = readCapturedArgs(h, argsFile);
    h.check(`devin ${scenario.name}: relay exits zero`, run.status === 0);
    h.check(`devin ${scenario.name}: documented argv is exact`,
      JSON.stringify(args) === JSON.stringify(expectedArgv(outDir, scenario.model, scenario.permissionMode, scenario.resume)));
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check(`devin ${scenario.name}: result records model, mode, and resume`,
      value.status === "completed" &&
      value.schema === "delegate-relay.result.v1" &&
      value.model === scenario.model &&
      value.permissionMode === scenario.permissionMode &&
      value.readOnly === scenario.readOnly &&
      value.allowPaid === scenario.relayArgs.includes("--allow-paid") &&
      value.resumed === scenario.resume.length > 0);
  }

  // The brief never rides argv, a successful run reads its report from stdout and its
  // session id, model, and usage from the exported trajectory.
  if (!h.WIN) {
    const outDir = join(h.scratch, "out-success-devin");
    const workDir = h.freshRepo("work-success-devin");
    const argsFile = join(h.scratch, "args-success-devin");
    const run = spawnSync(process.execPath, [
      h.relayPath("devin"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "devin-success", SMOKE_ARGS_FILE: argsFile, SMOKE_WRITE_FILE: join(workDir, "hello.txt") },
      encoding: "utf8",
    });
    const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("devin success: relay exits zero", run.status === 0);
    h.check("devin success: brief is delivered by --prompt-file, not argv",
      captured.brief === readFileSync(h.briefPath, "utf8") &&
      !captured.args?.includes(readFileSync(h.briefPath, "utf8")));
    h.check("devin success: the child cwd is --cd", captured.cwd && captured.cwd.endsWith("work-success-devin"));
    h.check("devin success: report, session, model, and usage are captured",
      value.status === "completed" &&
      value.exitCode === 0 &&
      value.finalMessage === "fake devin completed" &&
      value.sessionId === "smoke-session" &&
      value.actualModel === "swe-2-high" &&
      value.usage?.total_prompt_tokens === 7 &&
      value.eventsPath === join(outDir, "trajectory.json") &&
      value.finalPath === join(outDir, "final.txt"));
    h.check("devin success: touchedFiles lists the written file",
      Array.isArray(value.touchedFiles) && value.touchedFiles.some((line) => line.endsWith("hello.txt")));
    const head = spawnSync("git", ["-C", workDir, "rev-list", "--all", "--count"], { encoding: "utf8" });
    h.check("devin success: the relay did not commit", head.stdout.trim() === "0");

    for (const [mode, label] of [["devin-rejected", "stderr warning"], ["devin-rejected-silent", "trajectory only"]]) {
      const rejectedOut = join(h.scratch, `out-${mode}`);
      const rejected = spawnSync(process.execPath, [
        h.relayPath("devin"),
        "--brief", h.briefPath,
        "--cd", h.freshRepo(`work-${mode}`),
        "--out-dir", rejectedOut,
      ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8" });
      const rejectedValue = existsSync(join(rejectedOut, "result.json")) ? h.result(rejectedOut) : {};
      h.check(`devin rejected (${label}): exit 0 from devin is reported failed`,
        rejected.status === 1 &&
        rejectedValue.status === "failed" &&
        rejectedValue.exitCode === 1 &&
        rejectedValue.error?.includes("rejected a tool call") &&
        rejectedValue.error?.includes("accept-edits") &&
        rejectedValue.finalPath === null);
    }
  }

  // A readOnly lane selects devin's auto mode; an explicit --permission-mode wins over it.
  {
    const setupDir = join(h.testDir, "..", "skills", "delegate-setup", "scripts");
    const cfgHome = join(h.scratch, "home-lane-devin");
    const cfgRepo = h.freshRepo("work-lane-devin");
    mkdirSync(cfgHome, { recursive: true });
    const laneFile = join(cfgRepo, "devin-readonly.json");
    writeFileSync(laneFile, `${JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "devin", readOnly: true, model: "swe-2-medium" } },
    })}\n`);
    const fleetEnv = { ...h.baseEnv, HOME: cfgHome, USERPROFILE: cfgHome };
    delete fleetEnv.XDG_CONFIG_HOME;
    const writeCfg = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", laneFile], {
      encoding: "utf8",
      env: fleetEnv,
    });
    h.check("devin lane: global readOnly lane is written", writeCfg.status === 0);
    for (const [name, extra, mode, readOnly] of [
      ["readOnly dial applies", [], "auto", true],
      ["explicit --permission-mode wins", ["--permission-mode", "accept-edits"], "accept-edits", false],
    ]) {
      const outDir = join(h.scratch, `out-lane-${name.replace(/\W+/g, "-")}-devin`);
      const argsFile = join(h.scratch, `args-lane-${name.replace(/\W+/g, "-")}-devin`);
      const run = spawnSync(process.execPath, [
        h.relayPath("devin"),
        "--brief", h.briefPath,
        "--cd", cfgRepo,
        "--out-dir", outDir,
        "--lane", "review",
        ...extra,
      ], { env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
      const args = readCapturedArgs(h, argsFile);
      const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
      h.check(`devin lane: ${name}`,
        run.status === 0 &&
        h.pair(args, "--permission-mode", mode) &&
        h.pair(args, "--model", "swe-2-medium") &&
        value.readOnly === readOnly &&
        value.lane === "review");
    }
  }

  // Usage errors exit 2 before any artifact or dispatch.
  for (const [name, relayArgs, pattern] of [
    ["paid model without --allow-paid", ["--model", "fake-paid-model"], /--allow-paid/],
    ["model alias without --allow-paid", ["--model", "swe"], /not on the free SWE-2 list/],
    ["unknown permission mode", ["--permission-mode", "yolo"], /invalid --permission-mode/],
    ["read-only with a write mode", ["--read-only", "--permission-mode", "accept-edits"], /conflicts with --permission-mode/],
    ["session and resume-last", ["--session", "a", "--resume-last"], /mutually exclusive/],
    ["unsafe model token", ["--model", "-bad", "--allow-paid"], /unsupported characters/],
  ]) {
    const outDir = join(h.scratch, `out-usage-${name.replace(/\W+/g, "-")}-devin`);
    const argsFile = join(h.scratch, `args-usage-${name.replace(/\W+/g, "-")}-devin`);
    const rejected = spawnSync(process.execPath, [
      h.relayPath("devin"),
      "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-usage-${name.replace(/\W+/g, "-")}-devin`),
      "--out-dir", outDir,
      ...relayArgs,
    ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
    h.check(`devin usage: ${name} exits 2 before dispatch`,
      rejected.status === 2 && pattern.test(rejected.stderr) && !existsSync(outDir) && !existsSync(argsFile));
  }

  {
    const workDir = h.freshRepo("work-unavailable-devin");
    const outDir = join(h.scratch, "out-stale-unavailable-devin");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
    writeFileSync(join(outDir, "final.txt"), "stale final\n");
    writeFileSync(join(outDir, "trajectory.json"), "{\"session_id\":\"stale\"}\n");
    const missing = spawnSync(process.execPath, [
      h.relayPath("devin"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("devin unavailable: structured result replaces stale artifacts",
      missing.status === 127 &&
      value.status === "devin_unavailable" &&
      value.sessionId === null &&
      value.eventsPath === null &&
      !existsSync(join(outDir, "final.txt")));
  }

  if (!h.WIN) {
    const workDir = h.freshRepo("work-abort-preflight-devin");
    const outDir = join(h.scratch, "out-abort-preflight-devin");
    const preflight = h.runRelay("devin", workDir, outDir, ["--timeout", "1s"], {
      SMOKE_MODE: "devin-version-hang",
    });
    // Attach the close promise immediately so an early exit cannot miss it.
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      preflight.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    h.check("devin preflight abort: run artifacts are prepared",
      await h.until(() => existsSync(join(outDir, "brief.txt")), 2000));
    preflight.kill("SIGTERM");
    const didExit = await exited;
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("devin preflight abort: result is aborted and dispatch never starts",
      didExit &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
