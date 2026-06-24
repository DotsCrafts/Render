/**
 * Application menu — gives Render browser-correct keyboard semantics.
 *
 * Without a custom menu, Electron installs a default one where Cmd+W maps to
 * `role:'close'` (close the WHOLE window). For a browser that's wrong: the user
 * expects Cmd+W to close the active TAB. Closing the window also left the macOS
 * app lingering in the background (`window-all-closed` doesn't quit on darwin),
 * which reads as "the page didn't fully close".
 *
 * So we bind Cmd+W → close active tab (full WebContentsView teardown via
 * TabManager.close), Cmd+T → new tab, Cmd+Shift+W → close window. We keep the
 * standard edit/view/window roles — a custom menu REPLACES the default, so
 * cut/copy/paste/selectAll must be re-declared or they stop working in inputs.
 */

import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface AppMenuActions {
  /** Close the active browsing tab (TabManager.close on the active id). */
  closeActiveTab: () => void;
  /** Open a new tab (home/portal URL). */
  newTab: () => void;
}

export function installAppMenu(actions: AppMenuActions): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => actions.newTab() },
        // The fix: Cmd+W closes the TAB, not the window — full page teardown.
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => actions.closeActiveTab() },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    // Re-declare edit roles so copy/paste/select-all keep working with a custom menu.
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
