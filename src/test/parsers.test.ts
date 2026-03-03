import * as assert from 'assert';
import {
    extractFileName,
    extractDirectory,
    isError,
    isWarning,
    parseProjects,
    parseDiagnostics,
    getProjectRootCandidates,
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

        test('deduplicates projects by label', () => {
            const data = {
                '1': { projectFile: 'C:/src/A/Foo.csproj', entryTargets: {} },
                '2': { projectFile: 'C:/src/B/Foo.csproj', entryTargets: {} },
            };
            const result = parseProjects(data);
            assert.strictEqual(result.length, 1);
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
});
