import { afterEach, expect, it, vi } from "vitest";
import { writeTextToClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});
it("copies on a local HTTP domain without the async Clipboard API", async () => {
  vi.stubGlobal("navigator", {});
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const copy = vi.fn(() => {
    expect((document.activeElement as HTMLTextAreaElement).value).toBe(
      "review notes",
    );
    return true;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: copy,
  });
  await writeTextToClipboard("review notes");
  expect(copy).toHaveBeenCalledWith("copy");
  expect(document.activeElement).toBe(trigger);
  expect(
    document.querySelector('[data-testid="clipboard-fallback"]'),
  ).toBeNull();
});
it("reports clipboard failure instead of claiming success", async () => {
  vi.stubGlobal("navigator", {});
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => false,
  });
  await expect(writeTextToClipboard("notes")).rejects.toThrow("Could not copy");
  expect(
    document.querySelector('[data-testid="clipboard-fallback"]'),
  ).toBeNull();
});
