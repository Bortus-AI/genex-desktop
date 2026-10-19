/**
 * The Windows window probe (`substrate/windows-window-probe.ts`): what Windows says about its desktop
 * for computer control on a PC. Its answers are read as a table (a window no process can be read
 * for is no app); the helper is driven as a stand-in process speaking its line protocol (ready, then
 * one answer per request, a hung request ending it and the next starting a fresh one); and on
 * Windows the real script runs under Windows PowerShell.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { driverEnv } from "../../src/substrate/cua-driver-client.ts";
import {
  parseProbeAnswer,
  probeCommand,
  windowsPowerShell,
  windowsProbe,
  type WindowsProbe,
} from "../../src/substrate/windows-window-probe.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-window-probe.mjs", import.meta.url));
const WINDOWS_ONLY = { skip: process.platform !== "win32" && "the real probe runs Windows PowerShell" };
const opened: WindowsProbe[] = [];
after(async () => {
  await Promise.all(opened.map((probe) => probe.close()));
});

/** A probe over the stand-in, and what it logged: each start and each request. */
async function standIn(flags: string[] = [], options: { requestMs?: number } = {}) {
  const log = path.join(await tmpDir("window-probe-"), "log.jsonl");
  const probe = windowsProbe({ command: process.execPath, args: [FAKE, "--log", log, ...flags], env: {} }, options);
  opened.push(probe);
  const logged = async (): Promise<Array<{ start?: number; script?: boolean; request?: string }>> =>
    existsSync(log)
      ? (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { probe, logged };
}

describe("the Windows window probe's answers", () => {
  it("reads an app with its executable, its name and, for the front one, its password flag", () => {
    assert.deepEqual(parseProbeAnswer('{"pid":40,"exe":"Notepad.exe","name":"Notepad","secure":true}'), {
      pid: 40,
      exe: "Notepad.exe",
      name: "Notepad",
      secure: true,
    });
    assert.deepEqual(parseProbeAnswer('{"pid":7,"exe":"Game.exe","name":""}'), {
      pid: 7,
      exe: "Game.exe",
      name: "",
      secure: null,
    });
    assert.equal(parseProbeAnswer('{"pid":40,"exe":"Notepad.exe","name":"Notepad","secure":null}')?.secure, null);
  });

  it("takes a window no process or executable can be read for as no app, and refuses anything else", () => {
    for (const none of ['{"pid":0}', '{"pid":12,"exe":""}', '{"pid":12}'])
      assert.equal(parseProbeAnswer(none), null, none);
    const hostile = [
      '{"error":"unknown request"}',
      "not json",
      "[]",
      "null",
      '{"pid":"40","exe":"a.exe"}',
      '{"pid":1.5}',
    ];
    for (const line of hostile) assert.throws(() => parseProbeAnswer(line), Error, line);
  });

  it("runs Windows PowerShell by its full path under SystemRoot, with no profile and no prompt", () => {
    assert.equal(
      windowsPowerShell({ SystemRoot: "D:\\Win" }),
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    assert.equal(windowsPowerShell({}), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(probeCommand({ SystemRoot: "C:\\Windows" }).args, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
  });
});

describe("the Windows window probe's helper (a stand-in process)", () => {
  it("starts once with its script, then answers each request in order", async () => {
    const { probe, logged } = await standIn();
    const [front, left, right, pid, gone] = await Promise.all([
      probe.front(),
      probe.at(100.4, 200.6),
      probe.at(1500, 10),
      probe.process(40),
      probe.process(41),
    ]);
    assert.deepEqual(front, { pid: 40, exe: "Notepad.exe", name: "Notepad", secure: true });
    assert.equal(left?.exe, "Notepad.exe");
    assert.equal(right?.exe, "1Password.exe");
    assert.equal(pid?.name, "Notepad");
    assert.equal(gone, null);
    const entries = await logged();
    assert.deepEqual(
      entries.filter((entry) => entry.start).map((entry) => entry.script),
      [true],
      "one helper, handed the probe's own script",
    );
    assert.deepEqual(
      entries.flatMap((entry) => (entry.request ? [entry.request] : [])),
      ["front", "at 100 201", "at 1500 10", "pid 40", "pid 41"],
    );
  });

  it("ends a helper that does not answer in time, and starts a fresh one for the next request", async () => {
    const { probe, logged } = await standIn(["--hang", "front"], { requestMs: 200 });
    await assert.rejects(probe.front(), /did not answer "front" in time/);
    const [first] = (await logged()).filter((entry) => entry.start);
    assert.equal(running(first!.start!), false, "the hung helper is gone");
    assert.equal((await probe.at(10, 10))?.exe, "Notepad.exe");
    assert.equal((await logged()).filter((entry) => entry.start).length, 2);
  });

  it("replaces a helper that ended while idle before asking it", async () => {
    const { probe, logged } = await standIn(["--exit-after-one"]);
    assert.equal((await probe.front())?.exe, "Notepad.exe");
    const [first] = (await logged()).filter((entry) => entry.start);
    const until = Date.now() + 5_000;
    while (running(first!.start!) && Date.now() < until) await sleep(20);
    assert.equal((await probe.at(1500, 10))?.exe, "1Password.exe", "answered by a fresh helper");
    assert.equal((await logged()).filter((entry) => entry.start).length, 2);
  });

  it("passes over what PowerShell says before the helper is ready", async () => {
    const { probe } = await standIn(["--chatter"]);
    assert.equal((await probe.front())?.exe, "Notepad.exe");
  });

  it("says why a helper that cannot start did not, and leaves nothing running", async () => {
    const { probe } = await standIn(["--fail-start"]);
    await assert.rejects(probe.ready(), /did not start: .*Compilation errors occurred/);
  });

  it("stops its helper and its script when closed, and answers nothing after", async () => {
    const { probe, logged } = await standIn();
    await probe.ready();
    const [start] = (await logged()).filter((entry) => entry.start);
    await probe.close();
    await assert.rejects(probe.front(), /was closed/);
    const until = Date.now() + 5_000;
    while (running(start!.start!) && Date.now() < until) await sleep(20);
    assert.equal(running(start!.start!), false);
  });
});

describe("the Windows window probe on Windows", () => {
  it("compiles under Windows PowerShell and reads this process as an app", WINDOWS_ONLY, async () => {
    const probe = windowsProbe(probeCommand(driverEnv()));
    opened.push(probe);
    await probe.ready();
    assert.equal((await probe.process(process.pid))?.exe.toLowerCase(), "node.exe");
    // A runner may have no desktop in front (a service session): either answer is an answer.
    const front = await probe.front();
    assert.ok(front === null || front.pid > 0);
    await probe.at(0, 0);
  });
});
