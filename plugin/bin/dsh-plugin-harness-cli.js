#!/usr/bin/env node
'use strict';

/**
 * dsh-plugin-harness-cli 入口。
 *
 * 退出码与 harness-style 对齐，便于两个工具串在同一条门禁里：
 *   0 = 通过
 *   1 = 有违规（可预期失败）
 *   2 = 工具自身坏了（配置读不动、模板缺失等）
 */

const {main} = require('../src/cli');

// 管道提前关闭（`dsh-plugin-harness-cli check | head`）不该让工具崩：
// 显式兜住 EPIPE，按正常结束处理（各平台 SIGPIPE 默认行为不一致）。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`dsh-plugin-harness-cli 内部错误：${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  });
