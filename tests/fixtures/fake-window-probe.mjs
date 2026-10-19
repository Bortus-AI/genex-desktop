#!/usr/bin/env node
/**
 * A stand-in for Genex's Windows window probe (`src/substrate/windows-window-probe.ts`): started with
 * the probe's script path last, as Windows PowerShell is, it says it is ready and answers one JSON line
 * per request line from a fixed desktop. `--log <file>` appends each start (with whether the script
 * it was handed is the probe's) and each request; `--hang <request>` never answers that request;
 * `--fail-start` exits before it is ready, saying why on stderr; `--chatter` says a warning, and
 * puts a byte-order mark before its ready line, as Windows PowerShell can; `--exit-after-one` exits
 * once it has answered one request, as a helper that ends while idle.
 */
import { appendFileSync, readFileSync } from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const log = flag("--log");
const hang = flag("--hang");
const script = argv.at(-1);
const note = (entry) => log && appendFileSync(log, `${JSON.stringify(entry)}\n`);

if (argv.includes("--fail-start")) {
  process.stderr.write("Add-Type : Cannot add type. Compilation errors occurred.\n");
  process.exit(1);
}
let ours = false;
try {
  ours = readFileSync(script, "utf8").includes("GenexWindowProbe");
} catch {
  ours = false;
}
note({ start: process.pid, script: ours });

/** The desktop: Notepad in front with a password field focused, 1Password on the right half. */
const ANSWERS = {
  front: () => '{"pid":40,"exe":"Notepad.exe","name":"Notepad","secure":true}',
  at: (x) =>
    Number(x) < 1000
      ? '{"pid":40,"exe":"Notepad.exe","name":"Notepad"}'
      : '{"pid":41,"exe":"1Password.exe","name":"1Password"}',
  pid: (pid) => (pid === "40" ? '{"pid":40,"exe":"Notepad.exe","name":"Notepad"}' : '{"pid":0}'),
};

if (argv.includes("--chatter")) process.stdout.write("WARNING: The generated type defines no public methods.\r\n\uFEFF");
process.stdout.write('{"ready":true}\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  note({ request: line });
  if (line === hang) return;
  const [verb, ...args] = line.split(" ");
  const answer = ANSWERS[verb]?.(...args) ?? '{"error":"unknown request"}';
  process.stdout.write(`${answer}\n`, () => {
    if (argv.includes("--exit-after-one")) process.exit(0);
  });
});
lines.on("close", () => process.exit(0));
