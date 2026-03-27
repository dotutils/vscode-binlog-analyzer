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

The [BinlogInsights.Mcp](https://www.nuget.org/packages/BinlogInsights.Mcp) server (28 analysis tools) is auto-installed on first use.

## What You Get

| Feature | Description |
|---------|-------------|
| **@binlog Chat** | Ask Copilot about errors, performance, targets, imports, NuGet issues — with slash commands like `/errors`, `/perf`, `/timeline`, `/compare` |
| **Build & Collect** | Build a project and capture a `.binlog` in one step |
| **Binlog Explorer** | Sidebar tree with project → target → task hierarchy, errors, warnings, performance |
| **Build Timeline** | Visual bar charts of target/task durations with click-to-analyze in Copilot |
| **Optimize Build** | Pick optimizations, Copilot applies changes, verify with A/B comparison |
| **CI/CD Integration** | Download binlogs from Azure DevOps Pipelines and GitHub Actions — filter by branch or PR |
| **Problems Panel** | Build diagnostics as native VS Code errors/warnings with per-project CodeLens |
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

The extension auto-installs [BinlogInsights.Mcp](https://www.nuget.org/packages/BinlogInsights.Mcp) via `dotnet tool install -g`. In corporate environments with restricted NuGet feeds, this may fail. Here are the workarounds:

### 1. Install with explicit NuGet source

```bash
dotnet tool install -g BinlogInsights.Mcp --add-source https://api.nuget.org/v3/index.json
```

### 2. Manual download fallback

If all `dotnet tool install` attempts fail (e.g., nuget.org is blocked):

1. Download the `.nupkg` directly from [nuget.org](https://www.nuget.org/packages/BinlogInsights.Mcp)
2. Install from the local file:

```bash
# Download (replace {version} with latest, e.g. 0.2.0)
Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/BinlogInsights.Mcp/{version}" -OutFile "BinlogInsights.Mcp.nupkg"

# Install from local file
dotnet tool install -g BinlogInsights.Mcp --add-source .
```

### 3. Diagnose NuGet issues

```bash
dotnet nuget list source
```

Common problems:
- **nuget.org not listed or disabled** — the tool is published on nuget.org
- **Authenticated feed requires credentials** — may block fallthrough to nuget.org
- **Package source mapping** excludes nuget.org for this package

### 4. Verify installation

```bash
dotnet tool list -g | Select-String BinlogInsights
binlog-insights-mcp --help
```

> For the full troubleshooting guide, see [BinlogInsights repo setup instructions](https://github.com/SergeyTeplyakov/BinlogInsights/blob/main/samples/repo-setup/.github/skills/build-tool-setup/SKILL.md).

## Related Projects

- [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) — WPF viewer with secrets redaction
- [BinlogInsights](https://github.com/SergeyTeplyakov/BinlogInsights) — CLI + MCP server for binlog analysis
- [MSBuild Binary Log docs](https://learn.microsoft.com/en-us/visualstudio/msbuild/obtaining-build-logs-with-msbuild#save-a-binary-log)

## License

[MIT](LICENSE)
