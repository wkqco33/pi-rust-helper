/**
 * End-to-end pass over a temporary workspace.
 *
 * This is the pilot's success measurement, not a unit test: it walks the three
 * failures the plan measured (default-members false green, an unlocated compiler
 * error, and MSRV above the installed toolchain) through the real tools against
 * real cargo output.
 *
 *     npm run test:e2e
 */
import { invokeTool, primeLockfile, rustAvailable, withFixture } from '../helpers/harness.ts';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

async function main(): Promise<void> {
  if (!(await rustAvailable())) {
    console.log('SKIP  no Rust toolchain available; nothing to verify end to end.');
    return;
  }

  await withFixture('basic-workspace', async (directory) => {
    await primeLockfile(directory);

    const narrow = await invokeTool('rust_test', { workspace: false, execute: true }, directory);
    const data = narrow.data as { missingMembers?: string[] };
    record(
      'false green: a bare cargo test is reported as default-members-only',
      narrow.ok === false &&
        narrow.warnings.some((entry) => entry.code === 'DEFAULT_MEMBERS_ONLY') &&
        (data.missingMembers ?? []).includes('probe-core'),
      `ok=${narrow.ok} missing=${JSON.stringify(data.missingMembers ?? [])}`,
    );

    const full = await invokeTool('rust_test', { execute: true }, directory);
    const fullData = full.data as { testedPackages?: string[]; includedDocTests?: boolean };
    record(
      'workspace coverage: every member and the doctests run',
      full.ok === true &&
        (fullData.testedPackages ?? []).join(',') === 'probe-app,probe-core' &&
        fullData.includedDocTests === true,
      `ok=${full.ok} packages=${JSON.stringify(fullData.testedPackages ?? [])} doctests=${fullData.includedDocTests}`,
    );

    const bundle = await invokeTool('rust_validation_bundle', { execute: true }, directory);
    record(
      'completion gate: a primed workspace passes the full bundle',
      bundle.ok === true,
      bundle.summary,
    );
  });

  await withFixture('broken', async (directory) => {
    const check = await invokeTool('rust_check', { execute: true }, directory);
    const data = check.data as {
      errorCodes?: Record<string, number>;
      firstFailure?: { firstUserFrame?: { path?: string } };
    };
    record(
      'diagnosis: a compiler error is located at the project frame',
      check.ok === false &&
        (data.errorCodes?.E0599 ?? 0) === 1 &&
        data.firstFailure?.firstUserFrame?.path === 'src/lib.rs',
      `codes=${JSON.stringify(data.errorCodes ?? {})} frame=${data.firstFailure?.firstUserFrame?.path}`,
    );
  });

  await withFixture('msrv', async (directory) => {
    const inspect = await invokeTool('rust_project_inspect', {}, directory);
    record(
      'MSRV: rust-version above the active toolchain is reported',
      inspect.ok === false && inspect.warnings.some((entry) => entry.code === 'MSRV_UNSATISFIED'),
      inspect.summary,
    );
  });
}

await main();

const failed = checks.filter((check) => !check.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} end-to-end checks passed.`);
if (failed.length > 0) process.exit(1);
