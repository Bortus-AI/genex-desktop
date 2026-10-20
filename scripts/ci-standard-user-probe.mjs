/**
 * TEMPORARY Windows CI probe (W1): after ci-windows-sandbox.mjs provisioned the sandbox as the
 * runner's administrator, what does srt-win's status say to a second, standard account on the
 * same PC? Creates a disposable local account, so it runs only on a GitHub Actions runner.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const USER = "genex-probe";
const PASSWORD = `Pr0be!${randomBytes(8).toString("hex")}A`;
const DIR = "C:\\genex-probe";

function ps(script) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 300_000,
    });
  } catch (error) {
    return `FAILED ${error.status}: ${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

/** Run `inner` (a PowerShell script) as the standard account and print its output. */
function asUser(label, inner) {
  const file = path.join(DIR, `${label}.ps1`);
  const out = path.join(DIR, `${label}.out.txt`);
  const err = path.join(DIR, `${label}.err.txt`);
  fs.writeFileSync(file, inner);
  const script = [
    `$cred = New-Object System.Management.Automation.PSCredential('${USER}', (ConvertTo-SecureString '${PASSWORD}' -AsPlainText -Force))`,
    `$p = Start-Process -FilePath powershell.exe -Credential $cred -LoadUserProfile -WorkingDirectory '${DIR}' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${file}') -RedirectStandardOutput '${out}' -RedirectStandardError '${err}' -Wait -PassThru`,
    "'exit ' + $p.ExitCode",
  ].join("; ");
  console.log(`== standard user: ${label}`);
  console.log(ps(script));
  for (const each of [out, err]) if (fs.existsSync(each)) console.log(fs.readFileSync(each, "utf8"));
}

test("srt-win status as the administrator and as a standard user", { skip: process.env.GITHUB_ACTIONS !== "true" }, async () => {
  const srt = await import("@anthropic-ai/sandbox-runtime");
  fs.mkdirSync(DIR, { recursive: true });
  const exe = path.join(DIR, "srt-win.exe");
  fs.copyFileSync(path.resolve(srt.VENDORED_SRT_WIN_EXE), exe);
  console.log("== admin: srt-win status");
  console.log(ps(`& '${exe}' status`));
  console.log("== admin: HKLM\\SOFTWARE\\sandbox-runtime access list and value names");
  console.log(ps("(Get-Acl 'HKLM:\\SOFTWARE\\sandbox-runtime').Access | Format-Table IdentityReference,RegistryRights,AccessControlType,IsInherited -AutoSize | Out-String -Width 300"));
  console.log(ps("Get-ChildItem 'HKLM:\\SOFTWARE\\sandbox-runtime' -Recurse | ForEach-Object { $_.Name + ': ' + ($_.GetValueNames() -join ', ') }; 'root: ' + ((Get-Item 'HKLM:\\SOFTWARE\\sandbox-runtime').GetValueNames() -join ', ')"));
  console.log("== admin: ProgramData\\sandbox-runtime access list");
  console.log(ps("icacls \"$env:ProgramData\\sandbox-runtime\"; Get-ChildItem \"$env:ProgramData\\sandbox-runtime\" -Recurse -Force | ForEach-Object { $_.FullName }"));
  console.log(ps(`icacls '${DIR}' /grant '*S-1-5-11:(OI)(CI)M' /T /Q`));
  console.log(ps(`New-LocalUser -Name ${USER} -Password (ConvertTo-SecureString '${PASSWORD}' -AsPlainText -Force) -PasswordNeverExpires | Out-Null; Add-LocalGroupMember -SID S-1-5-32-545 -Member ${USER}; 'created'`));
  asUser("whoami", "whoami; whoami /groups | Select-String 'S-1-5-32-544|Mandatory'");
  asUser("status", `& '${exe}' status; 'srt-win exit ' + $LASTEXITCODE`);
  asUser("user-status", `& '${exe}' user status; 'srt-win exit ' + $LASTEXITCODE`);
  asUser("registry", "Get-ChildItem 'HKLM:\\SOFTWARE\\sandbox-runtime' -Recurse -ErrorAction Continue | ForEach-Object { $_.Name }; 'root values: ' + ((Get-Item 'HKLM:\\SOFTWARE\\sandbox-runtime' -ErrorAction Continue).GetValueNames() -join ', ')");
  asUser("programdata", "Get-ChildItem \"$env:ProgramData\\sandbox-runtime\" -Recurse -Force -ErrorAction Continue | ForEach-Object { $_.FullName }");
});
