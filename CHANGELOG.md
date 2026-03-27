# Changelog

## 0.10.8 (Preview)

### New
- **CI/CD integration** — download binlogs directly from Azure DevOps Pipelines and GitHub Actions:
  - Browse pipelines and runs, or paste a build URL to skip straight to artifacts
  - Filter builds by current branch, branch name, or PR number
  - Auto-detects platform from git remote; supports manual org/project entry
  - Remembers recent org/project per workspace for quick access
  - Works without `az` CLI for public Azure DevOps projects (direct REST API)
  - Supports both pipeline artifacts and build artifacts with size display
- **Configurable chat tools** — two new settings control which tools the `@binlog` chat participant can use:
  - `binlogAnalyzer.chat.includeAllTools` — expose all available tools to the model
  - `binlogAnalyzer.chat.additionalToolPatterns` — selectively include extra tools by name pattern
- **Configurable MCP server args** — `binlogAnalyzer.mcpServerArgs` setting with `${binlog}` placeholder for alternative MCP servers
- **Compare button in tree view** — diff icon in title bar when 2+ binlogs are loaded

### Fixed
- **Persistent loading bar removed** — tree view prefetch runs silently in background

## 0.10.6 (Preview)

### New
- **Configurable chat tools** — two new settings control which tools the `@binlog` chat participant can use:
  - `binlogAnalyzer.chat.includeAllTools` — expose all available tools (file editing, terminal, other MCPs) to the model
  - `binlogAnalyzer.chat.additionalToolPatterns` — selectively include extra tools by name pattern
- **Compare button in tree view** — a diff icon appears in the Binlog Explorer title bar when 2+ binlogs are loaded, giving quick access to the comparison timeline

### Fixed
- **Persistent loading bar removed** — the tree view no longer shows a loading indicator during background cache warming; prefetch runs silently

## 0.9.0 (Preview)

