import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { outputFileStem } from "./output-naming.js";
import { formatEvidence } from "./generation.js";
import { builtinLanguage, isRtlLocale, localeName, type DeckLocalization, type PresentationStrings } from "./locales.js";
import {
  sections,
  sectionDetailKeys,
  explanatoryDetailKeys,
  type EnrichedPost,
  type Section,
  type SlideDetailKey,
  type SupportedLanguage,
} from "./types.js";

type Presentation = InstanceType<typeof PptxGenJS>;
type Slide = ReturnType<Presentation["addSlide"]>;
type TextOptions = Parameters<Slide["addText"]>[1];

const palette = {
  ink: "101411",
  charcoal: "232925",
  paper: "F2F5F3",
  white: "FFFFFF",
  green: "0FBF3E",
  greenSoft: "BFFFD1",
  purple: "8534F3",
  purpleSoft: "E9D9FF",
  muted: "5A635D",
  border: "B6BFB8",
};

const fonts = {
  heading: "Mona Sans",
  body: "Mona Sans",
  mono: "Hubot Sans",
};

const copilotLogoPath = fileURLToPath(new URL("../assets/copilot.png", import.meta.url));

interface PresentationOptions {
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: SupportedLanguage[];
  localization?: DeckLocalization;
}

interface ArticleFooter {
  url: string;
  publishedAt: string;
  language: SupportedLanguage;
}

function addCopilotMark(
  pptx: Presentation,
  slide: Slide,
  x: number,
  y: number,
  size: number,
): void {
  slide.addShape(pptx.ShapeType.ellipse, {
    x,
    y,
    w: size,
    h: size,
    fill: { color: palette.purple },
    line: { transparency: 100 },
  });
  const inset = size * 0.14;
  slide.addImage({
    path: copilotLogoPath,
    x: x + inset,
    y: y + inset,
    w: size - inset * 2,
    h: size - inset * 2,
    altText: "GitHub Copilot logo",
  });
}

const copy = {
  en: {
    changelog: "GITHUB COPILOT · CHANGELOG",
    title: "What changed\nin Copilot?",
    update: "UPDATE",
    updates: "UPDATES",
    section: "SECTION",
    sectionNames: {
      Models: "Models",
      "Enterprise Admins": "Enterprise Admins",
      Announcements: "Announcements",
      IDE: "IDE",
      Retirements: "Retirements",
    },
    detailLabels: {
      modelName: "MODEL NAME",
      availability: "AVAILABILITY",
      keyCapabilities: "KEY CAPABILITIES",
      useGuidance: "WHEN TO USE / AVOID",
      subject: "SUBJECT",
      retirementDate: "RETIREMENT DATE",
      reasons: "REASONS",
      replacement: "REPLACEMENT",
      feature: "FEATURE",
      howToUse: "HOW TO USE IT",
      announcement: "ANNOUNCEMENT",
      impact: "WHY IT MATTERS",
      audience: "WHO IS AFFECTED",
    },
  },
  it: {
    changelog: "GITHUB COPILOT · CHANGELOG",
    title: "Cosa cambia\nin Copilot?",
    update: "NOVITÀ",
    updates: "NOVITÀ",
    section: "SEZIONE",
    sectionNames: {
      Models: "Modelli",
      "Enterprise Admins": "Amministratori Enterprise",
      Announcements: "Annunci",
      IDE: "IDE",
      Retirements: "Dismissioni",
    },
    detailLabels: {
      modelName: "NOME DEL MODELLO",
      availability: "DISPONIBILITÀ",
      keyCapabilities: "CARATTERISTICHE PRINCIPALI",
      useGuidance: "QUANDO USARLO / EVITARLO",
      subject: "OGGETTO",
      retirementDate: "DATA DI DISMISSIONE",
      reasons: "MOTIVAZIONI",
      replacement: "SOSTITUTO",
      feature: "FUNZIONALITÀ",
      howToUse: "COME USARLA",
      announcement: "ANNUNCIO",
      impact: "PERCHÉ È IMPORTANTE",
      audience: "CHI È COINVOLTO",
    },
  },
} satisfies Record<"en" | "it", PresentationStrings>;

function presentationCopy(options: PresentationOptions): PresentationStrings {
  return options.localization?.slides?.locale === options.slidesLanguage
    ? options.localization.slides.text
    : copy[builtinLanguage(options.slidesLanguage) ?? "en"];
}

