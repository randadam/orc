import { describe, expect, it } from "vitest";

import { PACKAGE } from "../src/index.js";

describe("@orc/runner", () => {
  it("names itself", () => {
    expect(PACKAGE).toBe("@orc/runner");
  });
});
