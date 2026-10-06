import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { outputFileStem } from "./output-naming.js";
import { sections, type EnrichedPost } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(date: Date, style: "short" | "long" = "short"): string {
  return date.toLocaleDateString("en-US", {
    dateStyle: style,
    timeZone: "UTC",
  });
}

function sectionId(section: string): string {
  return section.toLowerCase().replaceAll(" ", "-");
}

function postCard(post: EnrichedPost): string {
  const image = post.imageDataUri
    ? `<img class="card-image" src="${post.imageDataUri}" alt="">`
    : `<div class="image-placeholder" aria-hidden="true"><span>${escapeHtml(post.section)}</span></div>`;
  const notes = post.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const links = post.links
    .slice(0, 6)
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`,
    )
    .join("");

  return `<article class="card" data-search="${escapeHtml(
    `${post.title} ${post.summary} ${post.notes.join(" ")}`.toLowerCase(),
  )}">
    ${image}
    <div class="card-body">
      <div class="meta"><time datetime="${post.publishedAt}">${formatDate(
        new Date(post.publishedAt),
        "long",
      )}</time>${post.author ? `<span>${escapeHtml(post.author)}</span>` : ""}</div>
      <h3>${escapeHtml(post.title)}</h3>
      <p class="summary">${escapeHtml(post.summary)}</p>
      <h4>What changed</h4>
      <ul>${notes}</ul>
      <div class="links">${links}</div>
      <a class="source" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">Read the original changelog</a>
    </div>
  </article>`;
}

export function renderWebsite(posts: EnrichedPost[], from: Date, to: Date): string {
  const content = sections
    .map((section) => {
      const items = posts.filter((post) => post.section === section);
      if (!items.length) return "";
      return `<section id="${sectionId(section)}" class="section">
        <div class="section-heading"><div><span class="eyebrow">SECTION</span><h2>${section}</h2></div><span class="count">${items.length}</span></div>
        <div class="grid">${items.map(postCard).join("")}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GitHub Copilot changelog digest</title>
  <script>
    (() => {
      const param = new URLSearchParams(window.location.search).get("scoutTheme");
      const theme =
        param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", theme);
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --cp-bg: #f7f4ef;
      --cp-bg-elevated: #fcfbf8;
      --cp-surface: #ffffff;
      --cp-surface-soft: #f5f5f5;
      --cp-border: #dedede;
      --cp-border-strong: #919191;
      --cp-text: #242424;
      --cp-text-muted: #5c5c5c;
      --cp-text-soft: #6f6f6f;
      --cp-accent: #b11f4b;
      --cp-accent-hover: #9a1a41;
      --cp-accent-soft: rgba(177, 31, 75, 0.08);
      --cp-accent-fg: #ffffff;
      --cp-success: #16a34a;
      --cp-danger: #dc2626;
      --cp-warning: #f59e0b;
      --cp-link: #0078d4;
      --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
      --cp-overlay: rgba(255, 255, 255, 0.8);
      --cp-panel: rgba(255, 255, 255, 0.86);
      --cp-panel-strong: rgba(255, 255, 255, 0.96);
      --cp-sheen: rgba(255, 255, 255, 0.55);
      --cp-highlight: rgba(177, 31, 75, 0.12);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --cp-bg: #3d3b3a;
      --cp-bg-elevated: #343231;
      --cp-surface: #292929;
      --cp-surface-soft: #2e2e2e;
      --cp-border: #474747;
      --cp-border-strong: #5f5f5f;
      --cp-text: #dedede;
      --cp-text-muted: #919191;
      --cp-text-soft: #b0b0b0;
      --cp-accent: #fd8ea1;
      --cp-accent-hover: #fb7b91;
      --cp-accent-soft: rgba(253, 142, 161, 0.14);
      --cp-accent-fg: #1a1a1a;
      --cp-success: #4ade80;
      --cp-danger: #f87171;
      --cp-warning: #fbbf24;
      --cp-link: #4da6ff;
      --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
      --cp-overlay: rgba(41, 41, 41, 0.88);
      --cp-panel: rgba(41, 41, 41, 0.72);
      --cp-panel-strong: rgba(41, 41, 41, 0.96);
      --cp-sheen: rgba(255, 255, 255, 0.04);
      --cp-highlight: rgba(253, 142, 161, 0.12);
    }
    *{box-sizing:border-box} html{scroll-behavior:smooth} body{margin:0;background:var(--cp-bg);color:var(--cp-text);font-family:"Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif}
    a{color:var(--cp-link)} .hero{padding:64px 24px 48px;background:var(--cp-bg-elevated);border-bottom:1px solid var(--cp-border)}
    .hero-inner,main{max-width:1180px;margin:auto}.brand{font-weight:700;color:var(--cp-accent);letter-spacing:.08em}.hero h1{font-size:clamp(2.5rem,7vw,5.5rem);line-height:.95;max-width:900px;margin:28px 0 24px;letter-spacing:-.055em}
    .hero p{font-size:1.15rem;color:var(--cp-text-muted);max-width:720px}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:32px}
    input{width:min(420px,100%);padding:13px 16px;border:1px solid var(--cp-border);border-radius:.625rem;background:var(--cp-surface);color:var(--cp-text);font:inherit}
    nav{display:flex;gap:8px;flex-wrap:wrap}nav a{padding:10px 14px;border:1px solid var(--cp-border);border-radius:.625rem;text-decoration:none;color:var(--cp-text);background:var(--cp-surface)}
    main{padding:24px}.section{padding:48px 0}.section-heading{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--cp-border-strong);padding-bottom:14px;margin-bottom:24px}
    .eyebrow{font-size:.72rem;letter-spacing:.16em;color:var(--cp-accent);font-weight:700}.section h2{font-size:2.5rem;margin:4px 0 0}.count{font-size:2rem;color:var(--cp-text-muted)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}.card{background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:16px;overflow:hidden;box-shadow:0 0 2px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.14)}
    .card-image,.image-placeholder{width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--cp-surface-soft)}.image-placeholder{display:grid;place-items:center;color:var(--cp-accent);font-size:1.5rem;font-weight:700;background:var(--cp-accent-soft)}
    .card-body{padding:24px}.meta{display:flex;gap:12px;justify-content:space-between;color:var(--cp-text-muted);font-size:.82rem}.card h3{font-size:1.5rem;line-height:1.15;margin:14px 0}.summary{font-size:1.02rem;line-height:1.6}
    .card h4{margin:24px 0 8px}.card ul{padding-left:20px;color:var(--cp-text-soft);line-height:1.5}.links{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.links a{font-size:.8rem;background:var(--cp-surface-soft);border:1px solid var(--cp-border);padding:6px 9px;border-radius:.625rem;text-decoration:none}
    .source{display:inline-block;font-weight:700;margin-top:8px}.hidden{display:none}footer{padding:32px 24px;border-top:1px solid var(--cp-border);color:var(--cp-text-muted);text-align:center}
    @media(max-width:600px){.hero{padding-top:40px}.section{padding:32px 0}.section h2{font-size:2rem}}
  </style>
</head>
<body>
  <header class="hero"><div class="hero-inner">
    <div class="brand">GITHUB COPILOT · CHANGELOG</div>
    <h1>What changed in Copilot?</h1>
    <p>An offline, AI-edited digest covering ${formatDate(from)} through ${formatDate(to)}. ${
      posts.length
    } ${posts.length === 1 ? "update" : "updates"} organized for quick reading.</p>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search updates..." aria-label="Search updates">
      <nav>${sections
        .filter((section) => posts.some((post) => post.section === section))
        .map((section) => `<a href="#${sectionId(section)}">${section}</a>`)
        .join("")}</nav>
    </div>
  </div></header>
  <main>${content}</main>
  <footer>Generated from the GitHub Changelog with GitHub Copilot SDK.</footer>
  <script>
    const search = document.querySelector("#search");
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      document.querySelectorAll(".card").forEach(card => card.classList.toggle("hidden", !card.dataset.search.includes(query)));
      document.querySelectorAll(".section").forEach(section => section.classList.toggle("hidden", !section.querySelector(".card:not(.hidden)")));
    });
  </script>
</body>
</html>`;
}

export async function writeWebsite(
  posts: EnrichedPost[],
  outputDirectory: string,
  from: Date,
  to: Date,
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, `${outputFileStem(from, to)}.html`);
  await writeFile(path, renderWebsite(posts, from, to), "utf8");
  return path;
}
