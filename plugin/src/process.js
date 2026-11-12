'use strict';

/**
 * 任务完整流程（帮助主题 `help process`）。
 *
 * 单一真源：CLI 的 `help process` 与 DSH 的 `/harness-cli help process` 都渲染这份文本，
 * 避免两处各写一份「流程说明」日后对不上。
 */

const PROCESS_ALIASES = new Set([
  'process',
  'flow',
  'workflow',
  '流程',
  '任务流程',
  '完整流程',
  '标准流程',
]);

const PROCESS_TEXT = [
  'Harness-CLI 完整流程（从开工到收尾）',
  '',
  '0. 选操作模式（开工前，必须）',
  '   · 手动：每个写入 / 确认 / 删除都等用户点选',
  '   · 自动 loop：自动推进，确认与选择走推荐项',
  '   入口：/harness-cli 或模型工具；选完写进任务模式，plan --confirm 会自动确认',
  '',
  '1. 初始化骨架',
  '   命令：/harness-cli init',
  '   产物：AGENTS.md / init.sh / scripts/gate.sh / docs/feature_list.json /',
  '         claude-progress.md / task_queue.json / prototype 预设',
  '   约定：幂等；已存在的非空文件不覆盖，状态文件连 --force 也不覆盖',
  '',
  '2. 建任务（一次拿到任务页 + 五份文档 + 方案页）',
  '   命令：/harness-cli page <任务名>',
  '   产物：prototype/<任务>/progress.html、plan.html',
  '         docs/specs/<任务>/{flow,proposal,spec,design,tasks}.md',
  '   同一次会问：先要不要 UX 报告；选了 UX 再问是否根据 UX 生成数模，没选就问是否生成数模；',
  '   最后问 UI（前面选了 UX / 数模时问「是否关联前面的文档生成 UI」）',
  '   约定：任务名支持中文；任务目录数有上限；方案页确认前不开工',
  '',
  '3. 补方案文档（只写 docs/specs）',
  '   命令：/harness-cli plan <任务名>',
  '   产物：docs/specs/<任务>/{flow,proposal,spec,design,tasks}.md',
  '   约定：任务未开工时顺带补齐任务页 / 方案页骨架；已有进度或已确认后只写 docs/specs',
  '',
  '4. 流程图与设计（先流程，再页面 / 数据 / UI）',
  '   流程：先补 docs/specs/<任务>/flow.md（业务流程图，Mermaid），确认后再往下做',
  '   页面与交互：任务页五段 DDD → SDD → TDD → 任务规划 → 进度记录',
  '   数模：/harness-cli sql <任务> → schema.sql / database.md / er.mmd / db/index.html',
  '   UX：/harness-cli ux [任务...] → prototype/ux.html（整体报告，永远覆盖全部任务 + 项目需求）+ prototype/<任务>/ux/index.html；',
  '       缺口逐条关闭（ux --resolve <编号>），关联任务随 --apply 同步刷新；随后询问「更新任务 / 关闭待确认项 / 创建任务 / 仅保留报告」',
  '   UI：/harness-cli ui <任务>（antd v5：令牌 + 布局 + 表格 / 表单 / 状态）',
  '   约定：UI 方向选定前不生成 ui/index.html；所有 UI 统一 antd v5（P20）',
  '',
  '5. 复盘（Agent 核对文档与页面一致）',
  '   命令：/harness-cli review <任务名>',
  '   产物：docs/specs/<任务>/review.md（含 flow / proposal / spec / design / tasks 指纹）',
  '   约定：复盘里的 ❌ 项必须清零，否则不能确认方案',
  '',
  '6. 方案确认（可选；交付前要过）',
  '   命令：/harness-cli plan <任务名> --confirm --by "确认人"',
  '   前置：review 已通过，且文档指纹与复盘时一致',
  '   约定：确认后文档再改会失效（P22），需要重新 review + confirm',
  '',
  '7. 执行与推进度',
  '   做法：按 docs/specs/<任务>/tasks.md 的 Step 1..N 顺序开工',
  '   命令：/harness-cli progress <任务> --step N --pct 0..100 [--status 进行中|待验收|完成]',
  '   自动：DSH 的 todo/write 会同步到任务页；进度只走 progress，不手改页面百分比',
  '   任务页：顶部「步骤流程」按百分比高亮当前步骤；总进度 = 各步等权汇总',
  '   约定：P25（页面百分比与记录一致）、P26（记录晚于方案确认）',
  '',
  '8. 验收与门禁',
  '   命令：/harness-cli check [--strict]、bash scripts/gate.sh',
  '   关键判定：P20 UI 单一 antd / P21 方案确认 / P22 确认后文档未变 /',
  '            P23 UI 与 design.md 指纹 / P25 步骤一致 / P26 记录时序',
  '   总览：node scripts/prototype-check.js --sync 从任务页重算总览',
  '',
  '9. 收尾与运维',
  '   总览：/harness-cli plans serve（随机端口；删除 / 重跑 / 编辑 / UI 与数模预览）',
  '   断点：/harness-cli continue <任务>（从当前进度继续，不重做已完成步骤）',
  '   重跑：/harness-cli restart <任务>（进度归零、方案待确认）',
  '   删除：/harness-cli delete <任务> --yes（不可恢复）',
  '   业务文档：/harness-cli wiki（生成 / 更新 docs/wiki）',
  '',
  '查看本流程：/harness-cli help process（别名：flow / workflow / 流程 / 完整流程）',
].join('\n');

/**
 * 判断帮助主题是不是「完整流程」。
 * @param {string} topic - `help <topic>` 里的 topic。
 * @returns {boolean} 是否为流程别名。
 */
function isProcessTopic(topic) {
  return PROCESS_ALIASES.has(String(topic || '').trim().toLowerCase());
}

module.exports = {PROCESS_TEXT, PROCESS_ALIASES, isProcessTopic};
