import { expect, test } from "vitest";
import { renderStartupBanner } from "./banner.js";

test("renders a stable plain-text startup banner", () => {
  const banner = renderStartupBanner("1.2.3", false);

  expect(banner).toContain("GitHub Copilot");
  expect(banner).toContain("CHANGELOG");
  expect(banner).toContain("[v1.2.3]");
  expect(banner).toContain("[ready]");
  expect(banner).not.toContain("\u001B[");
  expect(new Set(banner.split("\n").map((line) => line.length))).toEqual(new Set([60]));
});

test("uses a compact banner in narrow terminals", () => {
  const banner = renderStartupBanner("1.2.3", false, 50);

  expect(banner.split("\n")).toHaveLength(2);
  expect(banner).toContain("CHANGELOG CLI v1.2.3");
});
