import * as assert from 'assert';
import {
    workspaceMatchesBinlog,
    getSourceLabel,
    getProjectRootCandidates,
    extractFileName,
    extractDirectory,
    isError,
    isWarning,
    parseProjects,
    parseDiagnostics,
    parseMcpDiagnostics,
    filterDiagnosticsBySeverity,
    wasFileModified,
    computePerfComparison,
    validateBinlogPath,
} from '../parsers';

suite('Bug Hunting Tests', () => {

    suite('workspaceMatchesBinlog — false positives', () => {
        test('FIXED: prefix match no longer gives false positive for similar names', () => {
            const result = workspaceMatchesBinlog(
                'C:\\src\\app',
                'C:\\src\\app-v2\\build.binlog'
            );
            assert.ok(!result, 'C:\\src\\app should NOT match C:\\src\\app-v2');
        });

        test('FIXED: workspace "C:\\s" does not match "C:\\src\\project\\build.binlog"', () => {
            const result = workspaceMatchesBinlog(
                'C:\\s',
                'C:\\src\\project\\build.binlog'
            );
            assert.ok(!result, 'C:\\s should NOT match C:\\src\\project');
        });
    });

    suite('getSourceLabel — edge cases', () => {
        test('binlog at root of drive has empty label', () => {
            const result = getSourceLabel(undefined, undefined, 'C:\\build.binlog');
            // path.dirname('C:\\build.binlog') = 'C:\\', path.basename('C:\\') = '' on some platforms
            assert.ok(result.label !== undefined, 'Label should not be undefined');
            // On Windows, path.basename('C:\\') returns ''
        });

        test('binlog with only filename (no directory)', () => {
            const result = getSourceLabel(undefined, undefined, 'build.binlog');
            // path.dirname('build.binlog') = '.', path.basename('.') = '.'
            assert.ok(result.label, 'Should return some label');
        });
    });

    suite('extractFileName — tricky inputs', () => {
        test('FIXED: path with trailing separator returns last dir name', () => {
            const result = extractFileName('C:\\src\\');
            assert.strictEqual(result, 'src', 'Should strip trailing separator and return last segment');
        });

        test('path with double separators', () => {
            assert.strictEqual(extractFileName('C:\\src\\\\file.txt'), 'file.txt');
        });

        test('path with mixed separators', () => {
            assert.strictEqual(extractFileName('C:/src\\nested/file.txt'), 'file.txt');
        });

        test('null-ish input does not crash', () => {
            assert.strictEqual(extractFileName(''), '');
        });
    });

    suite('extractDirectory — tricky inputs', () => {
        test('Windows UNC path', () => {
            const result = extractDirectory('\\\\server\\share\\project\\file.csproj');
            assert.ok(typeof result === 'string');
        });

        test('root-level file', () => {
            const result = extractDirectory('C:\\file.csproj');
            assert.strictEqual(result, 'C:');
        });

        test('deeply nested path truncation', () => {
            const result = extractDirectory('C:/a/b/c/d/e/f/g/h/file.cs');
            assert.ok(result.startsWith('…/'), 'Deep paths should be abbreviated');
            // Should show last 3 segments
            assert.ok(result.includes('f/g/h'), 'Should include last 3 dirs');
        });
    });

    suite('isError / isWarning — edge cases', () => {
        test('FIXED: isError does not match "InternalError"', () => {
            assert.ok(!isError('InternalError'), 'InternalError is not a standard severity');
        });

        test('FIXED: isError does match "WarningAsError"', () => {
            assert.ok(isError('WarningAsError'), 'WarningAsError should be treated as error');
        });

        test('FIXED: isWarning does not match "WarningAsError"', () => {
            assert.ok(!isWarning('WarningAsError'), 'WarningAsError is an error, not a warning');
        });

        test('isError does not match empty/null', () => {
            assert.ok(!isError(''));
            assert.ok(!isError('Info'));
        });
    });

    suite('parseProjects — data integrity', () => {
        test('FIXED: projects with same filename in different directories are kept', () => {
            const data = {
                '1': { projectFile: 'C:\\src\\LibA\\Common.csproj', entryTargets: {} },
                '2': { projectFile: 'C:\\src\\LibB\\Common.csproj', entryTargets: {} },
            };
            const result = parseProjects(data);
            assert.strictEqual(result.length, 2, 'Both projects with same filename should be kept');
        });

        test('project with no entryTargets', () => {
            const data = { '1': { projectFile: 'C:\\src\\App.csproj' } };
            const result = parseProjects(data);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].totalMs, 0);
            assert.strictEqual(result[0].targetNames, '');
        });

        test('project with null projectFile coerces to empty string', () => {
            const data = { '1': { projectFile: null, entryTargets: {} } };
            const result = parseProjects(data);
            assert.strictEqual(result.length, 1);
            // String(null) = 'null' but || '' catches it since null is falsy
            assert.strictEqual(result[0].filePath, '', 'null projectFile becomes empty string via || fallback');
        });

        test('project with numeric id as key', () => {
            const data = { '42': { projectFile: 'App.csproj', entryTargets: {} } };
            const result = parseProjects(data);
            assert.strictEqual(result[0].id, '42');
        });

        test('FIXED: negative duration values are clamped to zero', () => {
            const data = {
                '1': {
                    projectFile: 'App.csproj',
                    entryTargets: {
                        Build: { targetName: 'Build', durationMs: -100 },
                    },
                },
            };
            const result = parseProjects(data);
            assert.strictEqual(result[0].totalMs, 0, 'Negative duration should be clamped to 0');
        });
    });

    suite('parseDiagnostics — classification bugs', () => {
        test('diagnostic with no severity defaults to warning, not error', () => {
            const data = {
                diagnostics: [{ message: 'Something happened', code: 'X1', file: 'a.cs' }],
            };
            const result = parseDiagnostics(data);
            // severity is '', isError('') = false, so it goes to warnings
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.warnings.length, 1);
        });

        test('diagnostic with severity "Info" is classified as warning', () => {
            const data = {
                diagnostics: [{ message: 'Info msg', severity: 'Info', code: 'I1', file: 'a.cs' }],
            };
            const result = parseDiagnostics(data);
            // BUG: Info-level diagnostics are classified as warnings
            assert.strictEqual(result.warnings.length, 1);
            assert.strictEqual(result.errors.length, 0);
        });

        test('diagnostic with severity "CriticalError" is classified as error', () => {
            const data = {
                diagnostics: [{ message: 'Fatal', severity: 'CriticalError', code: 'E1', file: 'a.cs' }],
            };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors.length, 1, 'CriticalError should be an error');
        });

        test('diagnostics as non-array (object) is ignored', () => {
            const data = { diagnostics: { '0': { message: 'test' } } };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.warnings.length, 0);
        });
    });

    suite('parseMcpDiagnostics — data edge cases', () => {
        test('line number 0 is now preserved', () => {
            const data = {
                diagnostics: [{ message: 'test', lineNumber: 0, severity: 'Error' }],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].line, 0);
        });

        test('FIXED: line number 0 is preserved (not replaced with 1)', () => {
            const data = {
                diagnostics: [{ message: 'test', lineNumber: 0, severity: 'Error' }],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].line, 0, 'Line 0 should be preserved');
        });

        test('column number 0 is now preserved', () => {
            const data = {
                diagnostics: [{ message: 'test', columnNumber: 0, severity: 'Error' }],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].column, 0, 'Column 0 should be preserved');
        });

        test('very large line numbers', () => {
            const data = {
                diagnostics: [{ message: 'test', lineNumber: 999999, severity: 'Error' }],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].line, 999999);
        });

        test('string line number gets parsed', () => {
            const data = {
                diagnostics: [{ message: 'test', lineNumber: '42', severity: 'Error' }],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].line, 42);
        });

        test('FIXED: non-numeric line number defaults to 1 instead of NaN', () => {
            const data = {
                diagnostics: [{ message: 'test', lineNumber: 'abc', severity: 'Error' }],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].line, 1, 'Non-numeric lineNumber should default to 1');
        });
    });

    suite('filterDiagnosticsBySeverity — case sensitivity', () => {
        const diags = [
            { file: 'a', line: 1, column: 1, message: 'err', code: 'E1', severity: 'error' as const },
            { file: 'b', line: 1, column: 1, message: 'warn', code: 'W1', severity: 'warning' as const },
            { file: 'c', line: 1, column: 1, message: 'info', code: 'I1', severity: 'info' as const },
        ];

        test('FIXED: filter with lowercase "error" now works', () => {
            const result = filterDiagnosticsBySeverity(diags, 'error');
            assert.strictEqual(result.length, 1, 'Should return only errors');
            assert.strictEqual(result[0].code, 'E1');
        });

        test('filter with "Warning" (capital W) works', () => {
            const result = filterDiagnosticsBySeverity(diags, 'Warning');
            assert.strictEqual(result.length, 2, 'Should return errors + warnings');
        });
    });

    suite('computePerfComparison — edge cases', () => {
        test('zero duration items', () => {
            const a = new Map([['Build', 0]]);
            const b = new Map([['Build', 0]]);
            const result = computePerfComparison(a, b);
            // deltaPct = 0/0 = NaN? or 0?
            assert.strictEqual(result.length, 1);
            assert.ok(!isNaN(result[0].deltaPct), 'Delta should not be NaN for zero durations');
        });

        test('very large duration difference', () => {
            const a = new Map([['Build', 1]]);
            const b = new Map([['Build', 1000000]]);
            const result = computePerfComparison(a, b);
            assert.strictEqual(result[0].status, 'slower');
            assert.ok(result[0].deltaPct > 1000, 'Should show massive slowdown');
        });

        test('FIXED: items with same name but different case are merged', () => {
            const a = new Map([['Build', 100]]);
            const b = new Map([['build', 200]]);
            const result = computePerfComparison(a, b);
            assert.strictEqual(result.length, 1, 'Case-insensitive merge = one item');
            assert.strictEqual(result[0].status, 'slower');
            assert.strictEqual(result[0].durationA, 100);
            assert.strictEqual(result[0].durationB, 200);
        });
    });

    suite('getProjectRootCandidates — adversarial inputs', () => {
        test('paths with only drive letter', () => {
            const result = getProjectRootCandidates(['C:\\file.csproj']);
            // Parts: ['C:', 'file.csproj'], depth 2 → candidate 'C:/file.csproj'
            // filter(p => p.length > 3) should filter out 'C:' but keep 'C:/file.csproj'
            assert.ok(result.every(r => r.length > 3), 'Should not include bare drive letters');
        });

        test('empty strings in input', () => {
            const result = getProjectRootCandidates(['', '', '']);
            assert.strictEqual(result.length, 0, 'Empty strings should be filtered');
        });

        test('very short paths are filtered', () => {
            const result = getProjectRootCandidates(['a.cs', 'b.cs']);
            // 'a.cs'.length = 4, passes length check, but only 1 part → no candidates at depth >= 2
            assert.strictEqual(result.length, 0);
        });

        test('Unix paths work', () => {
            const result = getProjectRootCandidates([
                '/home/user/repos/project/src/App.csproj',
                '/home/user/repos/project/tests/Tests.csproj',
            ]);
            assert.ok(result.length > 0);
        });

        test('mixed Windows/Unix paths', () => {
            const result = getProjectRootCandidates([
                'C:\\repos\\project\\src\\App.csproj',
                '/repos/project/src/App.csproj',
            ]);
            // Both get normalized to forward slashes
            assert.ok(result.length > 0);
        });
    });

    suite('wasFileModified — precision', () => {
        test('sub-millisecond differences are detected', () => {
            assert.ok(wasFileModified(1000.001, 1000.000));
        });

        test('exact same value returns false', () => {
            assert.ok(!wasFileModified(1000.000, 1000.000));
        });

        test('NaN mtime', () => {
            assert.ok(wasFileModified(NaN, 1000));
            assert.ok(wasFileModified(1000, NaN));
            // NaN !== NaN is true
        });
    });

    suite('validateBinlogPath', () => {
        test('accepts valid .binlog path', () => {
            assert.strictEqual(validateBinlogPath('C:\\builds\\msbuild.binlog'), null);
        });

        test('accepts uppercase .BINLOG', () => {
            assert.strictEqual(validateBinlogPath('C:\\builds\\msbuild.BINLOG'), null);
        });

        test('rejects non-binlog file', () => {
            const err = validateBinlogPath('C:\\builds\\output.log');
            assert.ok(err, 'Should return error message');
            assert.ok(err!.includes('output.log'));
        });

        test('rejects .csproj file', () => {
            assert.ok(validateBinlogPath('C:\\src\\App.csproj'));
        });

        test('rejects empty string', () => {
            assert.ok(validateBinlogPath(''));
            assert.ok(validateBinlogPath('   '));
        });

        test('accepts Unix-style binlog path', () => {
            assert.strictEqual(validateBinlogPath('/home/user/build.binlog'), null);
        });

        test('rejects file with binlog in name but wrong extension', () => {
            assert.ok(validateBinlogPath('C:\\binlog-analysis.txt'));
        });
    });
});
