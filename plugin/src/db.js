'use strict';

/**
 * 数据库设计：schema.sql → 数据模型 → 规范检查 → Mermaid ER / 离线数模图。
 *
 * 设计口径（Google 数据建模 / SQL 命名规范落地）：
 * - 命名：表名 / 字段名 snake_case，表名用单数，避免 SQL 保留字；
 * - 键：每张表必须有主键；外键列名 `<被引用表>_id`，且必须有以它开头的索引；
 * - 关系：多对多用中间表；外键必须写 REFERENCES；一对一用唯一约束表达；
 * - 类型：金额用 numeric / decimal，不用 float；时间用 timestamptz；布尔用 boolean；
 * - 审计：核心表带 created_at / updated_at；软删除用 deleted_at；
 * - 约束：业务规则写进 DDL（NOT NULL / UNIQUE / CHECK / FK），不用触发器实现业务逻辑；
 * - 规范化：至少 3NF，不冗余存储可从其他表推导的数据。
 *
 * `schema.sql` 是唯一真源；`er.mmd` 与 `db/index.html` 都是生成物，不要手改。
 * 解析只覆盖常见 DDL（CREATE TABLE / CREATE INDEX / 内联约束），不做完整 SQL 解析器。
 */

const fs = require('fs');
const path = require('path');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {exists, readIfExists, writeFileSafe, toPosix, isDir} = require('./util');

/** SQL 保留字：命中即视为命名问题。 */
const RESERVED = new Set(
  `all analyse analyze and any array as asc asymmetric authorization binary both case cast check
  collate collation column concurrently constraint create cross current_catalog current_date
  current_role current_schema current_time current_timestamp current_user default deferrable desc
  distinct do else end except false fetch for foreign freeze from full grant group having ilike in
  initially inner intersect into is isnull join lateral leading left like limit localtime
  localtimestamp natural not notnull null offset on only or order outer overlaps placing primary
  references returning right select session_user similar some symmetric table tablesample then to
  trailing true union unique user using variadic verbose when where window with`
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
);

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MONEY_PATTERN = /(amount|price|cost|balance|fee|salary)$/i;
const FLOAT_TYPE = /^(float|real|double(\s+precision)?)$/i;

/** 去掉标识符两侧的引号（"x" / `x` / [x]）。 */
function unquote(value) {
  const text = String(value || '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (first === last && (first === '"' || first === '`' || first === "'")) {
      return text.slice(1, -1).split(first + first).join(first);
    }
    if (first === '[' && last === ']') return text.slice(1, -1);
  }
  return text;
}

/** 取最后一段标识符：`public.users` → `users`。 */
function cleanIdent(raw) {
  const parts = String(raw || '')
    .trim()
    .split('.')
    .map((part) => unquote(part.trim()));
  return parts[parts.length - 1] || '';
}

/**
 * 去掉注释但保留字符串字面量：`--`、`#`、`/* *\/`。
 * 只处理常见 SQL；字符串里的注释符不会被误删。
 */
