/**
 * 通用的 process.dlopen 补丁，解决 Windows 网络驱动器加载 .node 文件的限制
 * 以及 Linux 上 asar 打包后原生模块加载兼容性问题。
 *
 * Windows: node-pty / serialport / ssh2 的原生 .node 文件在 asar 中或 asarUnpack 后
 * 仍位于网络驱动器（SMB Z:）上，Windows 安全策略阻止从远程路径 dlopen。
 *
 * Linux: 打包后的 app.asar.unpacked 中的预编译 .node 文件可能与
 * Electron 内置 Node.js 的 ABI 不兼容，或 /tmp 挂载了 noexec。
 *
 * 此补丁拦截 process.dlopen，当加载失败时自动将 .node 及其依赖 DLL/subdir
 * 复制到本地可靠目录后重试。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app } from 'electron';

let patched = false;
let tempDir = '';

function getTempDir(): string {
  if (!tempDir) {
    // Linux 优先使用 userData（不受 noexec 影响），其他平台用系统临时目录
    if (process.platform === 'linux') {
      tempDir = path.join(app.getPath('userData'), 'native-modules');
    } else {
      tempDir = path.join(app.getPath('temp'), 'qserial-native');
    }
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

function copyNativeModule(srcFile: string): string {
  const baseName = path.basename(srcFile);
  const dest = path.join(getTempDir(), baseName);

  const srcStat = fs.statSync(srcFile);
  const destStat = fs.statSync(dest, { throwIfNoEntry: false });
  if (!destStat || srcStat.mtimeMs > destStat.mtimeMs || srcStat.size !== destStat.size) {
    fs.copyFileSync(srcFile, dest);
  }

  // 复制同目录下所有非 .node 文件（DLL/exe 等依赖），确保 Windows DLL 搜索路径能解析
  const srcDir = path.dirname(srcFile);
  try {
    for (const item of fs.readdirSync(srcDir)) {
      const srcItem = path.join(srcDir, item);
      let stat;
      try {
        stat = fs.statSync(srcItem);
      } catch {
        continue;
      }

      if (stat.isFile()) {
        if (item.endsWith('.node') || item.endsWith('.pdb')) continue;
        const destItem = path.join(getTempDir(), item);
        const ds = fs.statSync(destItem, { throwIfNoEntry: false });
        if (!ds || stat.mtimeMs > ds.mtimeMs || stat.size !== ds.size) {
          fs.copyFileSync(srcItem, destItem);
        }
      } else if (stat.isDirectory()) {
        const destItem = path.join(getTempDir(), item);
        if (!fs.existsSync(destItem)) {
          fs.cpSync(srcItem, destItem, { recursive: true });
        }
      }
    }
  } catch {
    /* 非关键，跳过 */
  }

  return dest;
}

function isFromAppBundle(p: string): boolean {
  // 检查路径是否在 app.asar / app.asar.unpacked / resourcesPath 下
  try {
    const appPath = app.getAppPath();
    const rp = process.resourcesPath;
    return p.startsWith(appPath) || (!!rp && p.startsWith(rp));
  } catch {
    return false;
  }
}

export function ensureNativePatch(): void {
  if (patched) return;
  patched = true;

  const originalDlopen = process.dlopen;

  if (typeof originalDlopen !== 'function') {
    console.error('[native-patch] process.dlopen not available, skipping');
    return;
  }

  process.dlopen = function (module: object, filename: string, flags?: number) {
    // 注意：flags 为 undefined 时不能作为第三个参数显式传递，
    // 否则 Node.js C++ 层会将 undefined 当作 dlopen flags 导致 EINVAL
    const dlopen = (f: string) =>
      flags !== undefined
        ? originalDlopen.call(this, module, f, flags)
        : originalDlopen.call(this, module, f);

    try {
      return dlopen(filename);
    } catch (err) {
      const errMsg = (err as Error).message;
      if (isFromAppBundle(filename)) {
        // 诊断：记录平台、Electron 版本等有助于排查 ABI 兼容性
        if (process.platform === 'linux') {
          console.error(
            '[native-patch] dlopen failed for',
            path.basename(filename),
            '| electron:',
            process.versions.electron,
            '| node:',
            process.versions.node,
            '| error:',
            errMsg.slice(0, 80)
          );
        }
        try {
          const tempFile = copyNativeModule(filename);
          console.log('[native-patch] Reloaded from temp:', path.basename(filename), '→', tempFile);
          return dlopen(tempFile);
        } catch (e2) {
          console.error('[native-patch] Temp retry also failed:', (e2 as Error).message);
          throw err;
        }
      }
      throw err;
    }
  };

  console.log('[native-patch] process.dlopen patch installed (platform:', process.platform, ')');
}
