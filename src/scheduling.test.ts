import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { expect, test } from "vitest";
import { loadProfile } from "./profiles.js";

test("scheduling templates are opt-in, preserve state and use bounded incremental runs", async () => {
  const yaml = await readFile(resolve("examples", "scheduled-briefing.yml"), "utf8");
  expect(yaml).toContain("Copy to .github/workflows/ only");
  expect(yaml).toContain("cancel-in-progress: false");
  expect(yaml).toContain("secrets.COPILOT_TOKEN");
  expect(yaml).toContain("output/.briefing-state");
  expect(yaml).toContain("output/.*.checkpoint.json");
  expect(yaml).toContain(
    "node dist/cli.js --config examples/profiles.json --profile team --since-last-run --resume --export-json output/latest.json",
  );
  expect(yaml).not.toMatch(/(?:^|\s)-[gpIRe](?:\s|$)/);
  expect(yaml).toMatch(/Preserve progress[\s\S]*if: always\(\)/);
  const profile = await loadProfile(resolve("examples", "profiles.json"), "team");
  expect(profile.maxCredits).toBe("5");
  expect(profile.concurrency).toBe("3");
  const xml = await readFile(resolve("examples", "windows-weekly-task.xml"), "utf8");
  expect(XMLValidator.validate(xml)).toBe(true);
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(xml).toContain("--profile team --since-last-run --resume");
});
