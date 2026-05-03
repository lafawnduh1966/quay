// Stdout/stderr abstraction so dispatch is testable with buffered writers.
//
// Stdout accepts string OR Uint8Array. Most commands emit JSON / file paths
// that can be serialized as text, but `artifact get` returns the raw bytes
// of an artifact — and `malformed_signal` artifacts intentionally preserve
// invalid UTF-8. Forcing a `string` round-trip there silently corrupts the
// payload: the lossy decode happens before the bytes reach the CliIO sink,
// even if the sink is `process.stdout.write` (which itself accepts both).
// Keeping stderr text-only is fine — error envelopes are always JSON.
export interface CliIO {
  stdout: (chunk: string | Uint8Array) => void;
  stderr: (chunk: string) => void;
}

export interface BufferedCliIO extends CliIO {
  out: () => string;
  err: () => string;
  outBytes: () => Uint8Array;
}

export function bufferIO(): BufferedCliIO {
  // Append byte chunks; `string` chunks go through TextEncoder so the bytes
  // buffer is the lossless ground truth. `out()` decodes back as UTF-8 for
  // the common test path; `outBytes()` is the escape hatch for tests that
  // assert against binary artifacts where UTF-8 decode would lose data.
  const chunks: Uint8Array[] = [];
  let err = "";
  const encoder = new TextEncoder();
  return {
    stdout: (c) => {
      chunks.push(typeof c === "string" ? encoder.encode(c) : c);
    },
    stderr: (c) => {
      err += c;
    },
    out: () => {
      // Concatenation cost is fine for tests — no command emits enough
      // stdout to make this matter.
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return new TextDecoder().decode(merged);
    },
    err: () => err,
    outBytes: () => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return merged;
    },
  };
}
