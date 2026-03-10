import * as assert from 'assert';
import {
    extractFileName,
    extractDirectory,
    isError,
    isWarning,
    parseProjects,
    parseDiagnostics,
    getProjectRootCandidates,
    parseMcpDiagnostics,
    filterDiagnosticsBySeverity,
    wasFileModified,
    computePerfComparison,
    McpDiagnostic,
} from '../parsers';

suite('Parsers', () => {

    suite('extractFileName', () => {
        test('extracts filename from Windows path', () => {
            assert.strictEqual(extractFileName('C:\\src\\Project\\Foo.csproj'), 'Foo.csproj');
        });
        test('extracts filename from Unix path', () => {
            assert.strictEqual(extractFileName('/home/user/src/Bar.csproj'), 'Bar.csproj');
        });
        test('returns input when no separator', () => {
            assert.strictEqual(extractFileName('Foo.csproj'), 'Foo.csproj');
        });
        test('handles empty string', () => {
            assert.strictEqual(extractFileName(''), '');
        });
    });

    suite('extractDirectory', () => {
        test('returns abbreviated directory for deep path', () => {
            const result = extractDirectory('C:/Users/dev/repos/msbuild/src/Build/Build.csproj');
            assert.strictEqual(result, '…/msbuild/src/Build');
        });
        test('returns full path for shallow path', () => {
            const result = extractDirectory('C:/src/Foo.csproj');
            assert.strictEqual(result, 'C:/src');
        });
        test('returns empty for filename only', () => {
            assert.strictEqual(extractDirectory('Foo.csproj'), '');
        });
        test('normalizes backslashes', () => {
            const result = extractDirectory('C:\\src\\sub\\Foo.csproj');
            assert.strictEqual(result, 'C:/src/sub');
        });
    });

    suite('isError / isWarning', () => {
        test('detects Error severity', () => {
            assert.ok(isError('Error'));
            assert.ok(isError('error'));
            assert.ok(isError('ERROR'));
        });
        test('rejects non-error', () => {
            assert.ok(!isError('Warning'));
            assert.ok(!isError(''));
        });
        test('detects Warning severity', () => {
            assert.ok(isWarning('Warning'));
            assert.ok(isWarning('warning'));
            assert.ok(isWarning('warn'));
        });
        test('rejects non-warning', () => {
            assert.ok(!isWarning('Error'));
        });
    });

    suite('parseProjects', () => {
        test('parses project data with targets', () => {
            const data = {
                '1': {
                    projectFile: 'C:/src/MyApp/MyApp.csproj',
                    entryTargets: {
                        Build: { targetName: 'Build', durationMs: 1500 },
                        Restore: { targetName: 'Restore', durationMs: 500 },
                    },
                },
            };
            const result = parseProjects(data);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].label, 'MyApp.csproj');
            assert.strictEqual(result[0].totalMs, 2000);
            assert.ok(result[0].targetNames.includes('Build'));
        });

        test('deduplicates projects by id, not label', () => {
            const data = {
                '1': { projectFile: 'C:/src/A/Foo.csproj', entryTargets: {} },
                '2': { projectFile: 'C:/src/B/Foo.csproj', entryTargets: {} },
            };
            const result = parseProjects(data);
            assert.strictEqual(result.length, 2, 'Same filename in different dirs should be kept');
        });

        test('handles empty data', () => {
            assert.deepStrictEqual(parseProjects(null), []);
            assert.deepStrictEqual(parseProjects(undefined), []);
            assert.deepStrictEqual(parseProjects({}), []);
            assert.deepStrictEqual(parseProjects([]), []);
        });

        test('handles ProjectFile casing variant', () => {
            const data = { '1': { ProjectFile: 'C:/src/Bar.sln', entryTargets: {} } };
            const result = parseProjects(data);
            assert.strictEqual(result[0].label, 'Bar.sln');
        });
    });

    suite('parseDiagnostics', () => {
        test('separates errors from warnings', () => {
            const data = {
                diagnostics: [
                    { severity: 'Error', code: 'CS0001', message: 'Compile error', file: 'A.cs', lineNumber: 10 },
                    { severity: 'Warning', code: 'CS0168', message: 'Unused var', file: 'B.cs', lineNumber: 5 },
                    { severity: 'Warning', code: 'CS0219', message: 'Assigned not used', file: 'C.cs' },
                ],
            };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.warnings.length, 2);
        });

        test('formats label with code', () => {
            const data = {
                diagnostics: [
                    { severity: 'Error', code: 'CS0001', message: 'Something broke' },
                ],
            };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors[0].label, 'CS0001: Something broke');
        });

        test('formats label without code', () => {
            const data = {
                diagnostics: [
                    { severity: 'Error', message: 'Generic error' },
                ],
            };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors[0].label, 'Generic error');
        });

        test('truncates long labels', () => {
            const data = {
                diagnostics: [
                    { severity: 'Warning', message: 'A'.repeat(200) },
                ],
            };
            const result = parseDiagnostics(data);
            assert.ok(result.warnings[0].label.length <= 120);
            assert.ok(result.warnings[0].label.endsWith('...'));
        });

        test('formats file location description', () => {
            const data = {
                diagnostics: [
                    { severity: 'Error', message: 'err', file: 'C:/src/Foo.cs', lineNumber: 42 },
                ],
            };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors[0].description, 'Foo.cs:42');
        });

        test('handles empty/null data', () => {
            assert.deepStrictEqual(parseDiagnostics(null), { errors: [], warnings: [] });
            assert.deepStrictEqual(parseDiagnostics({}), { errors: [], warnings: [] });
            assert.deepStrictEqual(parseDiagnostics({ diagnostics: [] }), { errors: [], warnings: [] });
        });

        test('handles alternative property casing', () => {
            const data = {
                diagnostics: [
                    { Severity: 'Error', Code: 'BC0202', Message: 'Build check', File: 'X.csproj', LineNumber: 1 },
                ],
            };
            const result = parseDiagnostics(data);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0].code, 'BC0202');
        });
    });

    suite('getProjectRootCandidates', () => {
        test('finds common root directories', () => {
            const paths = [
                'C:/repos/msbuild/src/Build/Build.csproj',
                'C:/repos/msbuild/src/Tasks/Tasks.csproj',
                'C:/repos/msbuild/src/Framework/Framework.csproj',
            ];
            const result = getProjectRootCandidates(paths);
            assert.ok(result.length > 0);
            assert.ok(result.includes('C:/repos/msbuild'));
        });

        test('sorts by frequency', () => {
            const paths = [
                'C:/a/b/c/d/P1.csproj',
                'C:/a/b/c/d/P2.csproj',
                'C:/a/b/c/d/P3.csproj',
                'D:/other/P4.csproj',
            ];
            const result = getProjectRootCandidates(paths);
            // C:/a paths should come before D:/other
            const cIdx = result.findIndex(r => r.startsWith('C:/a'));
            const dIdx = result.findIndex(r => r.startsWith('D:/other'));
            if (dIdx >= 0) {
                assert.ok(cIdx < dIdx);
            }
        });

        test('handles empty input', () => {
            assert.deepStrictEqual(getProjectRootCandidates([]), []);
        });

        test('limits to 10 results', () => {
            const paths = Array.from({ length: 50 }, (_, i) =>
                `C:/r${i}/src/P.csproj`
            );
            const result = getProjectRootCandidates(paths);
            assert.ok(result.length <= 10);
        });
    });

    suite('parseMcpDiagnostics', () => {
        test('parses standard MCP diagnostics response', () => {
            const data = {
                diagnostics: [
                    { severity: 'Error', code: 'CS0246', message: 'Type not found', file: 'C:/src/Foo.cs', lineNumber: 10, columnNumber: 5 },
                    { severity: 'Warning', code: 'CS0168', message: 'Unused variable', file: 'C:/src/Bar.cs', lineNumber: 20 },
                ],
                errorCount: 1,
                warningCount: 1,
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].severity, 'error');
            assert.strictEqual(result[0].code, 'CS0246');
            assert.strictEqual(result[0].file, 'C:/src/Foo.cs');
            assert.strictEqual(result[0].line, 10);
            assert.strictEqual(result[0].column, 5);
            assert.strictEqual(result[1].severity, 'warning');
        });

        test('handles alternative property casing', () => {
            const data = {
                diagnostics: [
                    { Severity: 'Error', Code: 'BC30451', Message: 'Name not declared', File: 'C:/src/X.vb', LineNumber: 5, ColumnNumber: 3 },
                ],
            };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].code, 'BC30451');
            assert.strictEqual(result[0].file, 'C:/src/X.vb');
        });

        test('handles empty diagnostics array', () => {
            assert.deepStrictEqual(parseMcpDiagnostics({ diagnostics: [] }), []);
        });

        test('handles null/undefined input', () => {
            assert.deepStrictEqual(parseMcpDiagnostics(null), []);
            assert.deepStrictEqual(parseMcpDiagnostics(undefined), []);
        });

        test('handles missing fields with defaults', () => {
            const data = { diagnostics: [{ message: 'Something failed' }] };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].line, 1);
            assert.strictEqual(result[0].column, 1);
            assert.strictEqual(result[0].severity, 'info');
            assert.strictEqual(result[0].file, '');
        });

        test('maps info severity correctly', () => {
            const data = { diagnostics: [{ severity: 'Info', message: 'Note' }] };
            const result = parseMcpDiagnostics(data);
            assert.strictEqual(result[0].severity, 'info');
        });
    });

    suite('filterDiagnosticsBySeverity', () => {
        const diags: McpDiagnostic[] = [
            { file: 'a.cs', line: 1, column: 1, message: 'err', code: 'E1', severity: 'error' },
            { file: 'b.cs', line: 2, column: 1, message: 'warn', code: 'W1', severity: 'warning' },
            { file: 'c.cs', line: 3, column: 1, message: 'info', code: 'I1', severity: 'info' },
        ];

        test('Error filter returns only errors', () => {
            const result = filterDiagnosticsBySeverity(diags, 'Error');
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].severity, 'error');
        });

        test('Warning filter returns errors and warnings', () => {
            const result = filterDiagnosticsBySeverity(diags, 'Warning');
            assert.strictEqual(result.length, 2);
        });

        test('Info filter returns all', () => {
            const result = filterDiagnosticsBySeverity(diags, 'Info');
            assert.strictEqual(result.length, 3);
        });
    });

    suite('wasFileModified', () => {
        test('returns true when mtime changed', () => {
            assert.ok(wasFileModified(1000, 999));
        });

        test('returns false when mtime is the same', () => {
            assert.ok(!wasFileModified(1000, 1000));
        });
    });

    suite('computePerfComparison', () => {
        test('computes delta between two builds', () => {
            const mapA = new Map([['Csc', 5000], ['ResolveRefs', 3000]]);
            const mapB = new Map([['Csc', 6000], ['ResolveRefs', 2000]]);
            const result = computePerfComparison(mapA, mapB);
            const csc = result.find(r => r.name === 'Csc')!;
            assert.strictEqual(csc.durationA, 5000);
            assert.strictEqual(csc.durationB, 6000);
            assert.strictEqual(csc.status, 'slower');
            assert.ok(csc.deltaPct > 0);

            const refs = result.find(r => r.name === 'ResolveRefs')!;
            assert.strictEqual(refs.status, 'faster');
        });

        test('detects new targets', () => {
            const mapA = new Map<string, number>();
            const mapB = new Map([['NewTarget', 1000]]);
            const result = computePerfComparison(mapA, mapB);
            assert.strictEqual(result[0].status, 'new');
        });

        test('detects removed targets', () => {
            const mapA = new Map([['OldTarget', 1000]]);
            const mapB = new Map<string, number>();
            const result = computePerfComparison(mapA, mapB);
            assert.strictEqual(result[0].status, 'removed');
        });

        test('marks small changes as same', () => {
            const mapA = new Map([['Csc', 1000]]);
            const mapB = new Map([['Csc', 1040]]); // 4% change, under default 5% threshold
            const result = computePerfComparison(mapA, mapB);
            assert.strictEqual(result[0].status, 'same');
        });

        test('respects custom threshold', () => {
            const mapA = new Map([['Csc', 1000]]);
            const mapB = new Map([['Csc', 1040]]);
            const result = computePerfComparison(mapA, mapB, 3); // 3% threshold
            assert.strictEqual(result[0].status, 'slower');
        });

        test('sorts by max duration descending', () => {
            const mapA = new Map([['Small', 100], ['Big', 5000]]);
            const mapB = new Map([['Small', 200], ['Big', 4000]]);
            const result = computePerfComparison(mapA, mapB);
            assert.strictEqual(result[0].name, 'Big');
            assert.strictEqual(result[1].name, 'Small');
        });

        test('handles empty maps', () => {
            const result = computePerfComparison(new Map(), new Map());
            assert.strictEqual(result.length, 0);
        });
    });
});
