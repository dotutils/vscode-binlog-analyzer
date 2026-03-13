# MSBuild Binlog Analyzer for VS Code

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/dotutils.binlog-analyzer?label=VS%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=dotutils.binlog-analyzer)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/dotutils.binlog-analyzer)](https://marketplace.visualstudio.com/items?itemName=dotutils.binlog-analyzer)

Analyze MSBuild binary logs (`.binlog`) with **GitHub Copilot Chat** and **MCP tools** — right from VS Code.

> **Preview** — This extension is under active development. Feedback welcome!

## Quick Start

1. Install this extension (requires **VS Code 1.99+** with **GitHub Copilot** and **.NET SDK**)
2. Open a `.binlog` — via **Binlog: Load File** (`Ctrl+Shift+P`) or from [Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) → **Open in VS Code**
3. Use `@binlog` in Copilot Chat:

```
@binlog why did the build fail?
@binlog what are the slowest targets?
@binlog /perf
```

The [BinlogInsights.Mcp](https://www.nuget.org/packages/BinlogInsights.Mcp) server (28 analysis tools) is auto-installed on first use.

## What You Get

| Feature | Description |
|---------|-------------|
| **@binlog Chat** | Ask Copilot about errors, performance, targets, imports, NuGet issues |
| **Slash Commands** | `/errors` `/summary` `/perf` `/timeline` `/targets` `/incremental` `/compare` `/secrets` |
| **Binlog Explorer** | Sidebar tree: projects, errors, warnings, performance, actions |
| **Problems Panel** | Build diagnostics as native VS Code errors/warnings |
| **Fix All Issues** | One-click Copilot agent to fix all build warnings/errors |
| **Multi-Binlog** | Load and compare multiple binlogs |
| **Secrets** | `/secrets` guides you to redact credentials via [Structured Log Viewer](https://msbuildlog.com/) |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `binlogAnalyzer.mcpServerPath` | `""` | Custom path to the MCP server executable |
| `binlogAnalyzer.autoLoad` | `true` | Auto-load binlog diagnostics on activation |
| `binlogAnalyzer.diagnosticsSeverityFilter` | `"Warning"` | Min severity for Problems panel |

## Related Projects

- [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) — WPF viewer with secrets redaction
- [BinlogInsights](https://github.com/SergeyTeplyakov/BinlogInsights) — CLI + MCP server for binlog analysis
- [MSBuild Binary Log docs](https://learn.microsoft.com/en-us/visualstudio/msbuild/obtaining-build-logs-with-msbuild#save-a-binary-log)

## License

[MIT](LICENSE)
