/**
 * The Publish dialog's platform rows, in a disposable Electron profile with a fake `window.studio`:
 * a game made in an engine lists the web, Mac and Windows above the presses, each detail on one
 * line; a built Mac app says "Coming soon" and the line under the rows says its players get the
 * web version; Make with agent closes the dialog and leaves the ask in the game's chat, unsent; a
 * build older than the game's last change says so; a web game with no app shows no rows. Dark and
 * light screens.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

/** The whole check, from Electron's start to its exit. */
const RUN_TIMEOUT_MS = 120_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `publish-platforms-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-platforms-"));
await build({
  entryPoints: ["tests/fixtures/publish-platforms.tsx"],
  outfile: path.join(out, "publish-platforms.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-platforms.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-platforms.js"></script></body></html>',
);
const boot = path.join(out, "publish-platforms.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const evidence=${JSON.stringify(evidence)};
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',steps:{},errors:[]};
report.buildId=report.source.sourceDigest;
report.electron=process.versions.electron;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-platforms.html"))});
  for (const theme of ['dark','light']) {
   // A game made in Unity with a Mac app built: three rows above Publish, each detail on one line.
   const engine=await step(theme+'Engine','window.platformsRig.open({theme:"'+theme+'"})');
   assert.equal(engine.listed,true);
   assert.deepEqual(engine.rows.map((row)=>[row.target,row.name,row.detail,row.end]),[
    ['web','Web','Plays right away',null],
    ['mac','Mac app','Apple silicon and Intel · built 5 min ago','Coming soon'],
    ['windows','Windows app','Not made yet','Make with agent'],
   ]);
   assert.equal(engine.rows[1].size,'1.4 GB');
   assert.equal(engine.reach,'Mac and Windows players get the web version.');
   assert.deepEqual(engine.order,['platforms','primary'],'the rows sit above the presses');
   assert.equal(engine.oneLine,true,'each detail is one line');
   assert.equal(engine.overflow,false);
   report[theme+'Engine']=await capture(theme+'-engine');
  }
  // Make with agent: the dialog closes and the ask waits in the game's chat, unsent.
  const made=await step('make','window.platformsRig.make("windows")');
  assert.equal(made.closed,1);
  assert.deepEqual(made.composed,[{project:'dust-runners',text:'Make a Windows app of Dust Runners so I can publish it for Windows players.',send:false}]);
  // A Mac app built before the game's last change says so.
  const stale=await step('stale','window.platformsRig.open({scene:"stale"})');
  assert.equal(stale.rows[1].detail,'Built before your last change');
  assert.equal(stale.rows[1].state,'stale');
  report.stale=await capture('dark-stale');
  // A web game with no app: the dialog as it was, no rows.
  const plain=await step('web','window.platformsRig.open({scene:"web"})');
  assert.equal(plain.listed,false);
  report.web=await capture('dark-web');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish platforms: engine game lists web, Mac and Windows; Make with agent leaves the ask unsent; stale says so; web game unchanged');
 } catch(error) { report.failure=error.stack; console.error(error); await capture('failure').catch(()=>{}); }
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
 app.exit(report.failure?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(profile, { recursive: true, force: true });
}
console.log(evidence);
