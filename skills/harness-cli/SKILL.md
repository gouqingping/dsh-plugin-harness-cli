---
name: harness-cli
description: Use when a user asks to initialize, generate, validate, review, or advance a repository's Harness project configuration with the bundled harness_cli_* tools, including AGENTS.md, environment or gate setup, feature scope, DDD/SDD/TDD task documents, progress pages, business wiki, and delivery checks.
license: CC0-1.0
---

# Harness CLI

Use this workflow to make a repository's collaboration rules explicit and machine-checkable.
The MCP server and the bundled CLI share the same implementation; use the MCP tools when available.

## Before changing a project

Ask the user to choose:

1. **Manual**: confirm every write, overwrite, plan confirmation, and deletion.
2. **Automatic loop**: proceed automatically and use the recommended option for confirmations and choices.

Do not modify the target project before the user answers.

## Tool contract

Every `harness_cli_*` MCP tool requires an absolute `root` path for the target repository.
Use the current workspace path when the user clearly selected that workspace; ask when the target is ambiguous.
Do not use the plugin installation directory as the target.

Prefer `dry_run: true` for the first write-oriented call when the user has not already seen the planned files.
Do not hand-edit generated `AGENTS.md`; edit `harness-cli.json`, then call `harness_cli_agents`.

Available tools:

| Tool | Purpose |
|---|---|
| `harness_cli_init` | Create the Harness skeleton |
| `harness_cli_agents` | Regenerate `AGENTS.md` from `harness-cli.json` |
| `harness_cli_check` | Read-only project gate |
| `harness_cli_doctor` | Read-only tool and environment self-check |
| `harness_cli_page` | Create one task page and its four spec documents |
| `harness_cli_plan` | Update `docs/specs/<task>/` only; fill the page/plan skeleton only when the task has not started, then confirm |
| `harness_cli_review` | Review task documents and write the fingerprint |
| `harness_cli_progress` | Record the only supported task-progress updates |
| `harness_cli_ui` | Generate an Ant Design v5 style UI design |
| `harness_cli_ux` | Analyze the whole project's UX and requirements; write `prototype/ux.html`, `prototype/<task>/ux/index.html`, persistent project requirements and a closable gap list |
| `harness_cli_sql` | Design the database schema and regenerate the Mermaid / offline ER diagram |
| `harness_cli_wiki` | Generate or update the business wiki |
| `harness_cli_delete` | Delete one task workspace (the slash command supports multi-select) |
| `harness_cli_style` | Run the bundled code-style and commit-message gate |

## Recommended workflow

1. Call `harness_cli_doctor` to verify the bundle and Node runtime.
2. Call `harness_cli_init` with `dry_run: true`, then apply it after the user's mode allows.
3. Read or update `harness-cli.json` to match the project.
4. Call `harness_cli_agents`, then `harness_cli_check`.
5. For UX, call `harness_cli_ux` (the overall report always covers every task; `tasks` only limits what gets written back). Read the generated `prototype/ux.html`, fill the blocking gaps, close confirmed items one by one with `resolve: ["G-xxxxxxxx"]`, then use `apply: true` (directly related tasks are refreshed too) or create a task.
6. For a task, create the page first (`page`; in DSH it asks UX → database → UI and links them), then run `plan` to fill docs/specs, review it, confirm when required, and record progress after each step.
7. Run `harness_cli_check` before reporting delivery.

## Confirmations and destructive work

- Explain which paths will be replaced before calling any tool with `force: true`.
- Call `harness_cli_plan` with `confirm: true` only after the user approves the current plan.
- Call `harness_cli_delete` only after explicit user approval, and only with `yes: true`.
- If `check` fails, fix the listed cause; never bypass or silently downgrade the gate.

## CLI fallback

If the MCP tools are unavailable, run the installed executable from the target repository:

```sh
dsh-plugin-harness-cli <command> --root <absolute-target-root>
```

Run `dsh-plugin-harness-cli help` for exact arguments. Exit codes are `0` pass, `1` violation,
and `2` tool or configuration failure.
