import type { TestCounts, TestFailure, TestReport } from 'pi-helper-core';

/**
 * Parser for cargo's test output.
 *
 * libtest's structured output is nightly-only (`--format=json -Z unstable-options`),
 * so on stable the result has to be read from text. One thing *is* structured on
 * stable: `--message-format=json` still emits `compiler-artifact` records, which
 * name the package behind every test binary. That is what makes `ranTargets`
 * authoritative rather than inferred from ambiguous `Running src/lib.rs` lines.
 *
 * With `--message-format=json`, cargo writes the JSON records and the progress
 * headers (`Running …`, `Doc-tests …`) to stderr while the test harness writes
 * `running N tests` and `test result:` to stdout. The two streams are paired by
 * order, because a result line cannot be attributed to a target without the
 * header that precedes it in the other stream.
 */

export interface RustTestSection {
  kind: 'unittests' | 'integration' | 'benchmarks' | 'examples' | 'doctests' | 'unknown';
  description: string;
  executable?: string;
  /** Executed tests in this section (passed + failed + ignored). */
  ran: number;
  passed: number;
  failed: number;
  ignored: number;
  measured: number;
  filtered: number;
  hadResult: boolean;
}

export interface RustArtifactTarget {
  package: string;
  packageId: string;
  target: string;
  kinds: string[];
  doctest: boolean;
  executable?: string;
}

export interface RustTestReport extends TestReport {
  sections: RustTestSection[];
  artifacts: RustArtifactTarget[];
  /** Packages that produced a runnable test binary. */
  testedPackages: string[];
  measured: number;
  filtered: number;
  buildFinished: boolean;
  buildSuccess?: boolean;
  compileErrorCount: number;
  /** First cargo-level `error:` line, which is not a compiler diagnostic. */
  commandError?: string;
}

const RESULT_LINE =
  /^test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored;(?:\s*(\d+)\s+measured;)?\s*(\d+)\s+filtered out/;

const RUNNING_LINE = /^\s*Running\s+(.+?)\s*\(([^)]*)\)\s*$/;
const DOCTEST_LINE = /^\s*Doc-tests\s+(\S+)\s*$/;

/** `path+file:///…/crates/core#probe-core@0.1.0` -> `probe-core`. */
export function packageNameFromId(id: string): string {
  const hash = id.lastIndexOf('#');
  const tail = hash === -1 ? id : id.slice(hash + 1);
  return tail.split('@')[0];
}

function sectionKind(description: string): RustTestSection['kind'] {
  if (description.startsWith('unittests')) return 'unittests';
  if (description.startsWith('tests/') || description.startsWith('integration'))
    return 'integration';
  if (description.startsWith('benches')) return 'benchmarks';
  if (description.startsWith('examples')) return 'examples';
  return 'unknown';
}

function emptySection(
  kind: RustTestSection['kind'],
  description: string,
  executable?: string,
): RustTestSection {
  return {
    kind,
    description,
    executable,
    ran: 0,
    passed: 0,
    failed: 0,
    ignored: 0,
    measured: 0,
    filtered: 0,
    hadResult: false,
  };
}

function failureLocation(message: string): { file?: string; line?: number } {
  const panicked = message.match(/panicked at ([^\s:]+):(\d+):(\d+)/);
  if (panicked) return { file: panicked[1], line: Number(panicked[2]) };
  const arrow = message.match(/^\s*-->\s+([^\s:]+):(\d+):(\d+)/m);
  if (arrow) return { file: arrow[1], line: Number(arrow[2]) };
  return {};
}

/** Target headers: `Running unittests src/lib.rs (…)` and `Doc-tests crate`. */
function parseSections(lines: string[]): RustTestSection[] {
  const sections: RustTestSection[] = [];
  for (const line of lines) {
    const running = line.match(RUNNING_LINE);
    if (running) {
      sections.push(
        emptySection(sectionKind(running[1].trim()), running[1].trim(), running[2].trim()),
      );
      continue;
    }
    const doctest = line.match(DOCTEST_LINE);
    if (doctest) {
      sections.push(emptySection('doctests', `Doc-tests ${doctest[1]}`, doctest[1]));
    }
  }
  return sections;
}

interface ParsedResult {
  passed: number;
  failed: number;
  ignored: number;
  measured: number;
  filtered: number;
}

