import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import JSZip from "jszip";
import { expect, test, vi } from "vitest";
import type { EnrichmentCopilotClient } from "./enricher.js";
import { runSkillDeck, type SkillDeckOptions } from "./skill-deck.js";
import { skillSections } from "./skill-content.js";
import { CreditLimitError } from "./usage.js";

const generated = {
  section: "improvement",
  category: "agenti",
  status: "NON INDICATO",
  hero_value: "IDE",
  hero_label: "Sessioni agente raggruppate",
  summary: "Copilot raggruppa le sessioni correlate nell'editor.",
  points: ["Raggruppa le sessioni correlate", "Conserva il contesto del lavoro", "Mostra le sessioni nell'editor"],
  availability: "Disponibilità non indicata.",
  how_to: "La procedura non è indicata.",
  facts: ["Sessioni agente", "Editor", "Copilot"],
};

function item(title: string, day: number): string {
  return `<item><title>${title}</title><link>https://github.blog/changelog/2026-08-${day}-update</link>
    <pubDate>2026-08-${day}</pubDate><category>Improvement</category>
    <description>Copilot groups related agent sessions and preserves context in the editor.</description></item>`;
}

async function fixture(titles: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "copilot-skill-test-"));
  const feed = join(directory, "feed.xml");
  await writeFile(feed, `<rss><channel>${titles.map((title, index) => item(title, 20 - index)).join("")}</channel></rss>`);
  const output = join(directory, "output");
  const options: SkillDeckOptions = {
    from: "2026-08-01", to: "2026-08-31", output, feed, model: "auto",
    requestTimeout: "30", author: "Test author",
  };
  return { directory, output, options };
}

function clientWithResponses(responses: string[][]) {
  const createSession = vi.fn(async (_config: Parameters<EnrichmentCopilotClient["createSession"]>[0]) => {
    const values = responses.shift();
    if (!values) throw new Error("Unexpected Copilot session");
    return {
      sendAndWait: vi.fn(async () => ({ data: { content: values.shift() ?? "" } })),
      abort: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
  });
  const client: EnrichmentCopilotClient = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => []),
    createSession,
  };
  return { client, createSession };
}

function fakePython(issuesByRound: Array<Array<{ slide: number; check: string; msg: string }>> = [], omitPreview = false) {
  const builds: unknown[][] = [];
  const runProcess = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes("-c")) return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "-m" && args[1] === "render_pptx.cli") {
      const directory = args[3];
      await mkdir(directory);
      const slides = 16 + 2 * builds.at(-1)!.length;
      for (let i = 1; i <= slides - Number(omitPreview); i += 1) {
        await writeFile(join(directory, `slide_${i}.png`), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    const script = basename(args[0]);
    const option = (name: string) => args[args.indexOf(name) + 1];
    if (script === "pick_images.py") {
      return { stdout: JSON.stringify({ article: 0, needs_illustration: [], banners_rejected: 0, review: [] }), stderr: "", code: 0 };
    }
    if (script === "build_deck.py") {
      const records = JSON.parse(await readFile(option("--news"), "utf8")) as Array<{ section: string }>;
      builds.push(records);
      await writeFile(option("--out"), "fake presentation");
      return { stdout: JSON.stringify({
        news: records.length, slides: 16 + 2 * records.length, dropped: [], banner_rejected: [],
        per_section: Object.fromEntries(skillSections.map((section) => [section, records.filter((record) => record.section === section).length])),
        images: { icon: records.length },
      }), stderr: "", code: 0 };
    }
    if (script === "check_deck.py") {
      const issues = issuesByRound.shift() ?? [];
      const directory = option("--out");
      await writeFile(join(directory, "ui_report.json"), JSON.stringify({
        errors: issues, warnings: [], info: {},
      }));
      return {
        stdout: JSON.stringify({ errors: issues.length, warnings: 0, sheets: 0 }),
        stderr: "", code: issues.length ? 1 : 0,
      };
    }
    throw new Error(`Unexpected process: ${args.join(" ")}`);
  });
  return { runProcess, builds };
}

