import { describe, expect, it } from "vitest";
import { highlightCode } from "../src/highlight-code";

describe("code highlighting", () => {
  it("highlights TSX with both themes using source offsets across whitespace and Unicode", async () => {
    const source =
      "\n  // 👋\n\n  export const Badge = () => <span>Ready</span>;\n";
    const tokens = await highlightCode(source, "tsx");

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((token) => source.slice(token.from, token.to))).toContain(
      "export",
    );
    for (const token of tokens) {
      expect(token.from).toBeGreaterThanOrEqual(0);
      expect(token.to).toBeLessThanOrEqual(source.length);
      expect(token.style).toMatch(
        /--shiki-light:#[\da-f]+;--shiki-dark:#[\da-f]+/i,
      );
    }
    const keyword = tokens.find(
      (token) => source.slice(token.from, token.to) === "export",
    );
    expect(keyword?.from).toBe(source.indexOf("export"));
  });

  it.each([
    "unknown-roughdraft-language",
    "constructor",
    "__proto__",
  ])("leaves %s readable as plain text", async (language) => {
    await expect(highlightCode("  alpha < beta\n", language)).resolves.toEqual(
      [],
    );
  });
});
