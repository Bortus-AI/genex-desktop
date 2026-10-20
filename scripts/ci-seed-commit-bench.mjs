/**
 * TEMPORARY Windows CI measurement (W1): the harness seed's first commit (437 files) with Defender's
 * real-time scan on, as loose objects (today) and as one pack (core.bigFileThreshold=1), on an idle
 * machine and with every core busy. Runs only on a GitHub Actions runner.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPS = 3;
const SEED = path.resolve("src/harness-seed");
const ROOT = path.join(process.env.APPDATA ?? os.tmpdir(), "genex-bench");
const PACK_ENV = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bigFileThreshold", GIT_CONFIG_VALUE_0: "1" };

function ps(script) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  } catch (error) {
    return `FAILED: ${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

function git(dir, args, env = {}) {
  execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, ...env }, stdio: "pipe" });
}

/** One fresh copy of the seed committed as the studio's ensureRepo does; the seconds it took. */
function firstCommit(label, env) {
  const dir = path.join(ROOT, `${label}-${Date.now()}`);
  fs.cpSync(SEED, dir, { recursive: true });
  const started = performance.now();
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"], env);
  git(dir, ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-q", "-m", "seed"]);
  return (performance.now() - started) / 1000;
}

function run(label, env) {
  const times = [];
  for (let rep = 0; rep < REPS; rep++) times.push(firstCommit(label, env));
  console.log(`${label}: ${times.map((t) => t.toFixed(2)).join(" s, ")} s`);
}

test("seed first commit, loose vs one pack, Defender on", { skip: process.env.GITHUB_ACTIONS !== "true" }, async () => {
  console.log(ps("Set-MpPreference -DisableRealtimeMonitoring $false; Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,OnAccessProtectionEnabled,AMRunningMode | Format-List | Out-String"));
  console.log(ps("(Get-MpPreference).ExclusionPath -join '; '"));
  console.log(`${os.cpus().length} CPUs; seed files ${fs.readdirSync(SEED, { recursive: true }).length}; root ${ROOT}`);
  fs.mkdirSync(ROOT, { recursive: true });
  run("idle loose", {});
  run("idle pack", PACK_ENV);
  const burners = os.cpus().map(() => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
  try {
    run("busy loose", {});
    run("busy pack", PACK_ENV);
  } finally {
    for (const burner of burners) burner.kill();
  }
});
