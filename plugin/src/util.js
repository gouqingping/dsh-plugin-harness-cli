'use strict';

/** 文件与字符串小工具。只依赖 node 内置模块，保持零安装。 */

const fs = require('fs');
const path = require('path');

/** 路径是否存在（文件或目录）。 */
function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

/** 是否存在且是目录。 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

/** 读文本；文件不存在返回 null，其他错误照常抛。 */
function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** 读 JSON；不存在返回 fallback，格式错抛错（不静默吞）。 */
function readJsonIfExists(p, fallback) {
  const text = readIfExists(p);
  if (text === null || text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`${p} 不是合法 JSON：${err.message}`);
    e.code = 'BAD_JSON';
    throw e;
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, {recursive: true});
}

/**
 * 原子写：先写同目录临时文件再 rename，避免中断时留下半截文件。
 * mode 用于给 init.sh / gate.sh 置可执行位。
 */
function writeFileSafe(p, content, mode) {
  mkdirp(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
}

/** 写 JSON，保持 2 空格缩进 + 结尾换行，diff 友好。 */
function writeJsonSafe(p, obj) {
  writeFileSafe(p, `${JSON.stringify(obj, null, 2)}\n`);
}

/** 文件是否“空”：不存在、或去掉空白后为空。 */
function isEmptyFile(p) {
  const text = readIfExists(p);
  if (text === null) return true;
  return text.trim() === '';
}

/** YYYY-MM-DD（本地时区，报告用）。 */
function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 完整 ISO 时间（状态文件用）。 */
function nowIso(d = new Date()) {
  return d.toISOString();
}

/** 非空字符串。 */
function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [v];
}

/** 把任意字符串变成可作为标识符的 kebab-case。 */
function toKebab(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 目录名 → 可读项目名（无 package.json 时的兜底）。 */
function basenameOf(dir) {
  return path.basename(path.resolve(dir));
}

/** 相对路径统一成 POSIX 风格，文档里永远用 /。 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * 任务名：允许字母、数字、中文等 Unicode 字母，以及中划线/下划线；不允许空格、斜杠、点开头。
 * 推荐 kebab-case（login-flow），但「登录页面」这类中文名同样可以直接做目录名。
 * @param {unknown} name - 候选任务名。
 * @returns {boolean} 是否合法。
 */
function isTaskName(name) {
  if (typeof name !== 'string') return false;
  const value = name.trim();
  if (value.length === 0 || value.length > 64) return false;
  if (value.startsWith('.')) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(value);
}

module.exports = {
  exists,
  isDir,
  readIfExists,
  readJsonIfExists,
  mkdirp,
  writeFileSafe,
  writeJsonSafe,
  isEmptyFile,
  today,
  nowIso,
  isText,
  isTaskName,
  toArray,
  toKebab,
  basenameOf,
  toPosix,
};
