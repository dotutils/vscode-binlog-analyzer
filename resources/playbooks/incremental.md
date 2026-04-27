Incrementality investigation playbook.

Tool budget: at most 3 MCP calls.

1. `binlog_expensive_targets` (limit 20) — read each row's `executionCount` and `skippedCount`.
   - `skippedCount = 0` and `executionCount > 1` ⇒ target never skips (likely not incremental).
   - `0 < skippedCount < executionCount` ⇒ partial.
   - `skippedCount = executionCount` ⇒ fully incremental.
2. Optionally one `binlog_search` for "Building target" or "up-to-date" to confirm rebuild reasons.
3. Optionally one `binlog_project_targets` call on the worst non-skipping target to inspect its `Inputs`/`Outputs`.

Common fixes (use only when supported by the data):

- **Custom target without `Inputs`/`Outputs`.** Add explicit declarations and register generated files in `<FileWrites>`.
- **Glob picking up generated files.** Add to `<DefaultItemExcludes>` or move output under `$(IntermediateOutputPath)`.
- **Items passed without needing incrementality.** Use `Returns` instead of `Outputs`.
- **SDK targets that "never skip".** Expected on first/clean builds. Ask the user to build twice and re-collect.

Output contract:
1. One-line incrementality summary using the actual numbers from the tool.
2. Up to 5 "never skips" targets with the suggested fix XML and the file to edit.
3. A verification command:
   ```
   dotnet build -bl:first.binlog && dotnet build -bl:second.binlog
   ```
   The second build should be near-no-op.
