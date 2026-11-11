# Privacy Policy

Effective date: 2026-11-11

Harness CLI is a local developer tool distributed with the
`dsh-plugin-harness-cli` plugin. This policy explains how the plugin handles
data.

## Data the plugin accesses

The plugin reads and writes files only in the target repository explicitly
provided to each `harness_cli_*` tool or CLI command. Those files can include
source code, project configuration, task documents, and generated progress
pages.

## Data collection and transmission

The plugin does not operate an external service, collect telemetry, create user
profiles, or transmit project data to the plugin developer. It does not make
external network requests.

The optional `plans --serve` dashboard listens only on `127.0.0.1`. It accepts
same-origin requests from the local dashboard and does not send dashboard data
elsewhere.

When the plugin is used through Codex, ChatGPT, DSH, or another host, prompts
and files that the host sends to a model are processed by that host under its
own privacy policy and terms. This policy does not replace the host's policy.

## Storage and retention

Generated files remain in the target repository until the user or a tool
deletes them. The plugin does not keep a separate hosted database or remote
backup. The local dashboard keeps task state in memory only while the server
process is running.

## Third-party components

The package bundles third-party libraries for offline code-style and
commit-message checks. Their licenses are included with the bundled files.

## Contact

Questions or privacy reports can be submitted at
<https://github.com/gouqingping/dsh-plugin-harness-cli/issues>.

## Changes

Material changes to this policy will be published in this repository with an
updated effective date.
