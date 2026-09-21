import { describe, expect, it } from "vitest";

import { PACKAGE } from "../src/index.js";

describe("@orc/cli", () => {
  it("names itself", () => {
    expect(PACKAGE).toBe("@orc/cli");
  });
});
