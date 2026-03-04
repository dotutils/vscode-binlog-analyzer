# Changelog

## 0.2.0 (Preview)

### New Features
- **`/perf` command** — deep performance analysis with prioritized actionable optimization suggestions (🔴 high / 🟡 medium / 🟢 quick wins)
- **`/incremental` command** — analyze build incrementality using target skip/execution ratios, find targets that rebuild unnecessarily
- **Copy support** — Ctrl+C copies selected tree item; right-click context menu on errors, warnings, perf items; "Copy All Errors/Warnings" on section headers
- **`.binlog` file association** — open `.binlog` files directly in VS Code via File > Open or drag & drop

### Improvements
- **Faster activation** — reduced startup delays by ~2.5s (MCP fast-retry, earlier settings load, `workspaceContains` activation)
- **Better performance prompts** — system prompt includes MSBuild optimization playbook mapping targets to specific properties/flags
- **Fixed tool names** — system prompt now references correct MCP server tools (`search_binlog`, `search_targets_by_name`, etc.)
- **Fixed Slowest Tasks** showing 0ms — parser now checks `totalDurationMs` field

### Bug Fixes
- Fixed `load_binlog` parameter discovery (uses `listTools()` to find correct param name)
- Fixed baronfel.binlog.mcp link in README

## 0.1.0 (Preview)

### Features
- **@binlog Chat Participant** — ask Copilot about your build with `/errors`, `/timeline`, `/targets`, `/summary`, `/secrets`, `/compare`
- **Build Analysis Chat Mode** — pre-configured Copilot Chat mode with MCP tools
- **Binlog Explorer** sidebar — projects, errors, warnings, performance tree view
- **Fix All Issues** — one-click action to fix all build warnings/errors with Copilot agent
- **Multi-binlog support** — load, add, remove, and compare multiple binlogs
- **Cross-machine detection** — auto-detects binlogs from other machines, prompts for local source
- **Set workspace folder** — smart folder picker with suggestions from binlog project paths
- **Secrets detection & redaction** — scan and redact credentials from binlogs
- **Structured Log Viewer integration** — one-click "Open in VS Code" from WPF viewer
- **Auto-install MCP server** — installs `baronfel.binlog.mcp` dotnet tool automatically
- **Problems panel integration** — build diagnostics as VS Code diagnostics
- **Telemetry** — anonymized usage tracking (respects VS Code settings)
