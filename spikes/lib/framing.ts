/**
 * Incremental JSONL decoder for Pi's RPC stream.
 *
 * Pi frames records with LF as the only delimiter. Node's `readline` also splits on U+2028 and
 * U+2029, which are legal inside JSON strings, so it is not protocol-compliant here.
 */
export class JsonlDecoder {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Append a stdout chunk and return every complete record it finished. */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const lf = this.buf.indexOf(0x0a, start);
      if (lf === -1) break;
      let end = lf;
      // Accept CRLF input by stripping the CR; LF alone remains the delimiter.
      if (end > start && this.buf[end - 1] === 0x0d) end -= 1;
      const line = this.buf.subarray(start, end).toString("utf8");
      start = lf + 1;
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch (cause) {
        throw new Error(`not JSONL: ${JSON.stringify(line.slice(0, 200))}`, { cause });
      }
    }
    if (start > 0) this.buf = this.buf.subarray(start);
    return out;
  }
}
