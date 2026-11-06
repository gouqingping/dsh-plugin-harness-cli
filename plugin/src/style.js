'use strict';

/**
 * style：把随包携带的 harness-style（Python 工具）接成一个子命令。
 *
 * 为什么用子进程而不是重写：harness-style 的判定规则、vendor 依赖、hook 安装
 * 都已经稳定，重写一份必然漂移。这里只负责"找到它、把参数原样转过去、透传退出码"。
 *
 * 退出码语义保持一致：0 通过 / 1 有违规 / 2 工具或环境有问题。
 */

const path = require('path');
const fs = require('fs');
const {spawnSync} = require('child_process');

const STYLE_DIR = path.join(__dirname, '..', 'vendor', 'agent-style-harness');

function entryPath() {
  return path.join(STYLE_DIR, 'bin', 'harness-style');
}

function isBundled() {
  return fs.existsSync(entryPath());
}

/** python3 是否可用（harness-style 是 Python 实现）。 */
function pythonVersion() {
  for (const bin of ['python3', 'python']) {
    const res = spawnSync(bin, ['--version'], {encoding: 'utf8'});
    if (res.status === 0) {
      const text = `${res.stdout || ''}${res.stderr || ''}`.trim();
      return {bin, version: text};
    }
  }
  return null;
}

/**
 * 运行 harness-style。args 原样透传（--staged / --all / --json 等由它自己解析）。
 * @returns {number} 退出码
 */
function run(args, opts = {}) {
  if (!isBundled()) {
    process.stderr.write('❌ 找不到随包的 harness-style（plugin/vendor/agent-style-harness）\n');
    return 2;
  }
  const py = pythonVersion();
  if (py === null) {
    process.stderr.write('❌ 需要 python3（harness-style 是 Python 实现）\n');
    return 2;
  }
  const res = spawnSync(py.bin, [entryPath(), ...args], {
    stdio: 'inherit',
    cwd: opts.cwd || process.cwd(),
  });
  if (res.error) {
    process.stderr.write(`❌ 运行 harness-style 失败：${res.error.message}\n`);
    return 2;
  }
  return res.status === null ? 2 : res.status;
}

module.exports = {run, isBundled, pythonVersion, entryPath, STYLE_DIR};
