import { describe, expect, it } from "vitest";

import { JsonlDecoder } from "../src/framing.js";

describe("JsonlDecoder", () => {
  it("splits on LF", () => {
    expect(new JsonlDecoder().push(Buffer.from('{"a":1}\n{"a":2}\n'))).toHaveLength(2);
  });

  it("strips a trailing CR", () => {
    const [record] = new JsonlDecoder().push(Buffer.from('{"a":1}\r\n')) as Array<{ a: number }>;
    expect(record).toEqual({ a: 1 });
  });

  it("does not split on U+2028 or U+2029 inside a string", () => {
    const records = new JsonlDecoder().push(Buffer.from('{"t":"a\u2028b\u2029c"}\n')) as Array<{
      t: string;
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.t).toBe("a\u2028b\u2029c");
  });

  it("holds a record split across chunks", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push(Buffer.from('{"a":'))).toHaveLength(0);
    expect(decoder.pending).toBe(5);
    expect(decoder.push(Buffer.from("1}\n"))).toEqual([{ a: 1 }]);
    expect(decoder.pending).toBe(0);
  });

  it("holds a multi-byte character split across chunks", () => {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from('{"t":"é☃"}\n', "utf8");
    expect(decoder.push(bytes.subarray(0, 9))).toHaveLength(0);
    const records = decoder.push(bytes.subarray(9)) as Array<{ t: string }>;
    expect(records[0]?.t).toBe("é☃");
  });

  it("ignores blank records", () => {
    expect(new JsonlDecoder().push(Buffer.from('\n\r\n{"a":1}\n'))).toEqual([{ a: 1 }]);
  });

  it("throws on a complete line that is not JSON", () => {
    expect(() => new JsonlDecoder().push(Buffer.from("not json\n"))).toThrow(/not JSONL/);
  });
});
