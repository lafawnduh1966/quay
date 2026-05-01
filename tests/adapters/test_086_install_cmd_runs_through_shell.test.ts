import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { ShellCommandRunner } from "../../src/adapters/command_runner.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-shell-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("test_086_install_cmd_runs_through_shell", () => {
  const cwd = tempCwd();
  const runner = new ShellCommandRunner();

  // `&&` chaining and shell variable expansion both require a shell. If the
  // command ran without a shell, the second clause and the `$HOME` expansion
  // would be passed as literal argv tokens to a non-existent program.
  const result = runner.run(
    "echo first && echo expanded:$HOME > out.txt",
    { cwd },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("first");
  // The `>` redirect proves the shell parsed the metacharacter.
  const written = readFileSync(join(cwd, "out.txt"), "utf8");
  expect(written.startsWith("expanded:")).toBe(true);
  expect(written.length).toBeGreaterThan("expanded:".length);
});

test("test_086_cwd_is_honored", () => {
  const cwd = tempCwd();
  const runner = new ShellCommandRunner();
  const result = runner.run("pwd", { cwd });
  expect(result.exitCode).toBe(0);
  // macOS may resolve /var/folders to /private/var/folders. Compare on the
  // basename which is unique to this temp dir.
  const last = cwd.split("/").pop()!;
  expect(result.stdout.includes(last)).toBe(true);
});

test("test_086_non_zero_exit_captured", () => {
  const cwd = tempCwd();
  const runner = new ShellCommandRunner();
  const result = runner.run("echo to-stderr 1>&2; exit 7", { cwd });
  expect(result.exitCode).toBe(7);
  expect(result.stderr).toContain("to-stderr");
});
