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

export async function runHermes(h) {
  const expectedArgv = (outDir, workDir, extra = []) => [
    "chat",
    "--query-file", join(outDir, "brief.txt"),
    "-Q",
    "--format", "stream-json",
    "--in", workDir,
    ...extra,
  ];

  for (const scenario of [
    { name: "default", relayArgs: [], extra: [], resumed: false },
    { name: "model and provider", relayArgs: ["--model", "glm-5.2", "--provider", "zai"], extra: ["--model", "glm-5.2", "--provider", "zai"], resumed: false },
    { name: "effort", relayArgs: ["--effort", "high"], extra: ["--reasoning", "high"], resumed: false },
    { name: "yolo", relayArgs: ["--yolo"], extra: ["--yolo"], resumed: false },
    { name: "session", relayArgs: ["--session", "20261023_065451_c8c1fb"], extra: ["--resume", "20261023_065451_c8c1fb"], resumed: true },
    { name: "resume last", relayArgs: ["--resume-last"], extra: ["--resume", "latest"], resumed: true },
  ]) {
    const outDir = join(h.scratch, `out-${scenario.name.replace(/\W+/g, "-")}-hermes`);
    const workDir = h.freshRepo(`work-${scenario.name.replace(/\W+/g, "-")}-hermes`);
    const argsFile = join(h.scratch, `args-${scenario.name.replace(/\W+/g, "-")}-hermes`);
    const run = spawnSync(process.execPath, [
      h.relayPath("hermes"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...scenario.relayArgs,
    ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
    const args = readCapturedArgs(h, argsFile);
    h.check(`hermes ${scenario.name}: a run with no result event is not trusted as complete`,
      run.status === 1);
    h.check(`hermes ${scenario.name}: documented argv is exact`,
      JSON.stringify(args) === JSON.stringify(expectedArgv(outDir, workDir, scenario.extra)));
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check(`hermes ${scenario.name}: result records resume and dials`,
      value.schema === "delegate-relay.result.v1" &&
      value.tool === "hermes" &&
      value.resumed === scenario.resumed &&
      value.yolo === scenario.relayArgs.includes("--yolo") &&
      value.readOnly === false);
  }

  // The brief never rides argv. A successful run reads its report, session id, and usage
  // from the stream-json result event; plain notices on stdout are skipped.
  if (!h.WIN) {
    const outDir = join(h.scratch, "out-success-hermes");
    const workDir = h.freshRepo("work-success-hermes");
    const argsFile = join(h.scratch, "args-success-hermes");
    const run = spawnSync(process.execPath, [
      h.relayPath("hermes"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "hermes-success", SMOKE_ARGS_FILE: argsFile, SMOKE_WRITE_FILE: join(workDir, "hello.txt") },
      encoding: "utf8",
    });
    const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("hermes success: relay exits zero", run.status === 0);
    h.check("hermes success: brief is delivered by --query-file, not argv",
      captured.brief === readFileSync(h.briefPath, "utf8") &&
      !captured.args?.includes(readFileSync(h.briefPath, "utf8")));
    h.check("hermes success: the child cwd is --cd", captured.cwd && captured.cwd.endsWith("work-success-hermes"));
    h.check("hermes success: no --yolo is passed by default", !captured.args?.includes("--yolo"));
    h.check("hermes success: report, session, and usage are captured",
      value.status === "completed" &&
      value.exitCode === 0 &&
      value.finalMessage === "fake hermes completed" &&
      value.sessionId === "hermes-smoke-session" &&
      value.usage?.total === 7 &&
      value.autonomy.includes("single-query guard") &&
      value.eventsPath === join(outDir, "events.jsonl") &&
      value.finalPath === join(outDir, "final.txt"));
    h.check("hermes success: events.jsonl keeps the raw stdout, notices included",
      readFileSync(join(outDir, "events.jsonl"), "utf8").includes("not a json notice line"));
    h.check("hermes success: touchedFiles lists the written file",
      Array.isArray(value.touchedFiles) && value.touchedFiles.some((line) => line.endsWith("hello.txt")));
    const head = spawnSync("git", ["-C", workDir, "rev-list", "--all", "--count"], { encoding: "utf8" });
    h.check("hermes success: the relay did not commit", head.stdout.trim() === "0");

    for (const [mode, label, expectedExit, errorPattern, finalMessage] of [
      ["hermes-failed", "result event and exit 1", 1, /HTTP 429/, "provider exhausted"],
      ["hermes-failed-exit0", "result event failed, process exits 0", 1, /HTTP 429/, "provider exhausted"],
      ["hermes-no-result", "exit 0 with no result event", 1, /no result event/, ""],
    ]) {
      const failedOut = join(h.scratch, `out-${mode}`);
      const failed = spawnSync(process.execPath, [
        h.relayPath("hermes"),
        "--brief", h.briefPath,
        "--cd", h.freshRepo(`work-${mode}`),
        "--out-dir", failedOut,
      ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8" });
      const failedValue = existsSync(join(failedOut, "result.json")) ? h.result(failedOut) : {};
      h.check(`hermes failure (${label}): reported failed, never completed`,
        failed.status === expectedExit &&
        failedValue.status === "failed" &&
        failedValue.exitCode === expectedExit &&
        errorPattern.test(failedValue.error ?? "") &&
        failedValue.finalMessage === finalMessage &&
        failedValue.sessionId === "hermes-smoke-session");
    }
  }

  // Lane dials apply, an explicit flag wins over them, and a readOnly lane cannot be written.
  {
    const setupDir = join(h.testDir, "..", "skills", "delegate-setup", "scripts");
    const cfgHome = join(h.scratch, "home-lane-hermes");
    const cfgRepo = h.freshRepo("work-lane-hermes");
    mkdirSync(cfgHome, { recursive: true });
    const laneFile = join(cfgRepo, "hermes-lanes.json");
    writeFileSync(laneFile, `${JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { build: { implementer: "hermes", provider: "zai", model: "glm-5.2", effort: "medium", timeout: "20m" } },
    })}\n`);
    const readOnlyFile = join(cfgRepo, "hermes-readonly.json");
    writeFileSync(readOnlyFile, `${JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "hermes", readOnly: true } },
    })}\n`);
    const fleetEnv = { ...h.baseEnv, HOME: cfgHome, USERPROFILE: cfgHome };
    delete fleetEnv.XDG_CONFIG_HOME;
    const rejected = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", readOnlyFile], {
      encoding: "utf8",
      env: fleetEnv,
    });
    h.check("hermes lane: a readOnly lane is refused because hermes has no read-only mode",
      rejected.status !== 0 && /does not support readOnly/.test(`${rejected.stderr}${rejected.stdout}`));
    const writeCfg = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", laneFile], {
      encoding: "utf8",
      env: fleetEnv,
    });
    h.check("hermes lane: global lane is written", writeCfg.status === 0);
    for (const [name, extra, model, effort] of [
      ["dials apply", [], "glm-5.2", "medium"],
      ["explicit flags win", ["--model", "other-model", "--effort", "low"], "other-model", "low"],
    ]) {
      const slug = name.replace(/\W+/g, "-");
      const outDir = join(h.scratch, `out-lane-${slug}-hermes`);
      const argsFile = join(h.scratch, `args-lane-${slug}-hermes`);
      const run = spawnSync(process.execPath, [
        h.relayPath("hermes"),
        "--brief", h.briefPath,
        "--cd", cfgRepo,
        "--out-dir", outDir,
        "--lane", "build",
        ...extra,
      ], { env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
      const args = readCapturedArgs(h, argsFile);
      const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
      h.check(`hermes lane: ${name}`,
        h.pair(args, "--model", model) &&
        h.pair(args, "--provider", "zai") &&
        h.pair(args, "--reasoning", effort) &&
        value.lane === "build" &&
        value.effort === effort);
    }
  }

  // Usage errors exit 2 before any artifact or dispatch.
  for (const [name, relayArgs, pattern] of [
    ["read-only is refused", ["--read-only"], /no read-only mode/],
    ["unknown effort", ["--effort", "turbo"], /invalid --effort/],
    ["session and resume-last", ["--session", "a", "--resume-last"], /mutually exclusive/],
    ["unsafe model token", ["--model", "-bad"], /unsupported characters/],
    ["unsafe provider token", ["--provider", "a b"], /unsupported characters/],
    ["unknown option", ["--sandbox", "off"], /unknown option/],
  ]) {
    const slug = name.replace(/\W+/g, "-");
    const outDir = join(h.scratch, `out-usage-${slug}-hermes`);
    const argsFile = join(h.scratch, `args-usage-${slug}-hermes`);
    const rejected = spawnSync(process.execPath, [
      h.relayPath("hermes"),
      "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-usage-${slug}-hermes`),
      "--out-dir", outDir,
      ...relayArgs,
    ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
    h.check(`hermes usage: ${name} exits 2 before dispatch`,
      rejected.status === 2 && pattern.test(rejected.stderr) && !existsSync(outDir) && !existsSync(argsFile));
  }

  {
    const workDir = h.freshRepo("work-unavailable-hermes");
    const outDir = join(h.scratch, "out-stale-unavailable-hermes");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
    writeFileSync(join(outDir, "final.txt"), "stale final\n");
    writeFileSync(join(outDir, "events.jsonl"), "{\"session_id\":\"stale\"}\n");
    const missing = spawnSync(process.execPath, [
      h.relayPath("hermes"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("hermes unavailable: structured result replaces stale artifacts",
      missing.status === 127 &&
      value.status === "hermes_unavailable" &&
      value.sessionId === null &&
      value.eventsPath === null &&
      !existsSync(join(outDir, "final.txt")));
  }

  if (!h.WIN) {
    const workDir = h.freshRepo("work-abort-preflight-hermes");
    const outDir = join(h.scratch, "out-abort-preflight-hermes");
    const preflight = h.runRelay("hermes", workDir, outDir, ["--timeout", "1s"], {
      SMOKE_MODE: "hermes-version-hang",
    });
    // Attach the close promise immediately so an early exit cannot miss it.
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      preflight.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    h.check("hermes preflight abort: run artifacts are prepared",
      await h.until(() => existsSync(join(outDir, "brief.txt")), 2000));
    preflight.kill("SIGTERM");
    const didExit = await exited;
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("hermes preflight abort: result is aborted and dispatch never starts",
      didExit &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
