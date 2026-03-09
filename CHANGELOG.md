# Changelog

## 0.4.0 (Preview)

### Improvements
- **Workspace mismatch warning** — when loading a binlog from a different project, shows a non-intrusive warning with "Set Workspace Folder" button instead of auto-reloading
- **Smarter project label** — Projects node shows the binlog's source directory name when workspace doesn't match, instead of a stale workspace name
- **No more file pollution** — removed `binlog-instructions.md` / `copilot-instructions.md` creation; extension no longer writes any files to your project directory
- **Clean folder open** — "Set Workspace Folder" uses `vscode.openFolder` for a clean transition without multi-root workspace prompts
- **Binlog persistence across reloads** — binlog paths survive window reloads (workspace folder changes) via globalState, auto-loading silently on re-activation

### Bug Fixes
- **Fixed extension self-activating** — removed over-eager globalState auto-loading that caused the extension to steal chat focus on every VS Code startup; now only auto-loads from `activeBinlogs` setting or globalState (with narrow activation events)
- **Fixed "save workspace" dialog** — replaced `updateWorkspaceFolders` with `vscode.openFolder` to avoid VS Code prompting to save untitled workspace files
- **Fixed timeline button showing without binlog** — gated behind `binlog.hasLoadedBinlogs` context key

## 0.3.0 (Preview)

### New Features
- **📊 Build Timeline webview** — visual horizontal bar chart of target/task durations and project build times with summary stats
- **📊 Comparison Timeline webview** — side-by-side bar chart comparing two binlogs with per-item % delta, NEW/REMOVED badges, and color-coded faster/slower indicators
- **🔍 CodeLens on project files** — `.csproj`/`.vbproj`/`.fsproj` files show "Analyze with @binlog", error/warning counts, and "Build Timeline" as clickable CodeLens
- **💡 Quick Fix code actions** — "Fix with Copilot" and "Suppress with #pragma" quick fixes on every binlog diagnostic in the Problems panel
- **🔗 Open in Structured Log Viewer** — right-click a loaded binlog in the tree to open in the desktop app (with fallback to download if not installed)
- **📊 Enhanced status bar** — shows error/warning counts alongside binlog count (e.g., `📄 2 binlogs · ⚠ 5 · ❌ 12`)

### Bug Fixes
- **Fixed Problems panel** — was always empty; now populates from MCP `get_diagnostics` data with click-to-navigate to source file and line
- **Fixed false "rebuild detected" notifications** — now checks file `mtime` instead of reacting to access-only filesystem events
- **Fixed workspace folder switch losing binlogs** — binlog paths now persist in `globalState`; workspace folder changes re-apply MCP config and copilot instructions automatically
- **Fixed "Set workspace folder" appending instead of replacing** — now replaces all workspace folders with the selected one
- **Fixed chat participant crashing on tool history** — corrupted tool call/result history from previous turns no longer causes `invalid_request_body` errors; auto-retries with fresh context
- **Fixed stale MCP server entries** — cleans up broken `binlog-mcp` entries with bare command names from workspace settings

### Improvements
- **Zero duplicate MCP calls** — diagnostics provider reuses tree view's prefetched data via event instead of making a separate `get_diagnostics` call
- **Progress notifications** — workspace folder changes show "Setting workspace folder..." progress
- **Binlog Explorer re-focuses** after workspace folder changes
- **Cross-machine dialog** now routes to smart `setWorkspaceFolder` with candidate detection

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