function localeText(locale: SupportedLanguage): TextOptions {
  const rtlMode = isRtlLocale(locale);
  return { lang: locale, rtlMode, ...(rtlMode ? { align: "right" } : {}) };
}

function sectionLabel(section: Section, options: PresentationOptions): string {
  return presentationCopy(options).sectionNames[section].toLocaleUpperCase(options.slidesLanguage);
}

function formatDate(
  date: Date,
  style: "medium" | "long",
  language: SupportedLanguage,
): string {
  return date.toLocaleDateString(language, {
    dateStyle: style,
    timeZone: "UTC",
  });
}

function formatSpeakerNotes(
  notes: Partial<Record<SupportedLanguage, string>>,
  languages: SupportedLanguage[],
): string {
  return languages
    .map((language) => `${localeName(language, language).toLocaleUpperCase(language)}\n${notes[language] ?? ""}`)
    .join("\n\n");
}

function imageDimensions(dataUri: string): { width: number; height: number } | undefined {
  const encoded = dataUri.slice(dataUri.indexOf(",") + 1);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length >= 24 &&
    bytes.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (
    bytes.length >= 10 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === undefined || marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += length + 2;
    }
  }
  return undefined;
}

function containImage(
  dataUri: string,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const dimensions = imageDimensions(dataUri);
  if (!dimensions) return box;
  const scale = Math.min(box.w / dimensions.width, box.h / dimensions.height);
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  return {
    x: box.x + (box.w - width) / 2,
    y: box.y + (box.h - height) / 2,
    w: width,
    h: height,
  };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wideCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;
const characterWidth = (grapheme: string) => wideCharacter.test(grapheme) ? 2 : 1;
const textWidth = (text: string) => [...graphemeSegmenter.segment(text)]
  .reduce((width, part) => width + characterWidth(part.segment), 0);

function wrapLines(text: string, maximumCharactersPerLine: number): string[] {
  const words = text.trim().replace(/\s+/g, " ").split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (textWidth(word) > maximumCharactersPerLine) {
      if (currentLine) { lines.push(currentLine); currentLine = ""; }
      let width = 0;
      for (const { segment } of graphemeSegmenter.segment(word)) {
        const size = characterWidth(segment);
        if (currentLine && width + size > maximumCharactersPerLine) {
          lines.push(currentLine);
          currentLine = "";
          width = 0;
        }
        currentLine += segment;
        width += size;
      }
      continue;
    }
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && textWidth(candidate) > maximumCharactersPerLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function addWrappedText(
  slide: Slide,
  text: string,
  maximumCharactersPerLine: number,
  box: { x: number; y: number; w: number; h: number },
  lineHeight: number,
  options: TextOptions,
  verticalAlignment: "top" | "middle" = "top",
  fitHeight = false,
): void {
  const lines = wrapLines(text, maximumCharactersPerLine);
  if (fitHeight && lines.length > 0) {
    const scale = Math.min(1, box.h / (lines.length * lineHeight));
    lineHeight *= scale;
    if (typeof options?.fontSize === "number") {
      options = { ...options, fontSize: options.fontSize * scale };
    }
  }
  const contentHeight = lines.length * lineHeight;
  const y =
    verticalAlignment === "middle"
      ? box.y + Math.max(0, (box.h - contentHeight) / 2)
      : box.y;

  lines.forEach((line, index) => {
    slide.addText(line, {
      ...options,
      x: box.x,
      y: y + index * lineHeight,
      w: box.w,
      h: lineHeight,
      margin: 0,
      wrap: false,
    });
  });
}

function titleSpeakerNotes(
  posts: EnrichedPost[],
  from: Date,
  to: Date,
  languages: SupportedLanguage[],
  localization?: DeckLocalization,
): Partial<Record<SupportedLanguage, string>> {
  return Object.fromEntries(
    languages.map((language) => [
      language,
      localization?.speakerNotes?.[language]
        ? localization.speakerNotes[language].introduction
          .replaceAll("{count}", new Intl.NumberFormat(language).format(posts.length))
          .replaceAll("{from}", formatDate(from, "long", language))
          .replaceAll("{to}", formatDate(to, "long", language))
        : builtinLanguage(language) === "it"
        ? `Benvenuti al briefing sul changelog di GitHub Copilot. La presentazione copre ${posts.length} ${
            posts.length === 1 ? "aggiornamento" : "aggiornamenti"
          } pubblicati tra il ${formatDate(from, "long", language)} e il ${formatDate(to, "long", language)}.`
        : `Welcome to the GitHub Copilot changelog briefing. This deck covers ${posts.length} ${
            posts.length === 1 ? "update" : "updates"
          } published between ${formatDate(from, "long", language)} and ${formatDate(to, "long", language)}.`,
    ]),
  );
}

function sectionSpeakerNotes(
  section: Section,
  count: number,
  languages: SupportedLanguage[],
  localization?: DeckLocalization,
): Partial<Record<SupportedLanguage, string>> {
  return Object.fromEntries(
    languages.map((language) => [
      language,
      localization?.speakerNotes?.[language]
        ? localization.speakerNotes[language].sections[section].replaceAll("{count}", new Intl.NumberFormat(language).format(count))
        : builtinLanguage(language) === "it"
        ? `Questa sezione presenta ${count} ${
            count === 1 ? "aggiornamento" : "aggiornamenti"
          } nella categoria ${copy.it.sectionNames[section]}. Introdurre il tema prima di passare alle singole novità.`
        : `This section covers ${count} ${copy.en.sectionNames[section].toLowerCase()} ${
            count === 1 ? "update" : "updates"
          }. Introduce the theme before moving into the individual announcements.`,
    ]),
  );
}

function addFooter(
  slide: Slide,
  index: number,
  article?: ArticleFooter,
  dark = false,
  locale = article?.language ?? "en",
): void {
  const footerColor = dark ? palette.border : palette.muted;
  slide.addText(String(index).padStart(2, "0"), {
    ...localeText(locale),
    x: 12.25,
    y: 7.05,
    w: 0.45,
    h: 0.2,
    fontFace: fonts.mono,
    fontSize: 9,
    color: footerColor,
    margin: 0,
    align: "right",
  });
  if (article) {
    const date = formatDate(new Date(article.publishedAt), "medium", article.language);
    slide.addText([
      {
        text: `${date}  ·  `,
        options: { color: footerColor },
      },
      {
        text: (() => {
          const source = new URL(article.url);
          return source.hostname === "github.blog" && source.pathname.startsWith("/changelog/")
            ? "github.blog/changelog"
            : source.hostname;
        })(),
        options: {
          color: footerColor,
          hyperlink: { url: article.url },
          underline: { color: footerColor },
        },
      },
    ], {
      ...localeText(locale),
      x: 0.65,
      y: 7.02,
      w: 4.8,
      h: 0.22,
      fontFace: fonts.mono,
      fontSize: 9,
      color: footerColor,
      margin: 0,
    });
  }
}

function articleFooter(post: EnrichedPost, language: SupportedLanguage): ArticleFooter {
  return {
    url: post.url,
    publishedAt: post.publishedAt,
    language,
  };
}

function addTitleSlide(
  pptx: Presentation,
  posts: EnrichedPost[],
  from: Date,
  to: Date,
  slideNumber: number,
  options: PresentationOptions,
): void {
  const labels = presentationCopy(options);
  const slide = pptx.addSlide();
  slide.background = { color: palette.ink };
  slide.addShape(pptx.ShapeType.rect, {
    x: 10.38,
    y: 0,
    w: 2.95,
    h: 2.95,
    fill: { color: palette.green },
    line: { transparency: 100 },
  });
  addCopilotMark(pptx, slide, 9.18, 1.72, 2.45);
  slide.addText(labels.changelog, {
    ...localeText(options.slidesLanguage),
    x: 0.75,
    y: 0.65,
    w: 5.5,
    h: 0.25,
    fontFace: fonts.mono,
    fontSize: 12,
    bold: true,
    color: palette.green,
    charSpacing: 1.8,
    margin: 0,
  });
  slide.addText(labels.title, {
    ...localeText(options.slidesLanguage),
    x: 0.75,
    y: 1.45,
    w: 8.8,
    h: 2.35,
    fontFace: fonts.heading,
    fontSize: 48,
    bold: true,
    color: palette.white,
    breakLine: false,
    margin: 0,
  });
  slide.addText(
    `${formatDate(from, "medium", options.slidesLanguage)} — ${formatDate(to, "medium", options.slidesLanguage)}`,
    {
      ...localeText(options.slidesLanguage),
      x: 0.78,
      y: 4.35,
      w: 5.5,
      h: 0.35,
      fontFace: fonts.body,
      fontSize: 18,
      color: palette.white,
      margin: 0,
    },
  );
  slide.addText(`${posts.length}`, {
    ...localeText(options.slidesLanguage),
    x: 10.55,
    y: 5.25,
    w: 1.35,
    h: 0.7,
    fontFace: fonts.heading,
    fontSize: 42,
    bold: true,
    color: palette.white,
    margin: 0,
    align: "right",
  });
  slide.addText(posts.length === 1 ? labels.update : labels.updates, {
    ...localeText(options.slidesLanguage),
    x: 10.4,
    y: 6.0,
    w: 1.5,
    h: 0.25,
    fontFace: fonts.mono,
    fontSize: 10,
    bold: true,
    color: palette.green,
    charSpacing: 1.5,
    margin: 0,
    align: "right",
  });
  slide.addNotes(
    formatSpeakerNotes(
      titleSpeakerNotes(posts, from, to, options.speakerNotesLanguages, options.localization),
      options.speakerNotesLanguages,
    ),
  );
  addFooter(slide, slideNumber, undefined, true, options.slidesLanguage);
}

function addSectionSlide(
  pptx: Presentation,
  section: Section,
  count: number,
  slideNumber: number,
  options: PresentationOptions,
): void {
  const labels = presentationCopy(options);
  const slide = pptx.addSlide();
  slide.background = { color: palette.ink };
  slide.addShape(pptx.ShapeType.rect, {
    x: 12.02,
    y: 0,
    w: 1.31,
    h: 7.5,
    fill: { color: palette.green },
    line: { transparency: 100 },
  });
  addCopilotMark(pptx, slide, 10.92, 4.85, 1.72);
  slide.addText(String(count).padStart(2, "0"), {
    ...localeText(options.slidesLanguage),
    x: 0.7,
    y: 0.55,
    w: 1,
    h: 0.55,
    fontFace: fonts.mono,
    fontSize: 28,
    color: palette.green,
    bold: true,
    margin: 0,
  });
  slide.addText(labels.section, {
    ...localeText(options.slidesLanguage),
    x: 0.75,
    y: 2.25,
    w: 2,
    h: 0.3,
    fontFace: fonts.mono,
    fontSize: 12,
    color: palette.border,
    bold: true,
    charSpacing: 2,
    margin: 0,
  });
  slide.addText(labels.sectionNames[section], {
    ...localeText(options.slidesLanguage),
    x: 0.7,
    y: 2.7,
    w: 10.8,
    h: 1.2,
    fontFace: fonts.heading,
    fontSize: 60,
    color: palette.white,
    bold: true,
    margin: 0,
  });
  slide.addNotes(
    formatSpeakerNotes(
      sectionSpeakerNotes(section, count, options.speakerNotesLanguages, options.localization),
      options.speakerNotesLanguages,
    ),
  );
  addFooter(slide, slideNumber, undefined, true, options.slidesLanguage);
}

function addPostHero(
  pptx: Presentation,
  post: EnrichedPost,
  slideNumber: number,
  options: PresentationOptions,
): void {
  const slide = pptx.addSlide();
  slide.background = { color: palette.ink };
  const hasImage = Boolean(post.imageDataUri);
  const displayTitle = post.localization?.articleTitle ?? post.title;
  const titleLength = textWidth(displayTitle);
  if (post.imageDataUri) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 6.85,
      y: 0.38,
      w: 5.8,
      h: 6.52,
      rectRadius: 0.08,
      fill: { color: palette.white },
      line: { color: palette.white },
    });
    const imageBox = containImage(post.imageDataUri, {
      x: 7.05,
      y: 0.58,
      w: 5.4,
      h: 6.12,
    });
    slide.addImage({
      data: post.imageDataUri,
      ...imageBox,
      hyperlink: { url: post.url },
      altText: displayTitle,
    });
    addCopilotMark(pptx, slide, 11.45, 0.65, 0.78);
  } else {
    slide.addShape(pptx.ShapeType.rect, {
      x: 12.02,
      y: 0,
      w: 1.31,
      h: 7.5,
      fill: { color: palette.green },
      line: { transparency: 100 },
    });
    addCopilotMark(pptx, slide, 10.92, 4.95, 1.42);
  }
  slide.addText(sectionLabel(post.section, options), {
    ...localeText(options.slidesLanguage),
    x: 0.72,
    y: 0.65,
    w: 3.3,
    h: 0.25,
    fontFace: fonts.mono,
    fontSize: 11,
    color: palette.green,
    bold: true,
    charSpacing: 1.7,
    margin: 0,
  });
  const heroTitleSize = hasImage
    ? titleLength > 110
      ? 20
      : titleLength > 72
        ? 22
        : titleLength > 55
          ? 24
          : 32
    : titleLength > 110
      ? 32
      : titleLength > 72
        ? 36
        : 52;
  const heroLineLength = hasImage
    ? heroTitleSize >= 32
      ? 28
      : heroTitleSize >= 24
        ? 36
        : heroTitleSize >= 22
          ? 40
          : 46
    : heroTitleSize >= 52
      ? 36
      : heroTitleSize >= 36
        ? 52
        : 60;
  const titleBox = hasImage
    ? { x: 0.72, y: 1.35, w: 5.75, h: 3.35 }
    : { x: 0.72, y: 1.3, w: 10.35, h: 4.55 };
  addWrappedText(
    slide,
    displayTitle,
    heroLineLength,
    titleBox,
    heroTitleSize / 58,
    {
      ...localeText(options.slidesLanguage),
      fontFace: fonts.heading,
      fontSize: heroTitleSize,
      bold: true,
      color: palette.white,
    },
    "middle",
  );
  slide.addNotes(formatSpeakerNotes(post.speakerNotes, options.speakerNotesLanguages) + formatEvidence(post));
  addFooter(slide, slideNumber, articleFooter(post, options.slidesLanguage), true);
}