### Breaking
- **Unified on BinlogInsights.Mcp** — both the tree view and Copilot Chat now use [BinlogInsights.Mcp](https://www.nuget.org/packages/BinlogInsights.Mcp). The `baronfel.binlog.mcp` dependency is no longer required.
- **Removed secrets commands** — `Binlog: Scan for Secrets` and `Binlog: Redact Secrets` commands removed (were non-functional stubs). Use `@binlog /secrets` for guidance on using Structured Log Viewer for secrets scanning and redaction.
- **Removed redaction settings** — `binlogAnalyzer.redaction.*` settings removed (depended on uninstalled BinlogTool).

### New
- **Per-project CodeLens diagnostics** — error/warning counts on `.csproj` files now show counts for that specific project, not global totals.

### Fixed
- **Removed stdout logging workaround** — BinlogInsights.Mcp 0.2.0 fixes the console logging bug; `Logging__Console__LogToStandardErrorThreshold` env var no longer needed.

## 0.8.2 (Preview)

### New
- **Skip Restore option in Build & Collect** — quick pick to run `--no-restore`, producing a cleaner binlog focused on compilation (skips noisy NuGet restore entries)
- **Improved summary view** — filters out restore-phase project entries (`_IsProjectRestoreSupported`), shows project filenames instead of full paths, per-project ✅/❌ status with error/warning counts, sorted by duration

## 0.8.1 (Preview)

### Bug Fixes
- **Fixed Copilot Chat hanging** — BinlogInsights.Mcp console logging was corrupting stdout JSON-RPC; added env var workaround to redirect logs to stderr
- **Fixed chat not auto-opening** — `configureMcpServer` was blocking on cold start; now fire-and-forget for settings write
- **Fixed chat not opening from Structured Log Viewer** — `activeBinlogs` path now treated as interactive

## 0.8.0 (Preview)

### New
- **BinlogInsights.Mcp integration** — Copilot Chat now uses [BinlogInsights.Mcp](https://www.nuget.org/packages/BinlogInsights.Mcp) (28 tools) for AI-assisted build investigation, replacing baronfel.binlog.mcp for Copilot Chat
- **New slash commands** — `/perf` (deep performance analysis with severity thresholds) and `/incremental` (build incrementality report)
- **New MCP tools available** — `binlog_overview`, `binlog_imports`, `binlog_items`, `binlog_nuget`, `binlog_compiler`, `binlog_preprocess`, `binlog_compare` and more
- **No `load_binlog` step** — BinlogInsights handles loading per-tool call, eliminating a common failure mode

### Changed
- **`/secrets` command** — now directs users to use [MSBuild Structured Log Viewer](https://msbuildlog.com/) for reliable secrets scanning and redaction, with a note that you can launch it directly from the extension
- **Updated system prompts** — all chat prompts reference BinlogInsights tool names for better Copilot accuracy
- **Auto-install** — extension auto-installs `BinlogInsights.Mcp` dotnet tool on first use

## 0.7.3 (Preview)

### Improvements
- **Dev Drive recommendation** — suggests enabling ReFS Dev Drive for I/O-heavy builds (reduces Copy task overhead dramatically)
- **MSBuild Server** — added `MSBUILDUSESERVER=1` to parallel builds suggestion for better CLI incremental caching
- **Static Graph Restore** — restored `RestoreUseStaticGraphEvaluation=true` (20s+ savings in large builds, was accidentally dropped)
- **Project graph shape** — new guidance on wide vs deep dependency graphs (40% faster clean, 20% faster incremental)
- **Inline task overhead** — warns about RoslynCodeTaskFactory inline tasks (~1s vs ~3ms compiled)
- **BuildCheck** — recommends `dotnet build /check` for first-time diagnostics
- **`RunAnalyzersDuringBuild`** — added as alternative to `RunAnalyzers` for VS startup perf

## 0.7.2 (Preview)

### Improvements
- **Enhanced perf playbook with dotnet/skills best practices** — severity thresholds (RAR >5s/>15s, analyzers <30% of Csc, node utilization >80%, single target >50%), build duration benchmarks
- **Hardlinks for Copy** — added `CreateHardLinksForCopyFilesToOutputDirectoryIfPossible` to playbook and optimize flow
- **Conditional analyzer disable** — fixed optimize prompt to use `Condition="'$(ContinuousIntegrationBuild)' != 'true'"` pattern instead of global `/p:RunAnalyzers=false`, preserving CI enforcement
- **Incrementality guidance** — added `FileWrites` registration, `Returns` vs `Outputs` distinction, bin/obj clash detection, `GlobalPackageReference` scope warning
- **Build command fix** — optimize flow now includes `-m` flag for parallel builds
- **NuGet restore separation** — explicit `dotnet restore` + `dotnet build --no-restore` pattern in optimize prompt

## 0.7.1 (Preview)

### Bug Fixes
- **Fixed `@binlog` chat commands returning "No binlog MCP tools found"** — restored writing MCP server config to user-level `mcp.json` which Copilot Chat needs for tool discovery

## 0.7.0 (Preview)

### New Features
- **Loading spinner in status bar** — shows `⟳ Loading 1 binlog...` with animation while MCP client initializes, then switches to final state with error/warning counts

### Bug Fixes
- **Fixed cross-session binlog bleed** — binlog paths no longer leak across workspaces; now stored in globalState keyed by workspace URI
- **Fixed binlog persistence on workspace change** — "Set Workspace Folder" pre-saves binlog paths under the target workspace key so they survive the reload
- **Fixed stale mcp.json entries** — extension no longer writes binlog paths to user-level `mcp.json`; cleans up old entries on activation
- **Telemetry diagnostic output** — "Binlog Analyzer Telemetry" output channel shows init status and event tracking for debugging

## 0.6.0 (Preview)

### New Features
- **Optimize Build flow** — 🚀 "Optimize build..." action in Binlog Explorer with 8 optimization categories (parallel builds, CoreCompile, file copy, incrementality, RAR, NuGet, artifacts output, build caching). Copilot applies selected optimizations, rebuilds, and loads both binlogs for comparison.
- **MSBuild team best practices** — optimization playbook enriched with recommendations from dotnet/msbuild issues (#2015 RAR, #4025 NuGetSdkResolver, #3135 self-time, #13206 incrementality anti-patterns, #12884 Copy batching)
- **RAR optimization option** — dedicated "Optimize RAR" suggestion: DisableTransitiveProjectReferences, trim unused PackageReferences
- **Artifacts Output Layout** — suggests `--artifacts-path` (.NET 8+) for centralized build output

### Bug Fixes
- **Fixed rebuild popup noise during optimize flow** — `optimizeInProgress` flag suppresses binlog watcher notifications while optimization build runs
- **Fixed premature comparison loading** — replaced unreliable file watcher with user-triggered "Compare Results" button (MSBuild creates binlog at build start, not end)
- **Fixed `/compare` token limit** — slimmed down compare prompt and skips conversation history to stay within token budget
- **Fixed telemetry not reporting** — `@microsoft/*` transitive dependencies (1DS SDK) were missing from VSIX; now bundled correctly

### Improvements
- **Full telemetry coverage** — all 10 user-facing commands and 8 slash commands now tracked, plus error tracking in chat participant and MCP client
- **Faster startup** — top-level imports instead of inline `require()`, cached `findBinlogMcpTool()` result, parallelized MCP config + tree client startup, fire-and-forget cleanup
- **MCP config writes non-blocking** — `updateUserMcpJson` no longer blocks the critical path

## 0.5.0 (Preview)

### New Features
- **E2E test suite** — VS Code integration tests via `@vscode/test-electron` (16 tests covering extension discovery, manifest validation, activation)
- **`validateBinlogPath`** — rejects non-`.binlog` files with clear error messages
- **Workspace flow tests** — 15 scenario tests covering open binlog → select workspace → switch binlog → update workspace

### Bug Fixes
- **Fixed workspace false positives** — `workspaceMatchesBinlog` now respects directory boundaries (`C:\src\app` no longer matches `C:\src\app-v2`)
- **Fixed project deduplication** — projects with same filename in different directories (e.g. two `Common.csproj`) are no longer dropped
- **Fixed severity classification** — `isError`/`isWarning` use exact matching; `WarningAsError` correctly classified as error
- **Fixed line/column 0 handling** — explicit line `0` is preserved instead of silently becoming `1`
- **Fixed NaN line numbers** — non-numeric line values default to `1` instead of `NaN`
- **Fixed filter case sensitivity** — `filterDiagnosticsBySeverity` now works with any casing
- **Fixed perf comparison case sensitivity** — `Build` and `build` are merged as one item
- **Fixed `extractFileName` trailing separator** — `C:\src\` returns `src` instead of full path
- **Fixed negative durations** — clamped to 0 to prevent `"-0.1s"` labels

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
