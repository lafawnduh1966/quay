// Real adapter exports. Each adapter file lives next to this index. The bin
// entry imports from here so swapping a stub for a real adapter is a one-line
// change.
export { ShellCommandRunner } from "./command_runner.ts";
export { LocalGitAdapter } from "./git.ts";
export { TmuxAdapter } from "./tmux.ts";
export { GitHubCliAdapter } from "./github.ts";
export { SlackAdapter } from "./slack.ts";