function addPostDetails(
  pptx: Presentation,
  post: EnrichedPost,
  slideNumber: number,
  options: PresentationOptions,
): void {
  const labels = presentationCopy(options);
  const displayTitle = post.localization?.articleTitle ?? post.title;
  const titleLength = textWidth(displayTitle);
  const slide = pptx.addSlide();
  slide.background = { color: palette.paper };
  slide.addShape(pptx.ShapeType.rect, {
    x: 12.17,
    y: 0.38,
    w: 0.52,
    h: 0.52,
    fill: { color: palette.green },
    line: { transparency: 100 },
  });
  addCopilotMark(pptx, slide, 11.75, 0.65, 0.68);
  slide.addText(sectionLabel(post.section, options), {
    ...localeText(options.slidesLanguage),
    x: 0.7,
    y: 0.5,
    w: 3.3,
    h: 0.25,
    fontFace: fonts.mono,
    fontSize: 10,
    color: palette.green,
    bold: true,
    charSpacing: 1.5,
    margin: 0,
  });
  const detailsTitleSize = titleLength > 110 ? 23 : titleLength > 72 ? 26 : 30;
  const detailsTitleLineLength =
    detailsTitleSize >= 30 ? 68 : detailsTitleSize >= 26 ? 76 : 84;
  addWrappedText(
    slide,
    displayTitle,
    detailsTitleLineLength,
    { x: 0.7, y: 0.95, w: 10.85, h: 1.12 },
    detailsTitleSize / 58,
    {
      ...localeText(options.slidesLanguage),
      fontFace: fonts.heading,
      fontSize: detailsTitleSize,
      bold: true,
      color: palette.ink,
    },
    "middle",
  );
  const summarySize = post.summary.length > 180 ? 13 : post.summary.length > 120 ? 14.5 : 16;
  addWrappedText(
    slide,
    post.summary,
    108,
    { x: 0.72, y: 2.2, w: 11.85, h: 0.62 },
    summarySize / 55,
    {
      ...localeText(options.slidesLanguage),
      fontFace: fonts.body,
      fontSize: summarySize,
      color: palette.muted,
    },
  );
  const keys = sectionDetailKeys[post.section];
  const announcements =
    post.section === "Announcements" || post.section === "Enterprise Admins";
  keys.forEach((key, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const leftWidth = announcements ? 11.56 * 2 / 3 : 5.78;
    const cardWidth = column === 0 ? leftWidth : announcements ? 11.56 / 3 : 5.78;
    const textWidth = cardWidth - 0.53;
    const x = 0.7 + column * (leftWidth + 0.37);
    const y = 2.95 + row * 1.82;
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w: cardWidth,
      h: 1.68,
      rectRadius: 0.06,
      fill: { color: index === 0 ? palette.greenSoft : palette.white },
      line: { color: index === 0 ? palette.greenSoft : palette.border, width: 1 },
    });
    slide.addText(labels.detailLabels[key], {
      ...localeText(options.slidesLanguage),
      x: x + 0.25,
      y: y + 0.17,
      w: textWidth,
      h: 0.2,
      fontFace: fonts.mono,
      fontSize: 9,
      bold: true,
      color: index === 0 ? palette.ink : palette.green,
      charSpacing: 1.1,
      margin: 0,
    });
    const detail = post.details[key] ?? "";
    const richer = explanatoryDetailKeys.has(key) && detail.length > 180;
    const detailSize = announcements ? (column === 0 ? 12 : 13.5)
      : richer ? 12 : detail.length > 180 ? 10.5 : detail.length > 120 ? 12 : 13.5;
    addWrappedText(
      slide,
      detail,
      Math.floor(62 * textWidth / 5.25),
      { x: x + 0.25, y: y + 0.48, w: textWidth, h: 0.98 },
      detailSize / (richer ? 60 : 51),
      {
        ...localeText(options.slidesLanguage),
        fontFace: fonts.body,
        fontSize: detailSize,
        color: palette.ink,
      },
      "middle",
      announcements || richer,
    );
  });
  slide.addNotes(formatSpeakerNotes(post.speakerNotes, options.speakerNotesLanguages) + formatEvidence(post));
  addFooter(slide, slideNumber, articleFooter(post, options.slidesLanguage));
}