function stripComments(sql) {
  const text = String(sql || '');
  let out = '';
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const ch = text[index];
    if (quote !== null) {
      out += ch;
      if (ch === quote) {
        if (text[index + 1] === quote) {
          out += text[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** 按顶层分隔符切分（忽略括号与字符串里的分隔符）。 */
function splitTopLevel(text, separator) {
  const parts = [];
  let buffer = '';
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote !== null) {
      buffer += ch;
      if (ch === quote) {
        if (text[index + 1] === quote) {
          buffer += text[index + 1];
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim().length > 0) parts.push(buffer);
  return parts;
}

/** 按分号切分语句（忽略括号与字符串里的分号）。 */
function splitStatements(sql) {
  const statements = [];
  let buffer = '';
  let depth = 0;
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const ch = sql[index];
    if (quote !== null) {
      buffer += ch;
      if (ch === quote) {
        if (sql[index + 1] === quote) {
          buffer += sql[index + 1];
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) {
      if (buffer.trim().length > 0) statements.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim().length > 0) statements.push(buffer.trim());
  return statements;
}

/** 从 open 位置的左括号找到配对的右括号。 */
function findMatchingParen(text, open) {
  if (open < 0 || text[open] !== '(') return -1;
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index];
    if (quote !== null) {
      if (ch === quote) {
        if (text[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** 解析一个字段定义：`name type [constraints]`。 */
function parseColumnDef(def) {
  const match = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+([\s\S]+)$/.exec(String(def || '').trim());
  if (!match) return null;
  const name = unquote(match[1]);
  const rest = match[2].trim();
  const boundary = /\s+(not\s+null|primary\s+key|unique|references|default|check|generated|collate|constraint|deferrable|initially|comment)\b/i.exec(
    rest
  );
  const type = (boundary ? rest.slice(0, boundary.index) : rest).trim();
  const constraints = boundary ? rest.slice(boundary.index) : '';
  const fk = /references\s+([^\s(]+)\s*(?:\(\s*([^)]*)\s*\))?/i.exec(constraints);
  const comment = /\bcomment\s+'((?:[^']|'')*)'/i.exec(constraints);
  return {
    name,
    type: type || 'text',
    description: comment ? comment[1].replace(/''/g, "'") : '',
    notNull: /\bnot\s+null\b/i.test(constraints),
    pk: /\bprimary\s+key\b/i.test(constraints),
    unique: /\bunique\b/i.test(constraints),
    fk: fk
      ? {
          table: cleanIdent(fk[1]),
          column: fk[2] ? cleanIdent(splitTopLevel(fk[2], ',')[0]) : null,
        }
      : null,
  };
}

/** 解析 CREATE TABLE，返回表模型或 null（不是建表语句）。 */
function parseCreateTable(statement) {
  const head =
    /^create\s+(?:temporary\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\s\S]+?)\(/i.exec(statement);
  if (!head) return null;
  const name = cleanIdent(head[1]);
  const open = statement.indexOf('(', head[0].length - 1);
  const close = findMatchingParen(statement, open);
  if (close === -1) return {name, columns: [], primaryKey: [], uniqueGroups: [], fks: [], indexes: []};

  const table = {name, description: '', columns: [], primaryKey: [], uniqueGroups: [], fks: [], indexes: []};
  const inlinePk = [];
  for (const raw of splitTopLevel(statement.slice(open + 1, close), ',')) {
    const def = raw.trim();
    if (def.length === 0) continue;
    const stripped = def.replace(/^constraint\s+\S+\s+/i, '');
    const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(stripped);
    if (pk) {
      table.primaryKey = splitTopLevel(pk[1], ',').map(cleanIdent).filter(Boolean);
      continue;
    }
    const fk = /^foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(stripped);
    if (fk) {
      table.fks.push({
        from: splitTopLevel(fk[1], ',').map(cleanIdent).filter(Boolean),
        table: cleanIdent(fk[2]),
        to: fk[3] ? splitTopLevel(fk[3], ',').map(cleanIdent).filter(Boolean) : [],
      });
      continue;
    }
    const unique = /^unique\s*\(([^)]*)\)/i.exec(stripped);
    if (unique) {
      table.uniqueGroups.push(splitTopLevel(unique[1], ',').map(cleanIdent).filter(Boolean));
      continue;
    }
    if (/^(check|exclude|like|inherits)\b/i.test(stripped)) continue;

    const column = parseColumnDef(stripped);
    if (column) {
      table.columns.push(column);
      if (column.pk) inlinePk.push(column.name);
    }
  }

  const tailComment = /\bcomment\s*=?\s*'((?:[^']|'')*)'/i.exec(statement.slice(close + 1));
  if (tailComment) table.description = tailComment[1].replace(/''/g, "'");
  if (table.primaryKey.length === 0) table.primaryKey = inlinePk;
  for (const column of table.columns) {
    if (table.primaryKey.includes(column.name)) column.pk = true;
  }
  for (const fk of table.fks) {
    fk.from.forEach((fromColumn, index) => {
      const column = table.columns.find((item) => item.name === fromColumn);
      if (column) column.fk = {table: fk.table, column: fk.to[index] || fk.to[0] || null};
    });
  }
  return table;
}

/** 解析 CREATE [UNIQUE] INDEX。 */
function parseCreateIndex(statement) {
  const head =
    /^create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([^\s]+)\s+on\s+([^\s(]+)\s*(?:using\s+\w+\s*)?\(/i.exec(
      statement
    );
  if (!head) return null;
  const open = statement.indexOf('(', head[0].length - 1);
  const close = findMatchingParen(statement, open);
  if (close === -1) return null;
  const columns = splitTopLevel(statement.slice(open + 1, close), ',')
    .map((item) => item.trim().replace(/\s+(asc|desc)\b/i, '').replace(/\s+collate\s+\S+/i, ''))
    .map((item) => cleanIdent(item.split(/\s+/)[0]))
    .filter(Boolean);
  return {name: cleanIdent(head[2]), table: cleanIdent(head[3]), unique: Boolean(head[1]), columns};
}

/** 行尾 `-- 说明` / `# 说明`：按列名收集，作为 COMMENT 的兜底。 */
function lineComments(sql) {
  const comments = new Map();
  let current = null;
  for (const rawLine of String(sql || '').split('\n')) {
    let quote = null;
    let commentAt = -1;
    for (let index = 0; index < rawLine.length; index += 1) {
      const ch = rawLine[index];
      if (quote !== null) {
        if (ch === quote) {
          if (rawLine[index + 1] === quote) {
            index += 1;
            continue;
          }
          quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if ((ch === '-' && rawLine[index + 1] === '-') || ch === '#') {
        commentAt = index;
        break;
      }
    }
    const code = (commentAt >= 0 ? rawLine.slice(0, commentAt) : rawLine).trim();
    const comment =
      commentAt >= 0
        ? rawLine.slice(commentAt + (rawLine[commentAt] === '#' ? 1 : 2)).trim()
        : '';
    if (current === null) {
      const head =
        /^create\s+(?:temporary\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\s\S]+?)\(/i.exec(
          code
        );
      if (head) current = cleanIdent(head[1]);
      continue;
    }
    if (/^\)/.test(code)) {
      current = null;
      continue;
    }
    if (comment.length === 0) continue;
    if (/^(primary|foreign|unique|check|constraint|exclude)\b/i.test(code)) continue;
    const column = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/.exec(code);
    if (column) comments.set(`${current}.${unquote(column[1])}`, comment);
  }
  return comments;
}

/** 解析 `COMMENT ON TABLE / COLUMN ... IS '...'` 语句。 */
function commentStatements(statements) {
  const tables = new Map();
  const columns = new Map();
  for (const statement of statements) {
    const table = /^comment\s+on\s+table\s+(.+?)\s+is\s+'((?:[^']|'')*)'\s*$/i.exec(statement);
    if (table) {
      tables.set(cleanIdent(table[1]), table[2].replace(/''/g, "'"));
      continue;
    }
    const column = /^comment\s+on\s+column\s+(.+?)\s+is\s+'((?:[^']|'')*)'\s*$/i.exec(statement);
    if (column) {
      const parts = column[1].trim().split('.');
      const name = cleanIdent(parts.pop());
      const owner = cleanIdent(parts.join('.'));
      columns.set(`${owner}.${name}`, column[2].replace(/''/g, "'"));
    }
  }
  return {tables, columns};
}

/**
 * 解析 schema.sql。
 * @param {string} sql - DDL 文本。
 * @returns {{tables: Array<object>, indexes: Array<object>, relations: Array<object>}} 数据模型。
 */
function parseSchema(sql) {
  const model = {tables: [], indexes: [], relations: []};
  const statements = splitStatements(stripComments(sql));
  const line = lineComments(sql);
  const declared = commentStatements(statements);
  for (const statement of statements) {
    if (/^create\s+(unique\s+)?index\b/i.test(statement)) {
      const index = parseCreateIndex(statement);
      if (index) model.indexes.push(index);
      continue;
    }
    if (/^create\s+(?:temporary\s+|unlogged\s+)?table\b/i.test(statement)) {
      const table = parseCreateTable(statement);
      if (table) model.tables.push(table);
    }
  }

  const tableMap = new Map();
  for (const table of model.tables) if (!tableMap.has(table.name)) tableMap.set(table.name, table);
  for (const index of model.indexes) {
    const table = tableMap.get(index.table);
    if (table) table.indexes.push(index);
  }

  for (const table of model.tables) {
    if (!table.description && declared.tables.has(table.name)) {
      table.description = declared.tables.get(table.name);
    }
    for (const column of table.columns) {
      const key = `${table.name}.${column.name}`;
      if (!column.description && declared.columns.has(key)) {
        column.description = declared.columns.get(key);
      }
      if (!column.description && line.has(key)) column.description = line.get(key);
    }
    for (const column of table.columns) {
      if (!column.fk) continue;
      const target = tableMap.get(column.fk.table);
      if (target && !column.fk.column) {
        if (target.primaryKey.length === 1) column.fk.column = target.primaryKey[0];
        else if (target.columns.length === 1) column.fk.column = target.columns[0].name;
      }
      if (!target || !column.fk.column) continue;
      model.relations.push({
        from: table.name,
        fromColumn: column.name,
        to: target.name,
        toColumn: column.fk.column,
        oneToOne: Boolean(
          column.unique || (table.primaryKey.length === 1 && table.primaryKey[0] === column.name)
        ),
      });
    }
  }
  return model;
}

/** 外键列是否被某个索引/主键/唯一约束的第一列覆盖。 */
function hasLeadingIndex(table, column) {
  if (table.primaryKey[0] === column) return true;
  if (table.columns.some((item) => item.name === column && item.unique)) return true;
  if (table.uniqueGroups.some((group) => group[0] === column)) return true;
  return table.indexes.some((index) => index.columns[0] === column);
}

/**
 * 按 Google 数模规范做静态检查。
 * @param {object} model - parseSchema 的结果。
 * @returns {{errors: Array<object>, warnings: Array<object>}} 问题清单。
 */
function lintModel(model, options) {
  const opts = options || {};
  const externalTables =
    opts.externalTables instanceof Set
      ? opts.externalTables
      : new Set(Array.isArray(opts.externalTables) ? opts.externalTables : []);
  const errors = [];
  const warnings = [];
  const add = (list, id, message, hint) => {
    list.push({id, level: list === errors ? 'error' : 'warning', message, ...(hint ? {hint} : {})});
  };

  if (model.tables.length === 0) {
    add(errors, 'DB001', 'schema.sql 里还没有 CREATE TABLE', '先按任务文档建模，再重跑 /harness-cli sql <任务>');
  }

  const tableMap = new Map();
  for (const table of model.tables) {
    if (tableMap.has(table.name)) add(errors, 'DB012', `表名重复：${table.name}`);
    else tableMap.set(table.name, table);
  }

  for (const table of model.tables) {
    if (!NAME_PATTERN.test(table.name)) {
      add(errors, 'DB002', `表名不是 snake_case：${table.name}`, '表名只允许小写字母、数字、下划线');
    }
    if (RESERVED.has(table.name.toUpperCase())) {
      add(errors, 'DB008', `表名使用了 SQL 保留字：${table.name}`);
    }
    if (table.primaryKey.length === 0) {
      add(errors, 'DB004', `表 ${table.name} 没有主键`, '每张表都要有 PRIMARY KEY');
    }
    if (!table.description) {
      add(warnings, 'DB014', `表 ${table.name} 缺表说明`, '在 schema.sql 里写 COMMENT ON TABLE');
    }
    const missingDescriptions = table.columns.filter((column) => !column.description).length;
    if (missingDescriptions > 0) {
      add(
        warnings,
        'DB015',
        `表 ${table.name} 有 ${missingDescriptions} 个字段缺说明`,
        '为每个字段写 COMMENT ON COLUMN 或行尾 -- 说明'
      );
    }
    if (!table.columns.some((column) => column.name === 'created_at')) {
      add(warnings, 'DB009', `表 ${table.name} 缺 created_at`, '核心表建议带审计时间戳');
    }
    if (!table.columns.some((column) => column.name === 'updated_at')) {
      add(warnings, 'DB009', `表 ${table.name} 缺 updated_at`, '核心表建议带审计时间戳');
    }

    const columnNames = new Set();
    for (const column of table.columns) {
      if (columnNames.has(column.name)) {
        add(errors, 'DB012', `表 ${table.name} 的字段重复：${column.name}`);
      }
      columnNames.add(column.name);
      if (!NAME_PATTERN.test(column.name)) {
        add(errors, 'DB003', `字段名不是 snake_case：${table.name}.${column.name}`);
      }
      if (RESERVED.has(column.name.toUpperCase())) {
        add(errors, 'DB008', `字段名使用了 SQL 保留字：${table.name}.${column.name}`);
      }
      if (MONEY_PATTERN.test(column.name) && FLOAT_TYPE.test(column.type)) {
        add(
          errors,
          'DB010',
          `金额字段用了浮点数：${table.name}.${column.name}（${column.type}）`,
          '金额用 numeric(19,4) / decimal'
        );
      }
    }

    for (const index of table.indexes) {
      for (const column of index.columns) {
        if (!table.columns.some((item) => item.name === column)) {
          add(errors, 'DB013', `索引 ${index.name} 引用了不存在的字段：${table.name}.${column}`);
        }
      }
    }

    for (const column of table.columns) {
      if (!column.fk) continue;
      const target = tableMap.get(column.fk.table);
      if (!target) {
        // 跨任务外键：目标表在另一个任务的 schema.sql 里，整体数模图会合并；
        // 这里只检查本任务的外键索引，不把「别的任务才有的表」误报成 DB005。
        if (!externalTables.has(column.fk.table)) {
          add(errors, 'DB005', `外键 ${table.name}.${column.name} 指向不存在的表：${column.fk.table}`);
          continue;
        }
      } else if (!column.fk.column || !target.columns.some((item) => item.name === column.fk.column)) {
        add(
          errors,
          'DB006',
          `外键 ${table.name}.${column.name} 指向不存在的字段：${column.fk.table}.${column.fk.column || '?'}`
        );
        continue;
      }
      if (!hasLeadingIndex(table, column.name)) {
        add(
          errors,
          'DB007',
          `外键 ${table.name}.${column.name} 没有索引`,
          `CREATE INDEX idx_${table.name}_${column.name} ON ${table.name} (${column.name});`
        );
      }
    }
  }

  return {errors, warnings};
}

/** 字段类型 → Mermaid 可接受的单词类型。 */
function mermaidType(type) {
  const text = String(type || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(varchar|character varying|char|character|text|citext|string)/.test(text)) return 'string';
  if (/^(bigint|int8|bigserial|serial8)/.test(text)) return 'bigint';
  if (/^(smallint|int2|int|integer|serial|mediumint)/.test(text)) return 'int';
  if (/^(numeric|decimal|money)/.test(text)) return 'decimal';
  if (/^(boolean|bool)/.test(text)) return 'boolean';
  if (/^(timestamptz|timestamp|datetime|date|time)/.test(text)) return 'timestamp';
  if (/^uuid/.test(text)) return 'uuid';
  if (/^(json|jsonb)/.test(text)) return 'json';
  if (/^(bytea|blob|binary|varbinary)/.test(text)) return 'bytes';
  return 'string';
}

/** Mermaid 标识符：只留字母/数字/下划线，且不能以数字开头。 */
function mermaidId(value) {
  const text = String(value || '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(text) ? text : `t_${text}`;
}

/** 从数据模型生成 Mermaid ER 图源码。 */
function renderMermaid(model) {
  const lines = ['%% 由 dsh-plugin-harness-cli sql 从 schema.sql 生成，不要手改。', 'erDiagram'];
  const tableNames = new Set(model.tables.map((table) => table.name));
  for (const table of model.tables) {
    if (table.description) {
      lines.push(`  %% ${table.name}：${String(table.description).replace(/\n/g, ' ')}`);
    }
    lines.push(`  ${mermaidId(table.name)} {`);
    for (const column of table.columns) {
      const keys = [];
      if (table.primaryKey.includes(column.name)) keys.push('PK');
      if (column.fk) keys.push('FK');
      if (column.unique) keys.push('UK');
      const comment = [column.type, column.description]
        .filter(Boolean)
        .join(' · ')
        .replace(/"/g, "'");
      lines.push(
        `    ${mermaidType(column.type)} ${mermaidId(column.name)}${keys.length ? ` ${keys.join(', ')}` : ''} "${comment}"`
      );
    }
    lines.push('  }');
  }
  for (const relation of model.relations) {
    // 跨任务外键的目标表不在本任务的 schema 里：Mermaid 只画本 schema 内的关系，
    // 外部关系用注释保留，详情见 db/index.html 与 database.md。
    if (!tableNames.has(relation.from) || !tableNames.has(relation.to)) {
      lines.push(
        `  %% 外部关系：${relation.from}.${relation.fromColumn} -> ${relation.to}.${relation.toColumn}（见整体数模图）`
      );
      continue;
    }
    const card = relation.oneToOne ? '||--||' : '||--o{';
    lines.push(
      `  ${mermaidId(relation.to)} ${card} ${mermaidId(relation.from)} : "${mermaidId(relation.fromColumn)}"`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** HTML 转义：schema.sql 里的标识符不可信，不能直接拼进页面。 */
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** database.md 里由 sql 生成 / 覆盖的受管区块标记。 */
const DB_DOC_BEGIN = '<!-- harness-db:begin -->';
const DB_DOC_END = '<!-- harness-db:end -->';

/** Markdown 表格单元格转义。 */
function markdownCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * 字段说明分组：字段名 / 类型 / 约束 / 说明完全相同的行合并，所属表列在一行。
 * 不同表里同名但类型 / 约束 / 说明不同的字段不会被误合并。
 */
function groupFieldRows(model) {
  const groups = new Map();
  const order = [];
  for (const table of model.tables) {
    for (const column of table.columns) {
      const keys = [];
      if (table.primaryKey.includes(column.name)) keys.push('PK');
      if (column.fk) keys.push('FK');
      if (column.unique) keys.push('UK');
      if (column.notNull) keys.push('NOT NULL');
      const key = [column.name, column.type, keys.join('·'), column.description || ''].join('\u0000');
      let group = groups.get(key);
      if (!group) {
        group = {
          tables: [],
          column: column.name,
          type: column.type,
          keys,
          description: column.description || '',
        };
        groups.set(key, group);
        order.push(key);
      }
      if (!group.tables.includes(table.name)) group.tables.push(table.name);
    }
  }
  return order.map((key) => {
    const group = groups.get(key);
    return {
      tables: group.tables,
      tableLabel: group.tables.join('、'),
      column: group.column,
      type: group.type,
      keys: group.keys.length ? group.keys.join(' · ') : '—',
      description: group.description || '缺说明',
    };
  });
}

/**
 * 从数据模型生成 database.md 的受管区块：关系说明 + 字段说明。
 * 「反填」指把 schema.sql 里的 COMMENT / 行尾说明写回设计文档，保证两处不漂移。
 */
function renderDatabaseBlock(model) {
  const lines = [
    DB_DOC_BEGIN,
    '## 生成：关系与字段说明',
    '',
    '> 本节由 `dsh-plugin-harness-cli sql` 从 `schema.sql` 生成，重跑会覆盖本节；人工说明请写在本区块外。',
    '',
  ];
  if (model.relations.length === 0) {
    lines.push('暂无外键关系。');
  } else {
    lines.push('### 关系说明', '', '| 来源 | 目标 | 基数 | 说明 |', '|---|---|---|---|');
    for (const relation of model.relations) {
      const fromTable = model.tables.find((table) => table.name === relation.from);
      const toTable =
        model.tables.find((table) => table.name === relation.to) ||
        (relation.external
          ? {name: relation.to, description: relation.targetDescription || '', columns: []}
          : undefined);
      const fromColumn =
        fromTable && fromTable.columns.find((column) => column.name === relation.fromColumn);
      const prefix =
        fromColumn && fromColumn.description
          ? `${fromColumn.description.replace(/[。.;；]$/, '')}。`
          : '';
      const suffix = relation.external ? '（外部表，见整体数模图）' : '';
      lines.push(
        `| \`${relation.from}.${relation.fromColumn}\` | \`${relation.to}.${relation.toColumn}\` | ` +
          `${relation.oneToOne ? '1:1' : 'N:1'} | ${markdownCell(
            `${prefix}${relationSentence(
              fromTable,
              relation.fromColumn,
              toTable,
              relation.toColumn,
              relation.oneToOne
            )}${suffix}`
          )} |`
      );
    }
  }
  lines.push('', '### 字段说明', '');
  if (model.tables.length === 0) {
    lines.push('暂无表。');
  } else {
    lines.push('| 所属表 | 字段 | 类型 | 约束 | 说明 |', '|---|---|---|---|---|');
    for (const row of groupFieldRows(model)) {
      const tables = row.tables.map((name) => `\`${name}\``).join('、');
      lines.push(
        `| ${tables} | \`${row.column}\` | ${markdownCell(row.type)} | ` +
          `${row.keys} | ${markdownCell(row.description)} |`
      );
    }
  }
  lines.push(DB_DOC_END);
  return lines.join('\n');
}

/**
 * 把受管区块写回 database.md：有标记就替换，没有就在文末追加。
 * 区块外的内容原样保留。
 */
function syncDatabaseDoc(text, model) {
  const block = renderDatabaseBlock(model);
  const source = String(text || '');
  const begin = source.indexOf(DB_DOC_BEGIN);
  const end = source.indexOf(DB_DOC_END);
  if (begin !== -1 && end > begin) {
    return `${source.slice(0, begin)}${block}${source.slice(end + DB_DOC_END.length)}`;
  }
  return `${source.replace(/\s+$/, '')}\n\n${block}\n`;
}

/** 用完整句子说明一条外键关系的基数与业务含义。 */
function relationSentence(fromTable, fromColumn, toTable, toColumn, oneToOne) {
  const fromLabel =
    fromTable && fromTable.description ? `${fromTable.description}（${fromTable.name}）` : fromTable ? fromTable.name : '?';
  const toLabel =
    toTable && toTable.description ? `${toTable.description}（${toTable.name}）` : toTable ? toTable.name : '?';
  if (oneToOne) {
    return `每条${fromLabel}记录通过 ${fromColumn} 唯一关联 1 条${toLabel}记录。`;
  }
  return `多条${fromLabel}记录通过 ${fromColumn} 关联到 1 条${toLabel}记录；1 条${toLabel}可对应多条${fromLabel}。`;
}

/**
 * 生成离线数模图（HTML + 内联 SVG 连线）。
 * @param {object} model - 数据模型（含 errors / warnings）。
 * @param {{task: string, project: string, generatedAt: string, schemaPath: string, mermaidPath: string}} meta - 页面元信息。
 * @returns {string} HTML。
 */
function renderErPage(model, meta) {
  const errors = Array.isArray(model.errors) ? model.errors : [];
  const warnings = Array.isArray(model.warnings) ? model.warnings : [];
  const issues = [...errors, ...warnings].map((issue) => ({
    ...issue,
    id: escapeHtml(issue.id),
    message: escapeHtml(issue.message),
    hint: issue.hint ? escapeHtml(issue.hint) : undefined,
    levelLabel: issue.level === 'error' ? '错误' : '警告',
  }));
  const modelJson = JSON.stringify({relations: model.relations})
    .replace(/</g, '\\u003c')
    .replace(/\{\{/g, '{\\u007b');
  const relationships = model.relations.map((relation) => {
    const fromTable = model.tables.find((table) => table.name === relation.from);
    const toTable =
      model.tables.find((table) => table.name === relation.to) ||
      (relation.external
        ? {name: relation.to, description: relation.targetDescription || '', columns: []}
        : undefined);
    const fromColumn =
      fromTable && fromTable.columns.find((column) => column.name === relation.fromColumn);
    const prefix =
      fromColumn && fromColumn.description
        ? `${fromColumn.description.replace(/[。.;；]$/, '')}。`
        : '';
    const suffix = relation.external ? '（外部表，见整体数模图）' : '';
    return {
      from: escapeHtml(relation.from),
      fromColumn: escapeHtml(relation.fromColumn),
      to: escapeHtml(relation.to),
      toColumn: escapeHtml(relation.toColumn),
      cardinality: relation.oneToOne ? '1:1' : 'N:1',
      external: Boolean(relation.external),
      description: escapeHtml(
        `${prefix}${relationSentence(fromTable, relation.fromColumn, toTable, relation.toColumn, relation.oneToOne)}${suffix}`
      ),
    };
  });
  const fieldRows = groupFieldRows(model).map((row) => ({
    tables: escapeHtml(row.tableLabel),
    column: escapeHtml(row.column),
    type: escapeHtml(row.type),
    keys: escapeHtml(row.keys),
    description: escapeHtml(row.description),
  }));
  return render(loadTemplate('dbPage'), {
    project: escapeHtml(meta.project),
    task: escapeHtml(meta.task),
    generatedAt: escapeHtml(meta.generatedAt),
    schemaPath: escapeHtml(meta.schemaPath),
    mermaidPath: escapeHtml(meta.mermaidPath),
    tableCount: model.tables.length,
    relationCount: model.relations.length,
    columnCount: model.tables.reduce((sum, table) => sum + table.columns.length, 0),
    errorCount: errors.length,
    warningCount: warnings.length,
    hasTables: model.tables.length > 0,
    hasRelations: model.relations.length > 0,
    issues,
    tables: model.tables.map((table) => ({
      ...table,
      name: escapeHtml(table.name),
      description: escapeHtml(table.description || ''),
      columnCount: table.columns.length,
      columns: table.columns.map((column) => ({
        ...column,
        name: escapeHtml(column.name),
        type: escapeHtml(column.type),
        description: escapeHtml(column.description || ''),
      })),
    })),
    relationships,
    fieldRows,
    hasFields: fieldRows.length > 0,
    modelJson,
  });
}

/** 整体数模图的手动布局文件（相对 prototype/）。 */
const DB_LAYOUT_FILE = 'db-layout.json';

/** 任务页能力所在目录（默认 prototype/）。 */
function prototypeDir(config) {
  const preset = (config.presets && config.presets.prototype) || {};
  return preset.dir || 'prototype';
}

/** 规范文档目录（默认 docs/specs/）。 */
function specsDir(config) {
  return config.paths.specs || 'docs/specs';
}

/** 手动布局文件绝对路径。 */
function layoutPath(root, config) {
  return path.join(root, prototypeDir(config), DB_LAYOUT_FILE);
}

/** 校验并归一化手动布局：坐标只接受有限数字，最多 500 张表。 */
function normalizeLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  const raw =
    source.positions && typeof source.positions === 'object' && !Array.isArray(source.positions)
      ? source.positions
      : {};
  const positions = {};
  for (const [name, position] of Object.entries(raw)) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) continue;
    if (!position || typeof position !== 'object') continue;
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) continue;
    positions[name] = {x: Math.round(x), y: Math.round(y)};
    if (Object.keys(positions).length >= 500) break;
  }
  return {
    version: 1,
    positions,
    ...(typeof source.updatedAt === 'string' ? {updatedAt: source.updatedAt} : {}),
  };
}

/** 读手动布局；文件不存在 / 坏了都退回空布局（页面仍可自动布局）。 */
function readDbLayout(root, config) {
  const text = readIfExists(layoutPath(root, config));
  if (text === null || text.trim() === '') return {version: 1, positions: {}};
  try {
    return normalizeLayout(JSON.parse(text));
  } catch (err) {
    return {version: 1, positions: {}, error: `布局文件不是合法 JSON：${err.message}`};
  }
}

/** 写手动布局（页面通过 plans 服务保存时调用；CLI 只读）。 */
function writeDbLayout(root, config, value) {
  const normalized = normalizeLayout(value);
  normalized.updatedAt =
    value && typeof value === 'object' && typeof value.updatedAt === 'string'
      ? value.updatedAt
      : new Date().toISOString();
  writeFileSafe(layoutPath(root, config), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/** 深拷贝表模型，避免合并时改坏每个任务自己的 parse 结果。 */
function cloneTable(table) {
  return {
    name: table.name,
    description: table.description || '',
    columns: table.columns.map((column) => ({
      ...column,
      fk: column.fk ? {...column.fk} : null,
      tasks: [],
      conflict: false,
    })),
    primaryKey: [...table.primaryKey],
    uniqueGroups: (table.uniqueGroups || []).map((group) => [...group]),
    fks: (table.fks || []).map((fk) => ({...fk, from: [...fk.from], to: [...fk.to]})),
    indexes: (table.indexes || []).map((index) => ({
      ...index,
      columns: [...index.columns],
      tasks: [],
    })),
    tasks: [],
    conflict: false,
  };
}

/** 两列定义是否一致（用于发现跨任务的 schema 漂移）。 */
function sameColumn(a, b) {
  return (
    a.type === b.type &&
    Boolean(a.notNull) === Boolean(b.notNull) &&
    Boolean(a.pk) === Boolean(b.pk) &&
    Boolean(a.unique) === Boolean(b.unique) &&
    (a.fk ? a.fk.table : '') === (b.fk ? b.fk.table : '') &&
    (a.fk ? a.fk.column : '') === (b.fk ? b.fk.column : '')
  );
}

/** 把同一张表在另一个任务里的定义合并进来；不一致只标记冲突，不覆盖先到的定义。 */
function mergeTableModel(target, incoming, taskName, conflicts) {
  if (!target.tasks.includes(taskName)) target.tasks.push(taskName);
  if (target.primaryKey.join(',') !== incoming.primaryKey.join(',')) {
    target.conflict = true;
    conflicts.push({
      table: target.name,
      detail:
        `主键不一致：${target.tasks.join('、')} 为 (${target.primaryKey.join(', ')})，` +
        `${taskName} 为 (${incoming.primaryKey.join(', ')})`,
    });
  }

  const targetByName = new Map(target.columns.map((column) => [column.name, column]));
  for (const column of incoming.columns) {
    const existing = targetByName.get(column.name);
    if (!existing) {
      target.columns.push({
        ...column,
        fk: column.fk ? {...column.fk} : null,
        tasks: [taskName],
        conflict: true,
      });
      target.conflict = true;
      conflicts.push({table: target.name, detail: `任务 ${taskName} 多出字段 ${column.name}`});
      continue;
    }
    if (!existing.tasks.includes(taskName)) existing.tasks.push(taskName);
    if (!sameColumn(existing, column)) {
      existing.conflict = true;
      target.conflict = true;
      conflicts.push({
        table: target.name,
        detail: `字段 ${column.name} 定义不一致：${existing.type} vs ${column.type}（任务 ${taskName}）`,
      });
    }
  }
  for (const column of target.columns) {
    if (incoming.columns.some((item) => item.name === column.name)) continue;
    column.conflict = true;
    target.conflict = true;
    conflicts.push({table: target.name, detail: `任务 ${taskName} 缺少字段 ${column.name}`});
  }
  for (const index of incoming.indexes || []) {
    const existing = target.indexes.find((item) => item.name === index.name);
    if (!existing) {
      target.indexes.push({...index, columns: [...index.columns], tasks: [taskName]});
      continue;
    }
    if (!existing.tasks) existing.tasks = [];
    if (!existing.tasks.includes(taskName)) existing.tasks.push(taskName);
    if (
      existing.columns.join(',') !== index.columns.join(',') ||
      Boolean(existing.unique) !== Boolean(index.unique)
    ) {
      target.conflict = true;
      conflicts.push({table: target.name, detail: `索引 ${index.name} 定义不一致（任务 ${taskName}）`});
    }
  }
}

/**
 * 合并多个任务的数据模型：同名表合并，冲突只标记；关系去重后保留跨任务连接。
 * @param {Array<{name: string, model: object}>} taskModels - 每个任务的 parseSchema 结果。
 * @returns {{tables: Array<object>, relations: Array<object>, conflicts: Array<object>, issues: Array<object>,
 *   errors: Array<object>, warnings: Array<object>, tasks: Array<object>}} 整体模型。
 */
function mergeModels(taskModels) {
  const tableMap = new Map();
  const conflicts = [];
  const tasks = [];
  for (const item of taskModels) {
    tasks.push({name: item.name, tableCount: item.model.tables.length});
    for (const table of item.model.tables) {
      const existing = tableMap.get(table.name);
      if (!existing) {
        const copy = cloneTable(table);
        copy.tasks = [item.name];
        for (const column of copy.columns) column.tasks = [item.name];
        for (const index of copy.indexes) index.tasks = [item.name];
        tableMap.set(table.name, copy);
        continue;
      }
      mergeTableModel(existing, table, item.name, conflicts);
    }
  }

  const taskOrder = new Map(tasks.map((task, index) => [task.name, index]));
  const mergedTables = [...tableMap.values()].sort(
    (a, b) =>
      (taskOrder.get(a.tasks[0]) === undefined ? 99 : taskOrder.get(a.tasks[0])) -
        (taskOrder.get(b.tasks[0]) === undefined ? 99 : taskOrder.get(b.tasks[0])) ||
      a.name.localeCompare(b.name)
  );

  // 从外键列反推关系：parseSchema 只把「同一任务内」的目标表解析成 relations，
  // 跨任务外键要靠这里按合并后的表集重新连线。
  const relations = [];
  const seen = new Set();
  for (const item of taskModels) {
    for (const table of item.model.tables) {
      for (const column of table.columns) {
        if (!column.fk) continue;
        const target = tableMap.get(column.fk.table);
        if (!target) continue;
        let targetColumn = column.fk.column;
        if (!targetColumn && target.primaryKey.length === 1) targetColumn = target.primaryKey[0];
        if (!targetColumn) continue;
        if (!target.columns.some((candidate) => candidate.name === targetColumn)) continue;
        const key = `${table.name}.${column.name}->${target.name}.${targetColumn}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({
          from: table.name,
          fromColumn: column.name,
          to: target.name,
          toColumn: targetColumn,
          oneToOne: Boolean(
            column.unique || (table.primaryKey.length === 1 && table.primaryKey[0] === column.name)
          ),
          tasks: [item.name],
        });
      }
    }
  }

  const lint = lintModel({tables: mergedTables, relations});
  return {
    tables: mergedTables,
    relations,
    conflicts,
    tasks,
    issues: [...lint.errors, ...lint.warnings],
    errors: lint.errors,
    warnings: lint.warnings,
  };
}

/** 读任务页状态（整体图的任务筛选用；没有任务页就当进行中）。 */
function readTaskStatus(root, config, task) {
  const preset = (config.presets && config.presets.prototype) || {};
  const page = path.join(root, prototypeDir(config), task, preset.progressPage || 'progress.html');
  const text = readIfExists(page) || '';
  return (/data-task-status="([^"]*)"/.exec(text) || [])[1] || '进行中';
}

/**
 * 读取仓库里所有任务的 schema.sql 并合并成整体模型。
 * 没有 schema 的任务列在 missing 里，不影响其他任务出图。
 */
function loadOverall(root, config) {
  const dir = path.join(root, prototypeDir(config));
  const specs = path.join(root, specsDir(config));
  const items = [];
  const missing = [];
  if (isDir(dir)) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const schemaFile = path.join(specs, entry.name, 'schema.sql');
      if (!exists(schemaFile)) {
        missing.push(entry.name);
        continue;
      }
      const schema = readIfExists(schemaFile) || '';
      let model = {tables: [], relations: []};
      let parseError = null;
      try {
        model = parseSchema(schema);
      } catch (err) {
        parseError = err.message;
      }
      items.push({name: entry.name, model, parseError, schema});
    }
  }

  const merged = mergeModels(items);
  for (const item of items) {
    if (!item.parseError) continue;
    const issue = {
      id: 'DB000',
      level: 'error',
      message: `${item.name}: schema.sql 解析失败：${item.parseError}`,
      task: item.name,
    };
    merged.issues.push(issue);
    merged.errors.push(issue);
  }

  const layout = readDbLayout(root, config);
  return {
    project: config.project.name,
    tasks: merged.tasks.map((task) => {
      const item = items.find((entry) => entry.name === task.name);
      return {
        ...task,
        status: readTaskStatus(root, config, task.name),
        schema: item ? item.schema : '',
      };
    }),
    missing,
    tables: merged.tables,
    relations: merged.relations,
    conflicts: merged.conflicts,
    issues: merged.issues,
    errors: merged.errors,
    warnings: merged.warnings,
    layout,
    layoutFile: toPosix(path.relative(root, layoutPath(root, config))),
    counts: {
      tables: merged.tables.length,
      relations: merged.relations.length,
      columns: merged.tables.reduce((sum, table) => sum + table.columns.length, 0),
      conflicts: merged.conflicts.length,
      errors: merged.errors.length,
      warnings: merged.warnings.length,
    },
  };
}

/** 把对象安全地嵌进 <script>：转义 < 与模板标记。 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\{\{/g, '{\\u007b');
}

/**
 * 生成整体数模图 prototype/db.html：可拖动实体、缩放平移、保存 / 导入布局。
 * @param {object} overall - loadOverall 的结果。
 * @param {{generatedAt: string}} meta - 生成时间。
 * @returns {string} HTML。
 */
function renderOverviewPage(overall, meta) {
  const layout = normalizeLayout(overall.layout || {});
  const tasks = overall.tasks.map((task) => ({
    name: escapeHtml(task.name),
    status: escapeHtml(task.status),
    tableCount: task.tableCount,
  }));
  const tables = overall.tables.map((table) => ({
    name: escapeHtml(table.name),
    description: escapeHtml(table.description || ''),
    taskAttr: escapeHtml(table.tasks.join(',')),
    taskList: table.tasks.map((task) => escapeHtml(task)),
    columnCount: table.columns.length,
    conflict: Boolean(table.conflict),
    columns: table.columns.map((column) => ({
      name: escapeHtml(column.name),
      type: escapeHtml(column.type),
      description: escapeHtml(column.description || ''),
      pk: Boolean(column.pk) || table.primaryKey.includes(column.name),
      fk: Boolean(column.fk),
      unique: Boolean(column.unique),
      notNull: Boolean(column.notNull),
      conflict: Boolean(column.conflict),
    })),
  }));
  const conflicts = overall.conflicts.map((conflict) => ({
    table: escapeHtml(conflict.table),
    detail: escapeHtml(conflict.detail),
  }));
  const issues = overall.issues.map((issue) => ({
    id: escapeHtml(issue.id),
    level: issue.level,
    levelLabel: issue.level === 'error' ? '错误' : '警告',
    message: escapeHtml(issue.message),
    hint: issue.hint ? escapeHtml(issue.hint) : '',
  }));
  const relationships = overall.relations.map((relation) => {
    const fromTable = overall.tables.find((table) => table.name === relation.from);
    const toTable = overall.tables.find((table) => table.name === relation.to);
    const fromColumn =
      fromTable && fromTable.columns.find((column) => column.name === relation.fromColumn);
    const prefix =
      fromColumn && fromColumn.description
        ? `${fromColumn.description.replace(/[。.;；]$/, '')}。`
        : '';
    return {
      from: escapeHtml(relation.from),
      fromColumn: escapeHtml(relation.fromColumn),
      to: escapeHtml(relation.to),
      toColumn: escapeHtml(relation.toColumn),
      cardinality: relation.oneToOne ? '1:1' : 'N:1',
      description: escapeHtml(
        `${prefix}${relationSentence(fromTable, relation.fromColumn, toTable, relation.toColumn, relation.oneToOne)}`
      ),
      tasks: escapeHtml((relation.tasks || []).join('、')),
    };
  });
  const schemas = overall.tasks.map((task) => ({
    name: escapeHtml(task.name),
    schema: escapeHtml(task.schema || '（空 schema.sql）'),
  }));
  return render(loadTemplate('dbOverview'), {
    project: escapeHtml(overall.project),
    generatedAt: escapeHtml(meta.generatedAt),
    tableCount: overall.counts.tables,
    relationCount: overall.counts.relations,
    columnCount: overall.counts.columns,
    conflictCount: overall.counts.conflicts,
    errorCount: overall.counts.errors,
    warningCount: overall.counts.warnings,
    taskCount: tasks.length,
    tasks,
    missing: (Array.isArray(overall.missing) ? overall.missing : []).map((name) => escapeHtml(name)),
    tables,
    conflicts,
    issues,
    hasTables: overall.tables.length > 0,
    hasTasks: tasks.length > 0,
    hasRelations: overall.relations.length > 0,
    relationships,
    schemas,
    hasSchemas: schemas.length > 0,
    layoutJson: jsonForScript(layout),
    relationsJson: jsonForScript(
      overall.relations.map((relation) => ({
        from: relation.from,
        fromColumn: relation.fromColumn,
        to: relation.to,
        toColumn: relation.toColumn,
        oneToOne: relation.oneToOne,
      }))
    ),
    layoutFile: escapeHtml(overall.layoutFile || DB_LAYOUT_FILE),
  });
}

module.exports = {
  RESERVED,
  parseSchema,
  lintModel,
  hasLeadingIndex,
  mermaidType,
  mermaidId,
  renderMermaid,
  renderErPage,
  groupFieldRows,
  renderDatabaseBlock,
  syncDatabaseDoc,
  renderOverviewPage,
  loadOverall,
  mergeModels,
  normalizeLayout,
  readDbLayout,
  writeDbLayout,
  DB_LAYOUT_FILE,
  escapeHtml,
  markdownCell,
  stripComments,
  splitStatements,
};