test("loads the bundled skill, excludes weekly roundups before the limit, and preserves existing decks", async () => {
  const { directory, output, options } = await fixture(["GitHub Copilot weekly releases", "New agent grouping"]);
  const python = fakePython();
  const { client, createSession } = clientWithResponses([[JSON.stringify({
    ...generated, title: "Not the source title", url: "https://example.com", type: "Release",
  })]]);
  try {
    await mkdir(output);
    const existing = join(output, "copilot-changelog-2026-08-01-to-2026-08-31-skill.pptx");
    await writeFile(existing, "previous deck");
    await runSkillDeck({ ...options, limit: "1" }, { clientFactory: () => client, runProcess: python.runProcess });
    expect(await readFile(existing, "utf8")).toBe("previous deck");
    expect(await readFile(existing.replace(".pptx", "-2.pptx"), "utf8")).toBe("fake presentation");
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0][0]).toMatchObject({
      availableTools: [], enableSkills: true, enableConfigDiscovery: false,
      agent: "changelog-record",
      customAgents: [{ skills: ["github-copilot-changelog-deck"], tools: [] }],
    });
    expect(python.builds[0]).toMatchObject([{
      title: "New agent grouping", type: "Improvement",
      url: "https://github.blog/changelog/2026-08-19-update",
    }]);
    const qaCall = python.runProcess.mock.calls.find(([, args]) => basename(args[0]) === "check_deck.py");
    expect(qaCall?.[1]).not.toContain("--render");
    expect(qaCall?.[1]).not.toContain("--soffice");
    const probe = python.runProcess.mock.calls.find(([, args]) => args.includes("-c"));
    expect(probe?.[1].join(" ")).not.toMatch(/pypdfium2|fitz|soffice|render_pptx/i);
    expect((await readdir(output)).some((name) => name.includes(".qa-"))).toBe(true);
    expect((await readdir(output)).some((name) => name.endsWith(".checkpoint.json"))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports missing Python dependencies before starting Copilot", async () => {
  const { directory, options } = await fixture(["Agent grouping"]);
  const clientFactory = vi.fn();
  const runProcess = vi.fn(async () => { throw new Error("No module named 'pptx'"); });
  try {
    await expect(runSkillDeck({ ...options, python: "python" }, { clientFactory, runProcess }))
      .rejects.toThrow(/python -m pip install python-pptx/);
    expect(clientFactory).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates one optional preview per slide after static checks", async () => {
  const { directory, output, options } = await fixture(["Agent grouping"]);
  const python = fakePython();
  const { client } = clientWithResponses([[JSON.stringify(generated)]]);
  try {
    await runSkillDeck({ ...options, preview: true }, { clientFactory: () => client, runProcess: python.runProcess });
    const probe = python.runProcess.mock.calls.find(([, args]) => args.includes("-c"));
    expect(probe?.[1].join(" ")).toContain("render_pptx.cli");
    const qa = (await readdir(output)).find((name) => name.includes(".qa-"));
    expect(qa).toBeDefined();
    expect(await readdir(join(output, qa!, "previews"))).toHaveLength(18);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not deliver a deck if requested previews are incomplete", async () => {
  const { directory, output, options } = await fixture(["Agent grouping"]);
  const python = fakePython([], true);
  const { client } = clientWithResponses([[JSON.stringify(generated)]]);
  try {
    await expect(runSkillDeck({ ...options, preview: true }, { clientFactory: () => client, runProcess: python.runProcess }))
      .rejects.toThrow("Preview rendering did not produce slide_18.png");
    const files = await readdir(output);
    expect(files.some((name) => name.endsWith(".pptx"))).toBe(false);
    expect(files.some((name) => name.endsWith(".checkpoint.json"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not deliver a deck if a preview is not a PNG", async () => {
  const { directory, output, options } = await fixture(["Agent grouping"]);
  const python = fakePython();
  const { client } = clientWithResponses([[JSON.stringify(generated)]]);
  const runProcess = async (command: string, args: string[]) => {
    const result = await python.runProcess(command, args);
    if (args[1] === "render_pptx.cli") {
      await writeFile(join(args[3], "slide_1.png"), "not a PNG");
    }
    return result;
  };
  try {
    await expect(runSkillDeck({ ...options, preview: true }, { clientFactory: () => client, runProcess }))
      .rejects.toThrow("Preview rendering produced an invalid PNG: slide_1.png");
    const files = await readdir(output);
    expect(files.some((name) => name.endsWith(".pptx"))).toBe(false);
    expect(files.some((name) => name.endsWith(".checkpoint.json"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports the optional preview dependency before starting Copilot", async () => {
  const { directory, options } = await fixture(["Agent grouping"]);
  const clientFactory = vi.fn();
  const runProcess = vi.fn(async () => { throw new Error("No module named 'render_pptx'"); });
  try {
    await expect(runSkillDeck({ ...options, python: "python", preview: true }, { clientFactory, runProcess }))
      .rejects.toThrow(/pip install render-pptx==0\.2\.0/);
    expect(clientFactory).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumes accepted articles and refuses a budget when previous usage was not reported", async () => {
  const { directory, output, options } = await fixture(["First article", "Second article"]);
  const python = fakePython();
  const first = clientWithResponses([[JSON.stringify(generated)], ["{}", "{}", "{}"]]);
  try {
    await expect(runSkillDeck(options, { clientFactory: () => first.client, runProcess: python.runProcess }))
      .rejects.toThrow(/after three attempts/);
    const checkpoint = join(output, ".copilot-changelog-2026-08-01-to-2026-08-31-skill.checkpoint.json");
    const state = JSON.parse(await readFile(checkpoint, "utf8"));
    expect(state.completed.map((record: { title: string }) => record.title)).toEqual(["First article"]);
    expect(state.usage.requests).toBe(4);
    expect(state.usage.historyIncomplete).toBe(true);
    const blocked = clientWithResponses([]);
    await expect(runSkillDeck({ ...options, resume: true, maxCredits: "2" }, {
      clientFactory: () => blocked.client, runProcess: python.runProcess,
    })).rejects.toBeInstanceOf(CreditLimitError);
    expect(blocked.createSession).not.toHaveBeenCalled();
    const resumed = clientWithResponses([[JSON.stringify(generated)]]);
    await runSkillDeck({ ...options, resume: true }, { clientFactory: () => resumed.client, runProcess: python.runProcess });
    expect(resumed.createSession).toHaveBeenCalledOnce();
    expect(python.builds[0]).toHaveLength(2);
    await expect(readFile(checkpoint)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairs article-level QA errors before delivering a deck", async () => {
  const { directory, options } = await fixture(["Agent grouping"]);
  const python = fakePython([[{ slide: 10, check: "overflow", msg: "Text too long" }], []]);
  const { client, createSession } = clientWithResponses([
    [JSON.stringify(generated)], [JSON.stringify({ ...generated, summary: "Copilot raggruppa le sessioni nell'editor." })],
  ]);
  try {
    await runSkillDeck(options, { clientFactory: () => client, runProcess: python.runProcess });
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(python.builds).toHaveLength(2);
    expect(python.builds[1]).toMatchObject([{ summary: "Copilot raggruppa le sessioni nell'editor." }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the checkpoint and QA report instead of delivering a deck on a non-repairable QA error", async () => {
  const { directory, output, options } = await fixture(["Agent grouping"]);
  const failed = fakePython([[{ slide: 1, check: "ground", msg: "Unexpected background" }]]);
  const first = clientWithResponses([[JSON.stringify(generated)]]);
  try {
    await expect(runSkillDeck(options, { clientFactory: () => first.client, runProcess: failed.runProcess }))
      .rejects.toThrow(/manual inspection/);
    const files = await readdir(output);
    expect(files.some((name) => name.endsWith(".pptx"))).toBe(false);
    expect(files.some((name) => name.endsWith(".checkpoint.json"))).toBe(true);
    expect(files.some((name) => name.includes(".work-"))).toBe(true);
    const resumed = clientWithResponses([]);
    const fixed = fakePython();
    await runSkillDeck({ ...options, resume: true }, { clientFactory: () => resumed.client, runProcess: fixed.runProcess });
    expect(resumed.createSession).not.toHaveBeenCalled();
    expect((await readdir(output)).some((name) => name.endsWith(".pptx"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(!process.env.SKILL_TEST_PYTHON)(
  "runs the bundled Python renderer and verifies the real PowerPoint and static QA",
  async () => {
    const { directory, output, options } = await fixture(["Agent grouping", "Model retirement"]);
    const { client } = clientWithResponses([
      [JSON.stringify(generated)],
      [JSON.stringify({
        ...generated, section: "retired", category: "modelli", status: "DISMESSO",
        hero_value: "01/02", hero_label: "Data di dismissione",
        summary: "Il modello precedente è stato dismesso il 1 febbraio.",
        points: ["Il modello precedente è stato dismesso", "La data è il 1 febbraio 2026", "È disponibile un'alternativa"],
        availability: "Disponibilità non indicata.",
        how_to: "Passa al modello alternativo.",
        facts: ["Modello precedente", "1 febbraio 2026", "Modello alternativo"],
        migrations: [["Modello precedente", "2026-02-01", "Modello alternativo"]],
      })],
    ]);
    try {
      const preview = Boolean(process.env.SKILL_TEST_PREVIEW);
      await runSkillDeck({ ...options, python: process.env.SKILL_TEST_PYTHON, preview }, { clientFactory: () => client });
      const entries = await readdir(output);
      const deck = entries.find((name) => name.endsWith(".pptx"));
      const qa = entries.find((name) => name.includes(".qa-"));
      expect(deck).toBeDefined();
      expect(qa).toBeDefined();
      const archive = await JSZip.loadAsync(await readFile(join(output, deck!)));
      const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      expect(slides).toHaveLength(21);
      const presentation = await archive.file("ppt/presentation.xml")!.async("string");
      expect([...presentation.matchAll(/<p14:section name="([^"]+)"/g)].map((match) => match[1]))
        .toEqual(["Introduzione", "Modelli", "Release", "Improvement", "Governance", "IDE", "Retired", "Chiusura"]);
      const agendaLinks = await archive.file("ppt/slides/_rels/slide3.xml.rels")!.async("string");
      for (const number of [5, 7, 9, 13, 15, 17]) {
        expect(await archive.file(`ppt/slides/slide${number}.xml`)!.async("string")).toMatch(/show="0"/);
        expect(agendaLinks).toContain(`Target="slide${number}.xml"`);
      }
      const cover = await archive.file("ppt/slides/slide10.xml")!.async("string");
      const detail = await archive.file("ppt/slides/slide11.xml")!.async("string");
      expect(cover).toContain("2026-08-20");
      expect(detail).toContain("2026-08-20");
      const calendar = await archive.file("ppt/slides/slide20.xml")!.async("string");
      expect(calendar).toContain("2026-02-01");
      expect(calendar).toContain("DISMESSO");
      expect(calendar).not.toContain("IN ARRIVO");
      const notes = await Promise.all(Object.keys(archive.files)
        .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
        .map((name) => archive.file(name)!.async("string")));
      expect(notes.filter((xml) => xml.includes("Articolo:") &&
        xml.includes("https://github.blog/changelog/2026-08-20-update"))).toHaveLength(2);
      const report = JSON.parse(await readFile(join(output, qa!, "ui_report.json"), "utf8"));
      expect(report.errors).toEqual([]);
      expect(report.info.sheets ?? []).toEqual([]);
      expect(await readdir(join(output, qa!))).not.toContain("sheets");
      if (preview) {
        const files = await readdir(join(output, qa!, "previews"));
        expect(files).toHaveLength(slides.length);
        for (let i = 1; i <= slides.length; i += 1) {
          expect((await readFile(join(output, qa!, "previews", `slide_${i}.png`))).subarray(0, 8))
            .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