function replaceThemeColor(xml: string, key: string, color: string): string {
  const pattern = new RegExp(`<a:${key}>.*?</a:${key}>`);
  if (!pattern.test(xml)) {
    throw new Error(`PowerPoint theme color '${key}' was not found.`);
  }
  return xml.replace(pattern, `<a:${key}><a:srgbClr val="${color}"/></a:${key}>`);
}

async function applyGitHubTheme(data: Uint8Array, path: string): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  const themeFile = zip.file("ppt/theme/theme1.xml");
  if (!themeFile) {
    throw new Error("PowerPoint theme XML was not generated.");
  }

  let theme = await themeFile.async("string");
  theme = theme
    .replace(/<a:theme ([^>]*?)name="[^"]*"/, '<a:theme $1name="GitHub"')
    .replace(/<a:clrScheme name="[^"]*"/, '<a:clrScheme name="GitHub"')
    .replace(/<a:fontScheme name="[^"]*"/, '<a:fontScheme name="GitHub"');

  const themeColors = {
    dk1: palette.ink,
    lt1: palette.white,
    dk2: palette.charcoal,
    lt2: palette.paper,
    accent1: palette.green,
    accent2: palette.purple,
    accent3: palette.greenSoft,
    accent4: palette.purpleSoft,
    accent5: palette.border,
    accent6: palette.muted,
    hlink: "0969DA",
    folHlink: "8250DF",
  };
  for (const [key, color] of Object.entries(themeColors)) {
    theme = replaceThemeColor(theme, key, color);
  }

  zip.file("ppt/theme/theme1.xml", theme);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

