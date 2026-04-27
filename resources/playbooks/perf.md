Performance investigation playbook.

Tool budget: at most 4 MCP calls. Pick from `binlog_expensive_targets`, `binlog_expensive_tasks`, `binlog_expensive_projects`, `binlog_expensive_analyzers`. Do not recompute percentages — use whatever ranking the tool returns.

Common bottlenecks and their fixes (use only when the tool output supports them):

- **ResolveAssemblyReferences slow.** Trim transitive references; set `ReferenceOutputAssembly="false"` on non-API project refs; consider `<DisableTransitiveProjectReferences>true</DisableTransitiveProjectReferences>`. RAR runs unconditionally (msbuild#2015).
- **Csc/CoreCompile slow.** Inspect `binlog_expensive_analyzers`. Disable analyzers conditionally rather than globally:
  ```xml
  <RunAnalyzers Condition="'$(ContinuousIntegrationBuild)' != 'true'">false</RunAnalyzers>
  ```
  Add `<ProduceReferenceAssembly>true</ProduceReferenceAssembly>` for older non-SDK projects.
- **CopyFilesToOutputDirectory slow.** Enable `<CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>true</CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>`, `<SkipCopyUnchangedFiles>true</SkipCopyUnchangedFiles>`, and consider `--artifacts-path` (.NET 8+). On Windows recommend Dev Drive (ReFS).
- **ResolvePackageAssets slow.** `<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>` plus `<RestoreUseStaticGraphEvaluation>true</RestoreUseStaticGraphEvaluation>` in `Directory.Build.props`. Separate restore from build (`dotnet restore` then `dotnet build --no-restore`).
- **NuGetSdkResolver overhead** (msbuild#4025): avoid NuGet-based SDK resolvers.
- **Pack/Nuspec on non-package projects.** Set `<IsPackable>false</IsPackable>`.
- **Many projects rebuilding.** Verify custom targets have `Inputs`/`Outputs`; register generated files in `<FileWrites>`; check `<Deterministic>true</Deterministic>`.
- **High evaluation time.** Reduce `Directory.Build.props` complexity; check for wildcard globs scanning large directories.
- **Whole build slow.** `-maxCpuCount`, `-graph`, `BuildInParallel=true`. For CLI: `MSBUILDUSESERVER=1`.
- **Deep project graph.** Wide graphs build faster than deep ones; consider splitting bottleneck projects.
- **ResolveProjectReferences time** is misleading — it includes wait time (msbuild#3135). Focus on task self-time.
- **Generated items vanish on incremental rebuild** (msbuild#13206): separate computation targets (no `Inputs`/`Outputs`) from execution targets; use `Returns` rather than `Outputs` when items don't need incrementality checking.
- **bin/obj clashes.** Ensure `AppendTargetFrameworkToOutputPath=true` and unique `BaseIntermediateOutputPath` per project.
- **First-time analysis.** `dotnet build /check` (SDK 9.0.100+) catches build-quality issues before deeper analysis.

Output contract:
1. Top 3 bottlenecks ranked by cost from the tool output.
2. For each: one MSBuild XML or CLI fix, plus the file to add it to (`Directory.Build.props`, specific `.csproj`, or CLI flag).
3. A short ordered priority list ("do A first, then B, then C").
