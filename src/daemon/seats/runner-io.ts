// Byte-exact input for the seat runner (runner.ts): lines and fixed byte counts from ONE stream, nothing read ahead
// and lost, and a line longer than its limit is refused before it is decoded or returned (Codex r3 LOW 7).
export class Input {
  private buf = new Uint8Array(0);
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }

  private async more(): Promise<boolean> {
    if (this.done) return false;
    const r = await this.reader.read();
    if (r.done) { this.done = true; return false; }
    const next = new Uint8Array(this.buf.length + r.value.length);
    next.set(this.buf);
    next.set(r.value, this.buf.length);
    this.buf = next;
    return true;
  }

  /**
   * The next line (without its newline), or null at the end of the stream or when the line is longer than `max`
   * bytes (the caller treats that as a broken peer: nothing of such a line is used).
   */
  async line(max: number): Promise<string | null> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        if (i > max) return null;
        const out = new TextDecoder().decode(this.buf.subarray(0, i));
        this.buf = this.buf.slice(i + 1);
        return out;
      }
      if (this.buf.length > max || !(await this.more())) return null;
    }
  }

  /**
   * Exactly `n` bytes written to `fd` as they arrive (a large staged bundle, never held whole in memory: FO-2), false
   * when the stream ends first.
   */
  async toFile(n: number, fd: number): Promise<boolean> {
    const { writeSync } = await import("node:fs");
    let left = n;
    const take = (chunk: Uint8Array) => {
      let off = 0;
      while (off < chunk.byteLength) off += writeSync(fd, chunk, off, chunk.byteLength - off);
    };
    if (this.buf.length) {
      const now = this.buf.subarray(0, Math.min(left, this.buf.length));
      take(now);
      left -= now.byteLength;
      this.buf = this.buf.slice(now.byteLength);
    }
    while (left > 0) {
      if (this.done) return false;
      const r = await this.reader.read();
      if (r.done) { this.done = true; return false; }
      const chunk = r.value;
      if (chunk.byteLength <= left) { take(chunk); left -= chunk.byteLength; continue; }
      take(chunk.subarray(0, left));
      this.buf = chunk.slice(left);
      left = 0;
    }
    return true;
  }

  /** Exactly `n` bytes, or null when the stream ends first. */
  async bytes(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) if (!(await this.more())) return null;
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}
