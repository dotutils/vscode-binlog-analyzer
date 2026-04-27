# Test Fixtures

This directory is reserved for small `.binlog` fixtures used by integration
tests. Real fixtures should be:

- Tiny — kept under ~10 KB. Capture the minimum project that exercises the
  scenario. Use `dotnet new classlib -o tmp && dotnet build tmp -bl:fixture.binlog`
  on a stripped-down project.
- Deterministic — identical when re-generated on a different machine
  (avoid absolute paths that leak `$HOME` etc.).
- Documented — add a short note here describing the scenario each fixture
  captures (success, missing-package error, NU1605 downgrade, ...).

Until proper fixtures are committed, integration tests that require a
loaded binlog are skipped. The `mcpClient.test.ts` and `parsers.test.ts`
suites rely only on pure-function helpers and do not need a fixture.
