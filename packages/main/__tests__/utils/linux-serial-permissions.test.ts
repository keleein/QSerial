/**
 * 测试 Linux 串口权限自动修复模块
 *
 * 测试策略：由于函数内部直接 import node:fs 和 node:child_process，
 * 我们通过 vi.mock 在模块加载前拦截这些依赖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 被 hoisted，共享状态需要用 vi.hoisted 包裹
const { mockFs, mockSpawnExitCode } = vi.hoisted(() => {
  const mockFs = {
    existsSync: vi.fn<[string], boolean>(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn<[string], string>(),
    accessSync: vi.fn<[string, number?], void>(),
  };
  return { mockFs, mockSpawnExitCode: { value: 0 } };
});

vi.mock('node:fs', () => ({
  existsSync: mockFs.existsSync,
  mkdirSync: mockFs.mkdirSync,
  writeFileSync: mockFs.writeFileSync,
  unlinkSync: mockFs.unlinkSync,
  readFileSync: mockFs.readFileSync,
  accessSync: mockFs.accessSync,
  constants: { R_OK: 4, W_OK: 2 },
  realpathSync: vi.fn((p: string) => p),
  readlinkSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: 0, size: 0 })),
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => cb(mockSpawnExitCode.value), 0);
    }),
  })),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/tmp/qserial-test-userdata';
      if (name === 'temp') return '/tmp';
      return '/tmp';
    }),
  },
}));

import { spawn } from 'node:child_process';
import {
  ensureUdevRules,
  fixDevicePermission,
  autoFixSerialPermission,
  getPermissionErrorHint,
  __resetUdevState,
} from '../../src/utils/linux-serial-permissions.js';

describe('linux-serial-permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnExitCode.value = 0;
    __resetUdevState();

    // 默认 mock：文件/目录通常不存在
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.accessSync.mockReturnValue(undefined); // 默认有权限
  });

  describe('getPermissionErrorHint', () => {
    it('should return troubleshooting hints with device path', () => {
      const hint = getPermissionErrorHint('/dev/ttyACM0');

      expect(hint).toContain('Troubleshooting');
      expect(hint).toContain('usermod -aG dialout');
      expect(hint).toContain('chmod 666 /dev/ttyACM0');
    });
  });

  describe('ensureUdevRules', () => {
    it('should skip if rules file already exists with QSerial marker', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('# QSerial - Allow all users');

      const result = await ensureUdevRules();

      expect(result).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('should install rules via pkexec if not present', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await ensureUdevRules();

      expect(result).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'pkexec',
        expect.arrayContaining(['bash', '-c', expect.stringContaining('99-qserial.rules')]),
        expect.any(Object),
      );
    });

    it('should only attempt installation once (dedup)', async () => {
      mockFs.existsSync.mockReturnValue(false);

      await ensureUdevRules();
      await ensureUdevRules();

      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('should handle pkexec failure gracefully', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockSpawnExitCode.value = 1; // pkexec fails or user cancels

      const result = await ensureUdevRules();

      expect(result).toBe(false);
    });
  });

  describe('fixDevicePermission', () => {
    it('should skip if device is already accessible', async () => {
      // accessSync 不抛异常 = 有权限
      mockFs.accessSync.mockReturnValue(undefined);

      const result = await fixDevicePermission('/dev/ttyACM0');

      expect(result).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('should chmod if device is not accessible', async () => {
      mockFs.accessSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await fixDevicePermission('/dev/ttyACM0');

      expect(result).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'pkexec',
        ['chmod', '666', '/dev/ttyACM0'],
        expect.any(Object),
      );
    });

    it('should return false if chmod fails', async () => {
      mockFs.accessSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      mockSpawnExitCode.value = 1;

      const result = await fixDevicePermission('/dev/ttyACM0');

      expect(result).toBe(false);
    });
  });

  describe('autoFixSerialPermission', () => {
    it('should fix permission and install udev rules', async () => {
      mockFs.accessSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await autoFixSerialPermission('/dev/ttyUSB0');

      expect(result.fixed).toBe(true);
      expect(result.permanentFixInstalled).toBe(true);
      // 两次 spawn：chmod + udev rules
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('should still install udev even if device already accessible', async () => {
      mockFs.accessSync.mockReturnValue(undefined); // 已有权限

      const result = await autoFixSerialPermission('/dev/ttyACM0');

      expect(result.fixed).toBe(true);
      // 只安装 udev，不 chmod
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });
});