/** Result lines and failure blocks, which the test harness writes to stdout. */
function parseResults(lines: string[]): {
  results: ParsedResult[];
  failures: TestFailure[];
  sawResult: boolean;
  summaryLine?: string;
} {
  const results: ParsedResult[] = [];
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  let summaryLine: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const result = line.match(RESULT_LINE);
    if (result) {
      summaryLine = line.trim();
      results.push({
        passed: Number(result[2]),
        failed: Number(result[3]),
        ignored: Number(result[4]),
        measured: Number(result[5] ?? 0),
        filtered: Number(result[6]),
      });
      continue;
    }

    const failureHeader = line.match(/^---- (\S+) (stdout|stderr) ----\s*$/);
    if (!failureHeader) continue;
    const name = failureHeader[1];
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      if (/^---- \S+ (stdout|stderr) ----\s*$/.test(next)) break;
      if (/^(?:failures:|test result:)/.test(next)) break;
      if (/^note: run with `RUST_BACKTRACE/.test(next)) continue;
      body.push(next);
    }
    index = cursor - 1;
    if (failureHeader[2] === 'stdout' && !seen.has(name)) {
      seen.add(name);
      const message = body.join('\n').trim();
      failures.push({ test: name, message: message.slice(0, 2000), ...failureLocation(message) });
    }
  }

  return { results, failures, sawResult: results.length > 0, summaryLine };
}

function parseJsonLine(
  line: string,
  artifacts: RustArtifactTarget[],
): { buildFinished: boolean; buildSuccess?: boolean } | undefined {
  if (line[0] !== '{') return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const reason = parsed.reason;
  if (reason === 'compiler-artifact') {
    const target = (parsed.target ?? {}) as { name?: string; kind?: string[]; doctest?: boolean };
    const profile = (parsed.profile ?? {}) as { test?: boolean };
    const packageId = String(parsed.package_id ?? '');
    if (profile.test === true && parsed.executable) {
      artifacts.push({
        package: packageNameFromId(packageId),
        packageId,
        target: target.name ?? '(unnamed)',
        kinds: target.kind ?? [],
        doctest: target.doctest === true,
        executable: String(parsed.executable),
      });
    }
    return undefined;
  }
  if (reason === 'build-finished') {
    return { buildFinished: true, buildSuccess: parsed.success === true };
  }
  return undefined;
}

/**
 * Parse a cargo test run. `exitCode`, `timedOut`, and `truncated` are filled in
 * by the caller from the `RunResult`, because the output alone cannot prove them.
 */
export function parseTestOutput(stdout: string, stderr: string): RustTestReport {
  const artifacts: RustArtifactTarget[] = [];
  const stdoutLines: string[] = [];
  let buildFinished = false;
  let buildSuccess: boolean | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('{')) {
      const json = parseJsonLine(line, artifacts);
      if (json?.buildFinished !== undefined) {
        buildFinished = json.buildFinished;
        buildSuccess = json.buildSuccess;
      }
      // A JSON record is not human-readable output; keep it out of the text pass.
      continue;
    }
    stdoutLines.push(rawLine);
  }
  const stderrLines = stderr.split(/\r?\n/);

  // Headers live on stdout with the default message format and on stderr with
  // `--message-format=json`; prefer whichever stream actually carried them.
  const stdoutSections = parseSections(stdoutLines);
  const sections = stdoutSections.length > 0 ? stdoutSections : parseSections(stderrLines);

  const { results, failures, sawResult, summaryLine } = parseResults(stdoutLines);

  // Pair each result with the header that precedes it in the other stream.
  for (let index = 0; index < results.length; index += 1) {
    let section = sections[index];
    if (!section) {
      section = emptySection('unknown', 'unknown target');
      sections.push(section);
    }
    section.passed = results[index].passed;
    section.failed = results[index].failed;
    section.ignored = results[index].ignored;
    section.measured = results[index].measured;
    section.filtered = results[index].filtered;
    section.ran = section.passed + section.failed + section.ignored;
    section.hadResult = true;
  }

  const combined = `${stdout}\n${stderr}`;
  const compileErrorCount = (combined.match(/^error(?:\[[A-Z]\d{4}\])?:/gm) ?? []).length;
  const commandError = combined.match(/^error:\s*(.+)$/m)?.[1]?.trim();

  const counts: TestCounts = {
    passed: sections.reduce((total, section) => total + section.passed, 0),
    failed: sections.reduce((total, section) => total + section.failed, 0),
    errors: 0,
    skipped: sections.reduce((total, section) => total + section.ignored, 0),
  };
  const measured = sections.reduce((total, section) => total + section.measured, 0);
  const filtered = sections.reduce((total, section) => total + section.filtered, 0);
  const includedDocTests = sections.some((section) => section.kind === 'doctests');
  const testedPackages = [...new Set(artifacts.map((entry) => entry.package))].sort();

  const ranTargets =
    artifacts.length > 0
      ? artifacts.map((entry) => `${entry.package} (${entry.target})`)
      : sections.map((section) => section.description);
  const totalRun = counts.passed + counts.failed + counts.skipped;

  return {
    executed: true,
    exitCode: null,
    timedOut: false,
    truncated: false,
    counts,
    ranTargets: [...new Set(ranTargets)].sort(),
    includedDocTests,
    noTestsRan: sawResult && totalRun === 0,
    incomplete: !sawResult,
    summaryLine,
    failures,
    sections,
    artifacts,
    testedPackages,
    measured,
    filtered,
    buildFinished,
    buildSuccess,
    compileErrorCount,
    commandError,
  };
}
