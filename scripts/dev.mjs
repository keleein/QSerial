// QSerial 开发模式编排脚本 (esbuild 版，移植自 dev.sh)
// 用法: node scripts/dev.mjs
// 流程: 构建 shared(tsc) → 构建 main+preload(esbuild) → 启动 Vite → 启动 Electron
// 注意: 不使用 tsc 构建 main (避免类型错误阻塞), 用 esbuild + alias 解析 @qserial/shared

import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { request } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VITE_PORT = parseInt(process.env.VITE_PORT || '5173', 10);

const isWin = process.platform === 'win32';
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

function log(msg) { console.log(msg); }
function err(msg) { console.error(`${RED}[ERROR]${NC} ${msg}`); }
function ok(msg) { console.log(`${GREEN}  ✓ ${msg}${NC}`); }
function warn(msg) { console.log(`${YELLOW}  ${msg}${NC}`); }

function die(msg) {
  err(msg);
  process.exit(1);
}

// 解析二进制路径
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');
const VITE = path.join(ROOT, 'node_modules/vite/bin/vite.js');

function findEsbuild() {
  const candidates = [
    `node_modules/@esbuild/win32-x64/esbuild.exe`,
    `node_modules/@esbuild/linux-x64/bin/esbuild`,
    `node_modules/@esbuild/darwin-x64/bin/esbuild`,
    `node_modules/@esbuild/darwin-arm64/bin/esbuild`,
  ].map((p) => path.join(ROOT, p));
  for (const c of candidates) if (existsSync(c)) return c;
  die('esbuild 未找到 (node_modules/@esbuild/*)');
}

function findElectron() {
  const dir = path.join(ROOT, 'node_modules/electron/dist');
  const exe = isWin ? path.join(dir, 'electron.exe') : path.join(dir, 'electron');
  if (existsSync(exe)) return exe;
  die('electron 未找到 (node_modules/electron/dist)');
}

const ESBUILD = findEsbuild();
const ELECTRON = findElectron();

// 前置检查
function checkFile(p, label) {
  if (!existsSync(p)) die(`${label} 未找到: ${p}`);
}

checkFile(TSC, 'tsc');
checkFile(VITE, 'vite');
checkFile(ESBUILD, 'esbuild');
checkFile(ELECTRON, 'electron');

log('');
log('==========================================');
log('  QSerial 开发模式 (esbuild)');
log('==========================================');
log('');

// 清理残留进程与端口
function killStale() {
  let killed = false;
  if (isWin) {
    spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
    spawnSync('taskkill', ['/F', '/IM', 'QSerial.exe'], { stdio: 'ignore' });
    // 通过 netstat 清理 5173 / 9800
    for (const port of [VITE_PORT, 9800]) {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && pid !== '0') {
            spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' });
            killed = true;
          }
        }
      }
    }
  } else {
    try { spawnSync('pkill', ['-f', 'electron.*packages/main/dist']); killed = true; } catch {}
    try { spawnSync('pkill', ['-f', 'QSerial']); killed = true; } catch {}
  }
  if (killed) { warn('已清理残留进程'); }
}
killStale();

// 同步构建 (返回是否成功)
function runSync(cmd, args, label) {
  log(`${YELLOW}[build] ${label}...${NC}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    err(`${label} 失败 (exit ${r.status})`);
    return false;
  }
  ok(`${label} 完成`);
  return true;
}

// 1. 构建 shared (tsc)
if (!runSync(process.execPath, [TSC, '-p', 'packages/shared/tsconfig.json', '--skipLibCheck'], '编译 shared')) {
  die('shared 编译失败');
}

// 2. 构建 main (esbuild, 不做类型检查)
// banner 注入 createRequire：MCP SDK 的 ESM sse.js 依赖 CJS 模块(depd/http-errors/raw-body)，
// 它们用 require('path') 等内建。ESM 格式下 require 不存在，需注入 createRequire 兜底。
const ESM_BANNER = "import{createRequire as __bannerCreateRequire}from'module';const require=__bannerCreateRequire(import.meta.url);";
log(`${YELLOW}[build] 编译 main (esbuild)...${NC}`);
const mainR = spawnSync(ESBUILD, [
  'packages/main/src/index.ts',
  '--bundle', '--platform=node', '--format=esm',
  '--outfile=packages/main/dist/index.mjs',
  '--external:electron', '--external:serialport', '--external:ssh2',
  '--external:node-pty', '--external:tftp', '--external:electron-log',
  '--external:uuid', '--external:@serialport/*',
  '--alias:@qserial/shared=./packages/shared/src',
  '--tsconfig=packages/main/tsconfig.json',
  `--banner:js=${ESM_BANNER}`,
], { cwd: ROOT, stdio: 'inherit' });
if (mainR.status !== 0) die('main 编译失败');
ok('main 完成');

// 3. 构建 preload (esbuild)
log(`${YELLOW}[build] 编译 preload (esbuild)...${NC}`);
const preR = spawnSync(ESBUILD, [
  'packages/main/src/preload.ts',
  '--bundle', '--platform=node', '--format=cjs',
  '--outfile=packages/main/dist/preload.cjs',
  '--external:electron',
  '--alias:@qserial/shared=./packages/shared/src',
], { cwd: ROOT, stdio: 'inherit' });
if (preR.status !== 0) die('preload 编译失败');
ok('preload 完成');

log('');
log(`${YELLOW}[dev] 启动 Vite (端口 ${VITE_PORT}) + Electron...${NC}`);
log('  UI 修改自动热更新');
log('  关闭 Electron 窗口即停止');
log('');

// 等待端口可用
function waitForPort(port, timeout = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = request({ hostname: 'localhost', port, method: 'HEAD', timeout: 800 }, () => {
        req.destroy();
        resolve();
      });
      req.on('error', () => {
        req.destroy();
        if (Date.now() - start > timeout) reject(new Error(`等待端口 ${port} 超时`));
        else setTimeout(check, 300);
      });
      req.end();
    };
    check();
  });
}

// 启动 Vite
const vite = spawn(process.execPath, [
  VITE, '--host', '--strictPort', '--config', 'vite.config.mjs',
], {
  cwd: path.join(ROOT, 'packages/renderer'),
  stdio: 'inherit',
  shell: false,
});

let electronStarted = false;
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  try { vite.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

waitForPort(VITE_PORT).then(() => {
  log(`${GREEN}  ✓ Vite 就绪，启动 Electron...${NC}`);
  electronStarted = true;
  const electron = spawn(ELECTRON, ['packages/main/dist/index.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, NODE_ENV: 'development' },
  });
  electron.on('close', (code) => {
    if (code && code !== 0) err(`Electron 退出码 ${code}`);
    cleanup();
  });
}).catch((e) => {
  err(e.message);
  cleanup();
  process.exit(1);
});

vite.on('close', () => {
  if (electronStarted) cleanup();
});
