'use strict';

/**
 * 数据库设计单测：DDL 解析、Google 数模规范判定、Mermaid / 离线数模图生成。
 * 这里同时保留「判定真的会失败」的反向用例，避免规则只写在文档里。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  parseSchema,
  lintModel,
  hasLeadingIndex,
  mermaidType,
  renderMermaid,
  renderErPage,
  mergeModels,
  renderOverviewPage,
  syncDatabaseDoc,
  stripComments,
} = require('../src/db.js');

const VALID_SQL = `
-- 用户与登录尝试
CREATE TABLE user_account (
  user_account_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_attempt (
  login_attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_account_id bigint NOT NULL REFERENCES user_account (user_account_id),
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_attempt_user_account_id ON login_attempt (user_account_id);
CREATE UNIQUE INDEX uq_login_attempt_id ON login_attempt (login_attempt_id);
`;

test('parseSchema：解析表、主键、外键、索引与关系', () => {
  const model = parseSchema(VALID_SQL);
  assert.deepStrictEqual(model.tables.map((table) => table.name), ['user_account', 'login_attempt']);

  const users = model.tables[0];
  assert.deepStrictEqual(users.primaryKey, ['user_account_id']);
  assert.strictEqual(users.columns.find((column) => column.name === 'email').unique, true);
  assert.strictEqual(users.columns.find((column) => column.name === 'created_at').notNull, true);

  const attempts = model.tables[1];
  const fk = attempts.columns.find((column) => column.name === 'user_account_id');
  assert.deepStrictEqual(fk.fk, {table: 'user_account', column: 'user_account_id'});
  assert.strictEqual(attempts.indexes.length, 2);
  assert.ok(hasLeadingIndex(attempts, 'user_account_id'));

  assert.strictEqual(model.relations.length, 1);
  assert.deepStrictEqual(model.relations[0], {
    from: 'login_attempt',
    fromColumn: 'user_account_id',
    to: 'user_account',
    toColumn: 'user_account_id',
    oneToOne: false,
  });
  assert.deepStrictEqual(lintModel(model).errors, []);
});

test('parseSchema：解析 COMMENT ON / 行尾说明并挂到表与字段', () => {
  const model = parseSchema(`
    CREATE TABLE user_account (
      user_account_id bigint PRIMARY KEY, -- 用户主键
      email varchar(255) NOT NULL,        -- 登录邮箱
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    COMMENT ON TABLE user_account IS '用户账号';
    COMMENT ON COLUMN user_account.created_at IS '创建时间';
  `);
  const table = model.tables[0];
  assert.strictEqual(table.description, '用户账号');
  assert.strictEqual(table.columns.find((column) => column.name === 'user_account_id').description, '用户主键');
  assert.strictEqual(table.columns.find((column) => column.name === 'email').description, '登录邮箱');
  assert.strictEqual(table.columns.find((column) => column.name === 'created_at').description, '创建时间');
});

test('lintModel：缺表说明 / 缺字段说明给 warning（不拦通过）', () => {
  const model = parseSchema(`
    CREATE TABLE bare_entity (
      bare_entity_id bigint PRIMARY KEY,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `);
  const lint = lintModel(model);
  assert.deepStrictEqual(lint.errors, []);
  const ids = lint.warnings.map((issue) => issue.id);
  assert.ok(ids.includes('DB014'), '整张表缺说明应为 DB014');
  assert.ok(ids.includes('DB015'), '字段缺说明应为 DB015');
});

test('parseSchema：注释 / 字符串 / 复合外键与表级约束', () => {
  const sql = `
    -- CREATE TABLE ignored (id int);
    /* CREATE TABLE also_ignored (id int); */
    CREATE TABLE parent_entity (
      tenant_id bigint NOT NULL,
      parent_entity_id bigint NOT NULL,
      note text DEFAULT 'a;b',
      PRIMARY KEY (tenant_id, parent_entity_id),
      UNIQUE (tenant_id, parent_entity_id)
    );
    CREATE TABLE child_entity (
      tenant_id bigint NOT NULL,
      child_entity_id bigint NOT NULL,
      parent_entity_id bigint NOT NULL,
      CONSTRAINT pk_child PRIMARY KEY (tenant_id, child_entity_id),
      CONSTRAINT fk_child_parent FOREIGN KEY (tenant_id, parent_entity_id)
        REFERENCES parent_entity (tenant_id, parent_entity_id)
    );
    CREATE INDEX idx_child_parent ON child_entity (tenant_id, parent_entity_id);
  `;
  const model = parseSchema(sql);
  assert.deepStrictEqual(model.tables.map((table) => table.name), ['parent_entity', 'child_entity']);
  assert.deepStrictEqual(model.tables[0].primaryKey, ['tenant_id', 'parent_entity_id']);
  assert.strictEqual(model.tables[0].columns.find((column) => column.name === 'note').type, 'text');
  const child = model.tables[1];
  assert.deepStrictEqual(child.primaryKey, ['tenant_id', 'child_entity_id']);
  assert.strictEqual(child.columns.find((column) => column.name === 'parent_entity_id').fk.table, 'parent_entity');
  assert.strictEqual(model.relations.length, 2, '复合外键按列展开为两条关系');
  const stripped = stripComments("SELECT '--not comment'; -- real");
  assert.ok(stripped.includes('--not comment'), '字符串里的 -- 不能被当成注释');
  assert.ok(!stripped.includes('real'), '真正的行注释必须被去掉');
});

test('lintModel：缺主键 / 浮点金额 / 外键无索引都会失败', () => {
  const model = parseSchema(`
    CREATE TABLE user_account (
      user_account_id bigint PRIMARY KEY,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE broken_entity (
      amount float NOT NULL,
      user_account_id bigint REFERENCES user_account (user_account_id)
    );
  `);
  const lint = lintModel(model);
  const ids = lint.errors.map((issue) => issue.id);
  assert.ok(ids.includes('DB004'), '缺主键必须报 DB004');
  assert.ok(ids.includes('DB010'), '金额用 float 必须报 DB010');
  assert.ok(ids.includes('DB007'), '外键没索引必须报 DB007');
  assert.ok(lint.warnings.some((issue) => issue.id === 'DB009'), '缺审计时间应给出警告');
});

test('lintModel：非法命名 / 保留字 / 悬空外键都会失败', () => {
  const model = parseSchema(`
    CREATE TABLE "User" (
      "Id" bigint PRIMARY KEY
    );
    CREATE TABLE child_entity (
      child_entity_id bigint PRIMARY KEY,
      missing_id bigint REFERENCES missing_table (missing_id)
    );
  `);
  const lint = lintModel(model);
  const ids = lint.errors.map((issue) => issue.id);
  assert.ok(ids.includes('DB002'), '表名不是 snake_case');
  assert.ok(ids.includes('DB003'), '字段名不是 snake_case');
  assert.ok(ids.includes('DB008'), 'User 是保留字');
  assert.ok(ids.includes('DB005'), '外键指向不存在的表');
});

test('renderMermaid：输出实体、主外键与 1:N 关系', () => {
  const model = parseSchema(VALID_SQL);
  const mermaid = renderMermaid({...model, ...lintModel(model)});
  assert.match(mermaid, /^%% /);
  assert.match(mermaid, /erDiagram/);
  assert.match(mermaid, /user_account \{/);
  assert.match(mermaid, /bigint user_account_id PK/);
  assert.match(mermaid, /bigint user_account_id FK/);
  assert.match(mermaid, /user_account \|\|--o\{ login_attempt : "user_account_id"/);
});

test('renderErPage：生成实体卡与可解析的关系数据，空模型给出空状态', () => {
  const model = parseSchema(VALID_SQL);
  const full = {...model, ...lintModel(model)};
  const html = renderErPage(full, {
    task: 'login-flow',
    project: 'demo',
    generatedAt: '2026-11-11T00:00:00.000Z',
    schemaPath: 'docs/specs/login-flow/schema.sql',
    mermaidPath: 'docs/specs/login-flow/er.mmd',
  });
  assert.match(html, /data-table="user_account"/);
  assert.match(html, /data-table="login_attempt"/);
  assert.match(html, /data-col="user_account_id"/);
  assert.ok(!html.includes('{{'), '模板占位符必须全部被替换');
  const match = /var MODEL = (\{[\s\S]*?\});/.exec(html);
  assert.ok(match, '应嵌入关系数据');
  const relations = JSON.parse(match[1]).relations;
  assert.strictEqual(relations.length, 1);
  assert.strictEqual(relations[0].to, 'user_account');

  const empty = renderErPage({tables: [], relations: []}, {
    task: 'empty',
    project: 'demo',
    generatedAt: 'now',
    schemaPath: 's.sql',
    mermaidPath: 's.mmd',
  });
  assert.match(empty, /还没有表/);
  assert.ok(!empty.includes('id="er"'));
});

test('renderErPage：schema 里的尖括号 / 引号会被转义，不会注入页面', () => {
  const model = parseSchema('CREATE TABLE evil_entity (evil_entity_id bigint PRIMARY KEY, "<x>" int);');
  const html = renderErPage({...model, ...lintModel(model)}, {
    task: '<b>task</b>',
    project: 'p',
    generatedAt: 'n',
    schemaPath: 's',
    mermaidPath: 'm',
  });
  assert.ok(!html.includes('<b>task</b>'));
  assert.ok(!html.includes('"<x>"'));
  assert.match(html, /&lt;b&gt;task&lt;\/b&gt;/);
});

test('mermaidType：常见类型映射到 Mermaid 单词类型', () => {
  assert.strictEqual(mermaidType('varchar(255)'), 'string');
  assert.strictEqual(mermaidType('numeric(19,4)'), 'decimal');
  assert.strictEqual(mermaidType('timestamp with time zone'), 'timestamp');
  assert.strictEqual(mermaidType('uuid'), 'uuid');
  assert.strictEqual(mermaidType('jsonb'), 'json');
  assert.strictEqual(mermaidType('bigint'), 'bigint');
});

test('renderErPage：关系说明与字段说明落到页面（含来源列 / 基数 / 描述）', () => {
  const model = parseSchema(`
    CREATE TABLE user_account (
      user_account_id bigint PRIMARY KEY, -- 用户主键
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    COMMENT ON TABLE user_account IS '用户账号';
    CREATE TABLE login_attempt (
      login_attempt_id bigint PRIMARY KEY,
      user_account_id bigint NOT NULL REFERENCES user_account (user_account_id), -- 所属账号
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE INDEX idx_login_attempt_user ON login_attempt (user_account_id);
  `);
  const html = renderErPage({...model, ...lintModel(model)}, {
    task: 'login',
    project: 'demo',
    generatedAt: 'now',
    schemaPath: 's.sql',
    mermaidPath: 's.mmd',
  });
  assert.match(html, /关系说明/);
  assert.match(html, /字段说明/);
  assert.match(html, /login_attempt\.user_account_id/);
  assert.match(html, /N:1/);
  assert.match(html, /所属账号/);
  assert.match(html, /用户账号/);
});

test('syncDatabaseDoc：把 schema 的关系 / 字段说明反填进 database.md 受管区块', () => {
  const model = parseSchema(`
    CREATE TABLE user_account (
      user_account_id bigint PRIMARY KEY, -- 用户主键
      email varchar(255) NOT NULL, -- 登录邮箱
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    COMMENT ON TABLE user_account IS '用户账号';
    COMMENT ON COLUMN user_account.created_at IS '创建时间';
    COMMENT ON COLUMN user_account.updated_at IS '更新时间';
    CREATE TABLE login_attempt (
      login_attempt_id bigint PRIMARY KEY,
      user_account_id bigint NOT NULL REFERENCES user_account (user_account_id), -- 所属账号
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    COMMENT ON TABLE login_attempt IS '登录尝试';
    COMMENT ON COLUMN login_attempt.login_attempt_id IS '尝试主键';
    COMMENT ON COLUMN login_attempt.created_at IS '创建时间';
    COMMENT ON COLUMN login_attempt.updated_at IS '更新时间';
    CREATE INDEX idx_login_attempt_user ON login_attempt (user_account_id);
  `);
  const source = '# 登录 · 数据模型\n\n人工写的目标与边界。\n';
  const first = syncDatabaseDoc(source, model);
  assert.match(first, /人工写的目标与边界/);
  assert.match(first, /harness-db:begin/);
  assert.match(first, /关系说明/);
  assert.match(first, /字段说明/);
  assert.match(first, /所属账号/);
  assert.match(first, /多条登录尝试（login_attempt）记录/);
  assert.strictEqual((first.match(/harness-db:begin/g) || []).length, 1);

  const second = syncDatabaseDoc(first, model);
  assert.strictEqual(second, first, '同一模型重复反填应幂等');
});

test('renderOverviewPage：整体图展示关系说明与各任务 schema.sql 源码', () => {
  const a = parseSchema('CREATE TABLE user_account (user_account_id bigint PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);\nCOMMENT ON TABLE user_account IS \'用户账号\';');
  const b = parseSchema(`
    CREATE TABLE login_attempt (
      login_attempt_id bigint PRIMARY KEY,
      user_account_id bigint NOT NULL REFERENCES user_account (user_account_id),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE INDEX idx_login_attempt_user ON login_attempt (user_account_id);
    COMMENT ON TABLE login_attempt IS '登录尝试';
  `);
  const merged = mergeModels([
    {name: '任务A', model: a},
    {name: '任务B', model: b},
  ]);
  const overall = {
    project: 'demo',
    ...merged,
    tasks: [
      {name: '任务A', status: '进行中', tableCount: 1, schema: 'CREATE TABLE user_account (...);'},
      {name: '任务B', status: '进行中', tableCount: 1, schema: 'CREATE TABLE login_attempt (...);'},
    ],
    missing: [],
    layout: {positions: {}},
    layoutFile: 'prototype/db-layout.json',
    counts: {
      tables: merged.tables.length,
      relations: merged.relations.length,
      columns: merged.tables.reduce((sum, table) => sum + table.columns.length, 0),
      conflicts: 0,
      errors: merged.errors.length,
      warnings: merged.warnings.length,
    },
  };
  const html = renderOverviewPage(overall, {generatedAt: 'now'});
  assert.match(html, /关系说明/);
  assert.match(html, /schema.sql 源码/);
  assert.match(html, /CREATE TABLE login_attempt/);
  assert.match(html, /多条登录尝试/);
  assert.ok(!html.includes('{{'));
});

test('字段说明：字段名 / 类型 / 约束 / 说明相同的行合并所属表', () => {
  const model = parseSchema(`
    CREATE TABLE user_account (
      user_account_id bigint PRIMARY KEY,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    COMMENT ON TABLE user_account IS '用户账号';
    COMMENT ON COLUMN user_account.created_at IS '创建时间';
    COMMENT ON COLUMN user_account.updated_at IS '更新时间';
    CREATE TABLE login_attempt (
      login_attempt_id bigint PRIMARY KEY,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    COMMENT ON TABLE login_attempt IS '登录尝试';
    COMMENT ON COLUMN login_attempt.created_at IS '创建时间';
    COMMENT ON COLUMN login_attempt.updated_at IS '更新时间';
  `);
  const doc = syncDatabaseDoc('', model);
  assert.match(doc, /\| `user_account`、`login_attempt` \| `created_at` \| timestamptz \| NOT NULL \| 创建时间 \|/);
  assert.match(doc, /\| `user_account`、`login_attempt` \| `updated_at` \| timestamptz \| NOT NULL \| 更新时间 \|/);
  assert.strictEqual((doc.match(/\| `created_at` \|/g) || []).length, 1, '相同行应只有一条');
  assert.strictEqual((doc.match(/\| `updated_at` \|/g) || []).length, 1);
});
