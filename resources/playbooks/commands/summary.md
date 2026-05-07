Start with `binlog_lm_overview` (or `binlog_overview`). If the build failed or has errors, follow up with `binlog_lm_errors` (or `binlog_errors`) so the summary names the actual failures, not just a count. If the build succeeded but is slow (>30s for a small project, or user calls it slow), also call `binlog_expensive_targets` once.

Output (markdown):

1. **Build Overview** — bullet list with: result, duration, project count, target framework(s), errors, warnings. Include the failing project's path when result = Failed.
2. **What happened** — 1–3 sentences interpreting the numbers. Name the top failing target/task or top time consumer when the data shows one. Don't speculate beyond what the tools returned.
3. **Suggested next step** — one concrete action (e.g. "Run `/errors` to see all 2 errors with fixes", "Run `/perf` — `Csc` took 60% of build time", "Build looks healthy; nothing further to investigate").

Skip section 2 only when the build is fully green and unremarkable. Keep the whole response under ~20 lines.
