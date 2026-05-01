// Real CommandRunner adapter. Runs operator-controlled commands like
// `install_cmd` through `/bin/sh -c` so shell expansion, redirects, pipes,
// and `&&` chaining work as a shell user expects (spec §13).
import type {
  CommandRunResult,
  CommandRunner,
} from "../ports/command_runner.ts";

export class ShellCommandRunner implements CommandRunner {
  run(command: string, opts: { cwd: string }): CommandRunResult {
    const result = Bun.spawnSync({
      cmd: ["/bin/sh", "-c", command],
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode ?? 0,
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
    };
  }
}

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}
