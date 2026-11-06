/**
 * 必须落地这个文件。
 *
 * gts 的 eslint 配置开启了 eslint-plugin-prettier，而 prettier 在找不到
 * 配置文件时会退回自己的默认值（双引号、分号、printWidth 80）。Google
 * TypeScript Style 要求单引号 + 无花括号内空格，与默认值冲突，会打出大量假违规。
 *
 * 用 .cjs 而不是 gts init 生成的 .prettierrc.js，是为了在
 * package.json 含 "type": "module" 的项目里也不会被当成 ESM 解析失败。
 */
module.exports = {
  ...require('gts/.prettierrc.json'),
  printWidth: 80, // Google TS Style: 80 列
};
