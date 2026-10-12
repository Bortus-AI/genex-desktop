/**
 * Computer control as this Mac's app wires it: cua-driver found where its installer puts it, its
 * daemon reached over MCP (or a VM's, over SSH, when `GENEX_COMPUTER_VM` names one), the studio's
 * own windows never driven, and one global shortcut — ⌃⌥⌘⎋ — that stops every desktop session,
 * registered only while one holds the computer.
 */
import { app, globalShortcut } from "electron";
import { type DesktopControl, desktopControl } from "./core/desktop-control.ts";
import {
  connectCuaDriver,
  findCuaDriver,
  localDriverCommand,
  vmDriverCommand,
} from "../substrate/cua-driver-client.ts";
import type { DesktopApp } from "../substrate/desktop-driver.ts";

/** The shortcut that stops every desktop session at once. */
export const DESKTOP_STOP_SHORTCUT = "Control+Alt+Command+Escape";

/** Whether an app is this studio: one of its own processes, or its own name. */
function isStudio(desktopApp: DesktopApp): boolean {
  const own = new Set(app.getAppMetrics().map((metric) => metric.pid));
  if (desktopApp.pid !== null && own.has(desktopApp.pid)) return true;
  return desktopApp.name === app.getName();
}

/**
 * The studio's computer control, or nothing where there is none yet: only macOS has a desktop
 * driver wired, and a smoke or eval profile never drives the real desktop.
 */
export function createDesktopControl(options: { automated: boolean }): DesktopControl | undefined {
  if (process.platform !== "darwin" || options.automated) return undefined;
  const vmCommand = process.env.GENEX_COMPUTER_VM ? vmDriverCommand(process.env.GENEX_COMPUTER_VM) : null;
  let control: DesktopControl | null = null;
  const onActive = (count: number) => {
    const held = globalShortcut.isRegistered(DESKTOP_STOP_SHORTCUT);
    if (count > 0 && !held) globalShortcut.register(DESKTOP_STOP_SHORTCUT, () => void control?.stopAll());
    if (count === 0 && held) globalShortcut.unregister(DESKTOP_STOP_SHORTCUT);
  };
  control = desktopControl({
    findDriver: async () => (vmCommand ? "ssh" : findCuaDriver()),
    connect: (binary) =>
      vmCommand
        ? connectCuaDriver(vmCommand, { local: false })
        : connectCuaDriver(localDriverCommand(binary), { local: true }),
    ownApp: isStudio,
    ...(vmCommand ? { vm: true } : {}),
    onActive,
  });
  return control;
}
