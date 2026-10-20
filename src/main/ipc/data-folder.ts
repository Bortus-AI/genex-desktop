/** Settings → Storage's data folder: where Genex keeps its files, picking another folder, and the move. */
import { dialog, type BrowserWindow } from "electron";
import type { DataFolderChoices } from "../data-folder-choice.ts";
import type { IpcHandle } from "./registrar.ts";

const PICKER = {
  title: "Folder for Genex’s files",
  buttonLabel: "Use this folder",
  message: "Pick an empty folder or a drive. Genex makes a Genex folder in one that has files.",
} as const;

const MESSAGE = {
  noWindow: "The studio window is not open.",
} as const;

export function registerDataFolderIpc(
  handle: IpcHandle,
  deps: { choices: DataFolderChoices; window: () => BrowserWindow | null },
): void {
  handle("studio:data-folder", async () => deps.choices.state());

  // The folder picker, then the checks; nothing is written until the move.
  handle("studio:data-folder.choose", async () => {
    const window = deps.window();
    if (!window) throw new Error(MESSAGE.noWindow);
    const result = await dialog.showOpenDialog(window, {
      ...PICKER,
      defaultPath: deps.choices.state().dir,
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    return deps.choices.choose(dir);
  });

  handle("studio:data-folder.move", async () => deps.choices.move());
}
