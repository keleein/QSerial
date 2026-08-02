/**
 * Linux 串口权限自动修复模块
 *
 * 问题：Linux 串口设备（ttyUSB*, ttyACM*）默认属于 dialout 组，
 * 非 dialout 组成员无法打开设备。这需要在软件层面自动处理，
 * 而不是要求每个用户手动配置。
 *
 * 方案：
 * 1. 安装 udev 规则（永久修复）→ /etc/udev/rules.d/99-qserial.rules
 * 2. pkexec chmod（临时修复）→ 当前会话立即生效
 *
 * 注意：此模块仅用于 Linux 平台
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const UDEV_RULES_FILE = '/etc/udev/rules.d/99-qserial.rules';
const UDEV_RULES_CONTENT = `# QSerial - Allow all users to access USB serial devices
# Installed automatically by QSerial
# For more info see: https://github.com/qiuchengcai/QSerial

# USB serial converters (FTDI, CH340, CP210x, PL2303, etc.)
SUBSYSTEM=="tty", KERNEL=="ttyUSB*", MODE="0666"

# USB CDC-ACM modems / Arduino / STM32 / ESP32 / Raspberry Pi Pico
SUBSYSTEM=="tty", KERNEL=="ttyACM*", MODE="0666"
`;

// 跟踪是否已尝试安装 udev 规则，避免在每次连接失败时重复弹出 pkexec
let udevInstallAttempted = false;
let udevInstalled = false;

/** 重置安装状态（仅用于测试） */
export function __resetUdevState(): void {
  udevInstallAttempted = false;
  udevInstalled = false;
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * 执行特权命令（通过 pkexec 弹出密码对话框，或回退到 sudo）
 * 返回 { success, stdout, stderr }
 */
function execPrivileged(
  args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // 优先使用 pkexec（有 GUI 密码对话框），回退到 sudo
    const cmd = 'pkexec';
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, stdout, stderr });
    });

    child.on('error', () => {
      // pkexec 不可用，不尝试 sudo（无交互式终端）
      resolve({ success: false, stdout, stderr: 'pkexec not available' });
    });
  });
}

/**
 * 安装 udev 规则文件，使所有用户都可以访问 USB 串口设备
 * 需要 root 权限，会通过 pkexec 弹出密码对话框
 */
export async function ensureUdevRules(): Promise<boolean> {
  if (!isLinux()) return true; // 非 Linux 无需处理
  if (udevInstalled) return true;
  if (udevInstallAttempted) return udevInstalled;

  // 检查是否已安装
  try {
    if (fs.existsSync(UDEV_RULES_FILE)) {
      const existing = fs.readFileSync(UDEV_RULES_FILE, 'utf-8');
      if (existing.includes('QSerial')) {
        udevInstalled = true;
        udevInstallAttempted = true;
        return true;
      }
    }
  } catch {
    /* 权限不足无法读取，继续安装 */
  }

  udevInstallAttempted = true;

  try {
    // 将规则写入临时文件，然后通过 pkexec 复制到 /etc/udev/rules.d/
    const tmpDir = path.join(app.getPath('userData'), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, '99-qserial.rules');
    fs.writeFileSync(tmpFile, UDEV_RULES_CONTENT);

    // 路径来自 app.getPath('userData')，不含用户输入，安全
    const result = await execPrivileged([
      'bash',
      '-c',
      `cp "${tmpFile}" "${UDEV_RULES_FILE}" && udevadm control --reload-rules && udevadm trigger`,
    ]);

    // 清理临时文件
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }

    if (result.success) {
      udevInstalled = true;
      console.log('[linux-perm] udev rules installed successfully');
      return true;
    }

    console.warn('[linux-perm] Failed to install udev rules:', result.stderr?.slice(0, 120));
    return false;
  } catch (err) {
    console.warn('[linux-perm] Error installing udev rules:', (err as Error).message);
    return false;
  }
}

/**
 * 临时修复指定设备的权限（通过 pkexec chmod 666）
 * 使当前设备可立即访问，无需安装 udev 规则或重新插拔
 */
export async function fixDevicePermission(devicePath: string): Promise<boolean> {
  if (!isLinux()) return true; // 非 Linux 无需处理

  // 只在设备确实存在且无权限时尝试
  try {
    fs.accessSync(devicePath, fs.constants.R_OK | fs.constants.W_OK);
    return true; // 已经有权限
  } catch {
    // 无权限，尝试修复
  }

  const result = await execPrivileged(['chmod', '666', devicePath]);

  if (result.success) {
    console.log('[linux-perm] Fixed permissions for', devicePath);
    return true;
  }

  console.warn('[linux-perm] Failed to chmod', devicePath, ':', result.stderr?.slice(0, 80));
  return false;
}

/**
 * 生成针对用户的友好错误提示
 */
export function getPermissionErrorHint(devicePath: string): string {
  if (!isLinux()) return '';

  return [
    `\n[Troubleshooting]`,
    `1.  Run:  sudo usermod -aG dialout $USER   (then log out and back in)`,
    `2.  Or:   sudo chmod 666 ${devicePath}`,
    `3.  Or grant QSerial permission to install udev rules automatically when prompted.`,
  ].join('\n');
}

/**
 * 全面的权限修复入口：先临时 chmod（让当前连接成功），再安装 udev 规则（永久修复）
 * 返回 true 表示临时修复成功（可以打开设备）
 */
export async function autoFixSerialPermission(devicePath: string): Promise<{
  fixed: boolean;
  permanentFixInstalled: boolean;
}> {
  if (!isLinux()) {
    return { fixed: true, permanentFixInstalled: true };
  }

  // 第一步：尝试临时修复（让当前连接能打开）
  const fixed = await fixDevicePermission(devicePath);

  // 第二步：在后台尝试安装 udev 规则（永久修复，不阻塞当前操作）
  const permanentFixInstalled = await ensureUdevRules();

  return { fixed, permanentFixInstalled };
}