export async function writePresentation(
  posts: EnrichedPost[],
  outputDirectory: string,
  from: Date,
  to: Date,
  options: PresentationOptions,
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const pptx = new PptxGenJS();
  const slides = posts.find((post) => post.localization?.slides?.locale === options.slidesLanguage)?.localization?.slides;
  const speakerNotes = Object.fromEntries(options.speakerNotesLanguages.flatMap((locale) => {
    const translated = posts.find((post) => post.localization?.speakerNotes?.[locale])?.localization?.speakerNotes?.[locale];
    return translated ? [[locale, translated]] : [];
  }));
  options = { ...options, localization: { ...(slides ? { slides } : {}), speakerNotes } };
  pptx.rtlMode = isRtlLocale(options.slidesLanguage);
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Copilot Changelog CLI";
  pptx.company = "GitHub";
  pptx.subject = "GitHub Copilot changelog digest";
  pptx.title = "GitHub Copilot Changelog";
  pptx.theme = {
    headFontFace: fonts.heading,
    bodyFontFace: fonts.body,
  };

  let slideNumber = 1;
  addTitleSlide(pptx, posts, from, to, slideNumber++, options);
  for (const section of sections) {
    const sectionPosts = posts.filter((post) => post.section === section);
    if (!sectionPosts.length) continue;
    addSectionSlide(pptx, section, sectionPosts.length, slideNumber++, options);
    for (const post of sectionPosts) {
      addPostHero(pptx, post, slideNumber++, options);
      addPostDetails(pptx, post, slideNumber++, options);
    }
  }

  const path = join(outputDirectory, `${outputFileStem(from, to)}.pptx`);
  const data = await pptx.write({ outputType: "nodebuffer" });
  if (!(data instanceof Uint8Array)) {
    throw new Error("PowerPoint export did not return a binary buffer.");
  }
  await applyGitHubTheme(data, path);
  return path;
}
