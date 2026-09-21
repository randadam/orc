/**
 * Incremental decoder for Pi's RPC stream.
 *
 * Pi frames records with LF as the only delimiter, and CRLF is accepted by stripping the CR.
 * Node's `readline` also splits on U+2028 and U+2029, which are legal inside JSON strings, so no
 * generic line reader may be substituted here.
 */
export class JsonlDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /**
   * Append one stdout chunk.
   *
   * @param chunk bytes as they arrived; records may be split across chunks, mid-character included
   * @returns every complete record this chunk finished, in arrival order
   * @throws if a complete line is not valid JSON
   */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const lf = this.buf.indexOf(0x0a, start);
      if (lf === -1) break;
      let end = lf;
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

  /** Bytes held back waiting for a delimiter. Non-zero after a truncated stream means a lost record. */
  get pending(): number {
    return this.buf.length;
  }
}
