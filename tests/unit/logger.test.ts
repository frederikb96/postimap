import { describe, expect, test } from "vitest";
import { logger, setLogLevel } from "../../src/util/logger.js";

describe("setLogLevel", () => {
  test("changes the root logger's level", () => {
    const original = logger.level;
    try {
      setLogLevel("debug");
      expect(logger.level).toBe("debug");

      setLogLevel("error");
      expect(logger.level).toBe("error");
    } finally {
      setLogLevel(original);
    }
  });
});
