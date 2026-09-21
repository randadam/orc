import { describe, expect, it } from "vitest";

import { PACKAGE } from "../src/index.js";

describe("@orc/sdk", () => {
  it("names itself", () => {
    expect(PACKAGE).toBe("@orc/sdk");
  });
});
