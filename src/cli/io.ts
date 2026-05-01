// Stdout/stderr abstraction so dispatch is testable with buffered writers.
export interface CliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export function bufferIO(): CliIO & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    stdout: (c) => {
      out += c;
    },
    stderr: (c) => {
      err += c;
    },
    out: () => out,
    err: () => err,
  };
}
