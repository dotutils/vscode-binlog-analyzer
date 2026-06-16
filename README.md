# MSBuild Binlog Analyzer for VS Code

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/dotutils.binlog-analyzer?label=VS%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=dotutils.binlog-analyzer)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/dotutils.binlog-analyzer)](https://marketplace.visualstudio.com/items?itemName=dotutils.binlog-analyzer)

Analyze MSBuild binary logs (`.binlog`) with **GitHub Copilot Chat** and **MCP tools** — right from VS Code.

> **Preview** — This extension is under active development. Feedback welcome!

## Quick Start

1. Install this extension (requires **VS Code 1.99+** with **GitHub Copilot** and **.NET SDK**)
2. Open a `.binlog` — via **Binlog: Load File** (`Ctrl+Shift+P`), **Build & Collect Binlog**, or from [Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) → **Open in VS Code**
3. Use `@binlog` in Copilot Chat:

```
@binlog why did the build fail?
@binlog what are the slowest targets?
@binlog /perf
```

The [Microsoft.AITools.BinlogMcp](https://www.nuget.org/packages/Microsoft.AITools.BinlogMcp) server (28 analysis tools) is auto-installed on first use.

## What You Get

| Feature | Description |
|---------|-------------|
| **@binlog Chat** | Ask Copilot about errors, performance, targets, imports, NuGet issues — with slash commands like `/errors`, `/perf`, `/timeline`, `/compare`, `/summary`, `/incremental`, `/buildcheck`, `/search`, `/targets`, `/properties`, `/items`, `/propertyhistory` |
| **Build & Collect** | Build a project and capture a `.binlog` in one step |
| **Binlog Explorer** | Sidebar tree with project → target → task hierarchy, errors, warnings, performance |
| **Build Timeline** | Visual bar charts of target/task durations with click-to-analyze in Copilot |
| **Fix All Issues** | Copilot fixes all build errors/warnings, rebuilds, and loads before/after for comparison |
| **Auto-fix Diagnostic** | Right-click any error/warning in the tree → "Auto-fix with Copilot" to fix it directly |
| **Optimize Build** | Pick optimizations, Copilot applies changes, verify with A/B comparison |
| **Build Analysis Mode** | Chat mode pre-configured with Microsoft.AITools.BinlogMcp MCP tools — works with any agent |
| **Language Model Tools** | `binlog_lm_overview`, `binlog_lm_errors`, `binlog_lm_search`, `binlog_lm_perf`, `binlog_lm_compare` — available to @workspace, agent mode, and custom chat modes |
| **CI/CD Integration** | Download binlogs from Azure DevOps Pipelines and GitHub Actions — filter by branch or PR |
| **Problems Panel** | Build diagnostics as native VS Code errors/warnings with per-project CodeLens and "Ask @binlog" CodeActions |
| **Search** | Search across all build events — targets, tasks, messages, properties |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `binlogAnalyzer.mcpServerPath` | `""` | Custom path to the MCP server executable |
| `binlogAnalyzer.mcpServerArgs` | `"--binlog ${binlog}"` | Argument template for the MCP server. `${binlog}` is replaced with each binlog path |
| `binlogAnalyzer.autoLoad` | `true` | Auto-load binlog diagnostics on activation |
| `binlogAnalyzer.diagnosticsSeverityFilter` | `"Warning"` | Min severity for Problems panel |
| `binlogAnalyzer.inlineDecorations` | `true` | Show build errors as inline decorations in source files |
| `binlogAnalyzer.chat.includeAllTools` | `false` | Expose all available tools (file editing, terminal, other MCPs) to the `@binlog` chat participant |
| `binlogAnalyzer.chat.additionalToolPatterns` | `[]` | Additional tool name patterns to include alongside binlog tools (e.g. `["copilot_codebase", "terminal"]`) |

## Troubleshooting: MCP Server Installation

The extension auto-installs [Microsoft.AITools.BinlogMcp](https://www.nuget.org/packages/Microsoft.AITools.BinlogMcp) via `dotnet tool install -g`. In corporate environments with restricted NuGet feeds, this may fail. Here are the workarounds:

### 1. Install manually

```bash
dotnet tool install -g Microsoft.AITools.BinlogMcp
```

### 2. Diagnose NuGet issues

```bash
dotnet nuget list source
```

Common problems:
- **nuget.org not configured** — the tool is published on nuget.org, the default NuGet feed
- **Authenticated feed requires credentials** — may block access to the feed
- **Package source mapping** excludes nuget.org for this package

### 3. Verify installation

```bash
dotnet tool list -g | Select-String Microsoft.AITools.BinlogMcp
binlog-mcp --help
```

## Related Projects

- [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) — WPF viewer with secrets redaction
- [Microsoft.AITools.BinlogMcp](https://www.nuget.org/packages/Microsoft.AITools.BinlogMcp) — MCP server for binlog analysis
- [MSBuild Binary Log docs](https://learn.microsoft.com/en-us/visualstudio/msbuild/obtaining-build-logs-with-msbuild#save-a-binary-log)

## License

[MIT](LICENSE)
