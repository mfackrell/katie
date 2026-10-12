import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

export function assertComplete(report) {
  const c = report?.counts;
  if (!report?.success || !c || c.tests < 1 || report.completed < 1 ||
      c.failed || c.cancelled || c.skipped || c.todo || c.passed !== c.tests || report.completed !== c.tests) {
    throw new Error(`Incomplete or failed test execution: ${JSON.stringify(report ?? null)}`);
  }
}

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : /\.test\.(ts|mjs)$/.test(path) ? [relative(root, path)] : [];
  }).sort();
}

const focused = {
  website: ["visual-review", "local-katie-inspection", "website-evidence", "claude-provider", "grok-provider", "direct-upload",
    "server-video-frame-recovery", "attachment-continuity", "attachment-discovery", "collaboration",
    "provider-response-errors", "chat-recovery", "stored-website-evidence", "chat-failure-regressions"],
  review: ["required-review", "objective-first-prompts", "review-continuity", "task-progress", "actors-route", "collaboration"],
  "video-fallback": ["runpod-video-fallback"],
  integration: ["api-stack"],
};

function execute(args, options = {}) {
  const env = { ...process.env };
  // Each file owns its runner; never inherit an enclosing node:test context.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, {
    cwd: root, env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
}

export function runNodeFile(file, reportPath, options = {}) {
  rmSync(reportPath, { force: true });
  // Each test file already runs in a separate Node process. Disable the test
  // runner's additional child-process isolation so timeout fixtures cannot
  // leave orphan test workers holding stdout/stderr pipes open indefinitely.
  const result = execute(["--experimental-test-isolation=none", "--test-reporter=./scripts/test-reporter.mjs", file], {
    ...options,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, KATIE_TEST_REPORT_PATH: reportPath },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`Test process failed: ${file} (exit=${result.status}, signal=${result.signal})`, { cause: result.error });
  }
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  assertComplete(report);
  return report.counts;
}

function runVitest(files, reportPath) {
  const result = execute(["node_modules/vitest/vitest.mjs", "run", ...files,
    "--maxWorkers=2", "--minWorkers=1", "--allowOnly=false", "--reporter=json", `--outputFile=${reportPath}`]);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.signal || result.status !== 0 || !existsSync(reportPath)) {
    throw new Error("Vitest failed or did not produce a completion report", { cause: result.error });
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const actual = report.testResults.map(test => relative(root, test.name)).sort();
  if (!report.success || report.numTotalTests < 1 || report.numPassedTests !== report.numTotalTests ||
      report.numFailedTests || report.numPendingTests || report.numTodoTests ||
      JSON.stringify(actual) !== JSON.stringify([...files].sort()) ||
      report.testResults.some(test => !test.assertionResults.length || test.status !== "passed" ||
        test.assertionResults.some(assertion => assertion.status !== "passed"))) {
    throw new Error("Vitest did not execute every selected file and test successfully");
  }
  console.log(`Vitest: ${files.length} files, ${report.numPassedTests} passed, 0 failed/skipped/todo.`);
}

function main() {
  const suite = process.argv[2] ?? "all";
  if (!["all", "vitest", ...Object.keys(focused)].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  const inventory = [...discover(join(root, "tests")), ...discover(join(root, "packages"))];
  const vitestFiles = [];
  const nodeFiles = [];
  for (const file of inventory) {
    const source = readFileSync(file, "utf8");
    if (/from\s+["']vitest["']/.test(source)) vitestFiles.push(file);
    else if (/from\s+["']node:test["']/.test(source)) nodeFiles.push(file);
    else throw new Error(`Unclassified test file: ${file}`);
  }
  const selected = suite === "all" ? nodeFiles : suite === "vitest" ? [] : focused[suite].map(name => {
    const matches = nodeFiles.filter(file => file.endsWith(`/${name}.test.ts`) || file.endsWith(`/${name}.test.mjs`));
    if (matches.length !== 1) throw new Error(`Missing or ambiguous test: ${name}`);
    return matches[0];
  });
  const output = suite === "website" || suite === "review" ? ".website-test-dist" : ".test-dist";
  if (selected.some(file => file.endsWith(".ts"))) {
    rmSync(output, { recursive: true, force: true });
    const config = output === ".test-dist" ? "tsconfig.tests.json" : "tsconfig.website-tests.json";
    const compiled = execute(["node_modules/typescript/bin/tsc", "-p", config], { stdio: "inherit" });
    if (compiled.error || compiled.signal || compiled.status !== 0) throw new Error("Test compilation failed");
    mkdirSync(join(output, "node_modules"), { recursive: true });
    symlinkSync("..", join(output, "node_modules", "@"));
  }
  if (selected.some(file => /\/(visual-review|website-evidence)\.test\.ts$/.test(file))) {
    const prepared = execute(["scripts/prepare-website-browser.mjs"], { stdio: "inherit" });
    if (prepared.error || prepared.signal || prepared.status !== 0) throw new Error("Website browser preparation failed");
  }
  const reports = mkdtempSync(join(tmpdir(), "katie-tests-"));
  let failures = 0;
  const total = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  try {
    for (const [index, file] of selected.entries()) {
      console.log(`\n[${index + 1}/${selected.length}] ${file}`);
      const executable = file.endsWith(".ts") ? join(output, file.replace(/\.ts$/, ".js")) : file;
      if (!existsSync(executable)) { console.error(`Missing emitted test: ${executable}`); failures += 1; continue; }
      try {
        const counts = runNodeFile(executable, join(reports, `${index}.json`));
        for (const key of Object.keys(total)) total[key] += counts[key];
      } catch (error) { console.error(error); failures += 1; }
    }
    if (suite === "all" || suite === "vitest") {
      try { runVitest(vitestFiles, join(reports, "vitest.json")); }
      catch (error) { console.error(error); failures += 1; }
    }
    console.log(`\nNode totals for successful files: ${JSON.stringify(total)}; ${failures} failed files/suites.`);
    if (failures) process.exitCode = 1;
  } finally { rmSync(reports, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
