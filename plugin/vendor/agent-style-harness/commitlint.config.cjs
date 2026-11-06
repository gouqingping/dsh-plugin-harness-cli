/**
 * commitlint 配置 —— 对应 ADR-0001 §8.3
 *
 * 目标：所有提交信息（人手写 / agent 自动生成）符合 Conventional Commits。
 * 校验入口有两条，共用本文件：
 *   1. .githooks/commit-msg        （本地，手动提交时触发）
 *   2. harness-style commit-msg    （agent 提交前自检 + CI 二次校验）
 *
 * 注意：本文件刻意不写合并/回滚/fixup 的豁免逻辑，
 * 那部分由包装层根据 git 状态判断（rebase 进行中才允许 fixup!）。
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],

  rules: {
    // 允许的 type。增删需要同步 §8.3 文档与 CHANGELOG 分组配置
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],

    // scope 白名单。必须与实际模块目录一致，
    // 由 `harness-style doctor` 检查一致性，否则 agent 会挑一个"能过"的 scope
    'scope-enum': [
      2,
      'always',
      ['cli', 'hooks', 'engines', 'config', 'docs', 'vendor', 'ci', 'deps'],
    ],

    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],

    // 必须关闭：中文无大小写，英文缩写（API/HTTP/SQL）会被 lower-case 规则误杀
    'subject-case': [0],

    'header-max-length': [2, 'always', 100],
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100],
  },
};
