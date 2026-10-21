/**
 * TEMPORARY probe (removed before review): facts about the Secondary Logon service and srt-win's
 * egress check on a real Windows runner. Prints what it finds; asserts nothing that could fail.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { editFolderOwn, FolderAceOp, GrantAccess } from "../../src/substrate/windows-folder-ace.ts";
import { srtSandboxGroup, srtSandboxSid, srtWinPath } from "../../src/substrate/windows-sandbox.ts";

const SKIP = process.platform !== "win32" || process.env.GENEX_WINDOWS_SANDBOX !== "ready";
const SC = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "sc.exe");
const PS = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function sh(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 120_000 });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message: string };
    return `[exit ${e.status}] ${e.stdout ?? ""} ${e.stderr ?? ""} ${e.message}`;
  }
}
const sc = (...args: string[]) => sh(SC, args);
const ps = (script: string) => sh(PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
const log = (label: string, text: unknown) =>
  console.log(`\n===== ${label} =====\n${typeof text === "string" ? text : JSON.stringify(text, null, 2)}`);

async function stopLogon(): Promise<void> {
  log("sc stop", sc("stop", "seclogon"));
  for (let i = 0; i < 40; i++) {
    if (/STOPPED/.test(sc("query", "seclogon"))) return;
    await sleep(250);
  }
}

async function verify(srtWin: string, cwd?: string): Promise<string> {
  const srt = await import("@anthropic-ai/sandbox-runtime");
  const before = process.cwd();
  if (cwd) process.chdir(cwd);
  const started = performance.now();
  try {
    const result = await srt.verifyWindowsWfpEgress({ srtWin: srt.resolveSrtWin({ path: srtWin }) });
    return `OK in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(result)}`;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return `FAILED in ${Math.round(performance.now() - started)} ms: code=${e.code} ${e.message}`;
  } finally {
    process.chdir(before);
  }
}

describe("seclogon probe", { skip: SKIP }, () => {
  const srtWin = srtWinPath();

  it("service facts", () => {
    log("os", `${os.release()} ${os.version?.()}`);
    log("sc qc", sc("qc", "seclogon"));
    log("sc query", sc("query", "seclogon"));
    log("sc sdshow", sc("sdshow", "seclogon"));
    log("sc qtriggerinfo", sc("qtriggerinfo", "seclogon"));
    log("whoami /groups", sh("whoami", ["/groups"]));
    log("whoami /priv", sh("whoami", ["/priv"]));
  });

  it("egress check, service running", async () => {
    log("sc start", sc("start", "seclogon"));
    log("verify running", await verify(srtWin));
  });

  it("egress check, service stopped (elevated caller)", async () => {
    await stopLogon();
    log("query before", sc("query", "seclogon"));
    log("verify stopped", await verify(srtWin));
    log("query after", sc("query", "seclogon"));
  });

  it("egress check, service disabled", async () => {
    await stopLogon();
    log("config disabled", sc("config", "seclogon", "start=", "disabled"));
    log("verify disabled", await verify(srtWin));
    log("config demand", sc("config", "seclogon", "start=", "demand"));
  });

  it("standard user: start the service, run the egress check while it is stopped", async () => {
    const dir = "C:\\genex-probe";
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    log("icacls", sh("icacls", [dir, "/grant", "*S-1-1-0:(OI)(CI)F"]));
    const exe = path.join(dir, "srt-win.exe");
    copyFileSync(srtWin, exe);
    for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll"]) {
      const from = path.join(path.dirname(srtWin), dll);
      if (existsSync(from)) copyFileSync(from, path.join(dir, dll));
    }
    const password = `Gx!${Math.random().toString(36).slice(2, 12)}A9`;
    log("net user add", sh("net", ["user", "genexprobe", password, "/add"]));
    const script = path.join(dir, "as-user.ps1");
    writeFileSync(
      script,
      [
        `$out = '${dir}\\out.txt'`,
        `"whoami: $(whoami)" | Out-File $out -Append`,
        `whoami /groups | Out-File $out -Append`,
        `New-Item '${dir}\\ready' -ItemType File | Out-Null`,
        `while (-not (Test-Path '${dir}\\go')) { Start-Sleep -Milliseconds 200 }`,
        `"--- query" | Out-File $out -Append; sc.exe query seclogon 2>&1 | Out-File $out -Append`,
        `"--- verify while stopped" | Out-File $out -Append`,
        `& '${exe}' wfp verify --target 127.0.0.1:9 2>&1 | Out-File $out -Append; "exit $LASTEXITCODE" | Out-File $out -Append`,
        `"--- query after verify" | Out-File $out -Append; sc.exe query seclogon 2>&1 | Out-File $out -Append`,
        `"--- start" | Out-File $out -Append; sc.exe start seclogon 2>&1 | Out-File $out -Append`,
        `Start-Sleep -Seconds 2`,
        `"--- verify again" | Out-File $out -Append`,
        `& '${exe}' wfp verify --target 127.0.0.1:9 2>&1 | Out-File $out -Append; "exit $LASTEXITCODE" | Out-File $out -Append`,
        `New-Item '${dir}\\done' -ItemType File | Out-Null`,
      ].join("\r\n"),
    );
    log("sc start (for Start-Process)", sc("start", "seclogon"));
    log(
      "start as user",
      ps(
        `$pw = ConvertTo-SecureString '${password}' -AsPlainText -Force; $c = New-Object PSCredential('genexprobe', $pw); Start-Process -FilePath '${PS}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}' -Credential $c -WorkingDirectory '${dir}' -WindowStyle Hidden; 'started'`,
      ),
    );
    for (let i = 0; i < 120 && !existsSync(path.join(dir, "ready")); i++) await sleep(250);
    log("ready", existsSync(path.join(dir, "ready")));
    await stopLogon();
    log("query (admin, stopped)", sc("query", "seclogon"));
    writeFileSync(path.join(dir, "go"), "");
    for (let i = 0; i < 240 && !existsSync(path.join(dir, "done")); i++) await sleep(250);
    log(
      "user output",
      existsSync(path.join(dir, "out.txt")) ? readFileSync(path.join(dir, "out.txt"), "utf16le") : "(none)",
    );
    log("query (admin, end)", sc("query", "seclogon"));
    sh("net", ["user", "genexprobe", "/delete"]);
  });

  it("fresh app folder under the profile: first egress checks from it", async () => {
    const group = await srtSandboxGroup(srtWin);
    const userSid = await srtSandboxSid(srtWin);
    log("sids", { group, userSid });
    sc("start", "seclogon");
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    for (const variant of ["ungranted", "group-grant"] as const) {
      const app = path.join(local, `genex-probe-${variant}`, "app-0.0.1");
      rmSync(path.dirname(app), { recursive: true, force: true });
      mkdirSync(app, { recursive: true });
      const exe = path.join(app, "srt-win.exe");
      copyFileSync(srtWin, exe);
      for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll"]) {
        const from = path.join(path.dirname(srtWin), dll);
        if (existsSync(from)) copyFileSync(from, path.join(app, dll));
      }
      if (variant === "group-grant" && group) {
        const outcomes = await editFolderOwn([
          {
            dir: app,
            sid: group,
            op: FolderAceOp.Own,
            deny: null,
            guard: false,
            grant: GrantAccess.Read,
            allows: true,
          },
        ]);
        log("grant outcome", outcomes);
      }
      log(`icacls ${variant}`, sh("icacls", [exe]));
      for (let attempt = 1; attempt <= 3; attempt++) {
        log(`verify ${variant} #${attempt}`, await verify(exe, app));
      }
    }
  });
});
