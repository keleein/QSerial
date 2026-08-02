/**
 * Windows 原生对话框替代方案
 *
 * Electron 的 dialog.showOpenDialog/showSaveDialog 在 Windows 上与 frameless 窗口交互时
 * 会导致 GPU 进程崩溃（特别是在创建新文件夹后选择目录时）。
 *
 * 在 Windows 上使用 PowerShell 的 System.Windows.Forms.FolderBrowserDialog / OpenFileDialog / SaveFileDialog
 * 在独立子进程中显示原生对话框，完全绕过 Electron 的原生对话框实现。
 *
 * 在 Linux / macOS 上直接使用 Electron 的 dialog API（无 GPU 兼容问题）。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, dialog, BrowserWindow } from 'electron';

/**
 * 通过对话框选择目录
 * Windows: PowerShell FolderBrowserDialog（避免 GPU 崩溃）
 * Linux/macOS: Electron dialog.showOpenDialog
 */
export async function pickFolder(title: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    return electronPickFolder(title);
  }

  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${title.replace(/'/g, "''")}'
$dialog.ShowNewFolderButton = $true
$dialog.UseDescriptionForTitle = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
} else {
  Write-Output '__CANCELED__'
}
$dialog.Dispose()
`.trim();

  return runPowerShell(ps);
}

/**
 * 通过对话框选择文件
 * Windows: PowerShell OpenFileDialog
 * Linux/macOS: Electron dialog.showOpenDialog
 */
export async function pickFile(
  title: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  if (process.platform !== 'win32') {
    return electronPickFile(title, filters);
  }

  const filterStr = filters
    ? filters
        .map(
          (f) => `${f.name}|${f.extensions.map((e) => (e === '*' ? '*.*' : `*.${e}`)).join(';')}`
        )
        .join('|')
    : 'All Files|*.*';

  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${title.replace(/'/g, "''")}'
$dialog.Filter = '${filterStr.replace(/'/g, "''")}'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
} else {
  Write-Output '__CANCELED__'
}
$dialog.Dispose()
`.trim();

  return runPowerShell(ps);
}

/**
 * 通过对话框选择保存路径
 * Windows: PowerShell SaveFileDialog
 * Linux/macOS: Electron dialog.showSaveDialog
 */
export async function pickSaveFile(
  title: string,
  defaultName?: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  if (process.platform !== 'win32') {
    return electronPickSaveFile(title, defaultName, filters);
  }

  const filterStr = filters
    ? filters
        .map(
          (f) => `${f.name}|${f.extensions.map((e) => (e === '*' ? '*.*' : `*.${e}`)).join(';')}`
        )
        .join('|')
    : 'All Files|*.*';

  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = '${title.replace(/'/g, "''")}'
$dialog.Filter = '${filterStr.replace(/'/g, "''")}'
${defaultName ? `$dialog.FileName = '${defaultName.replace(/'/g, "''")}'` : ''}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
} else {
  Write-Output '__CANCELED__'
}
$dialog.Dispose()
`.trim();

  return runPowerShell(ps);
}

/**
 * Electron 原生对话框（Linux / macOS 回退方案）
 */
async function electronPickFolder(title: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
}

async function electronPickFile(
  title: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
    title,
    filters,
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
}

async function electronPickSaveFile(
  title: string,
  defaultName?: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = await dialog.showSaveDialog(win as Electron.BrowserWindow, {
    title,
    defaultPath: defaultName,
    filters,
  });
  return result.canceled ? null : result.filePath || null;
}

/**
 * 执行 PowerShell 脚本并返回输出
 */
function runPowerShell(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    // 写入 UTF-8 临时脚本文件，避过 -Command 参数的中文编码丢失
    const tmpFile = path.join(app.getPath('temp'), `qserial-dialog-${Date.now()}.ps1`);
    const utf8Script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`;
    fs.writeFileSync(tmpFile, utf8Script, 'utf-8');

    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    proc.on('close', (code) => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }

      if (code !== 0 && stderr) {
        console.error('[native-dialog] PowerShell error:', stderr.trim());
      }

      const result = stdout.trim();
      if (!result || result === '__CANCELED__') {
        resolve(null);
      } else {
        resolve(result);
      }
    });

    proc.on('error', (err) => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      console.error('[native-dialog] Failed to spawn PowerShell:', err);
      resolve(null);
    });
  });
}
