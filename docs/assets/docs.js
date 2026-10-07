(() => {
  const themeButton = document.querySelector("#theme-toggle");
  const mediaTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const currentTheme = () => document.documentElement.dataset.theme ?? (mediaTheme.matches ? "dark" : "light");
  const updateThemeButton = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    themeButton.textContent = `${next === "dark" ? "Dark" : "Light"} mode`;
    themeButton.setAttribute("aria-label", `Switch to ${next} mode`);
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.content = currentTheme() === "dark" ? "#111017" : "#faf9fc";
    }
  };
  themeButton.hidden = false;
  updateThemeButton();
  mediaTheme.addEventListener("change", updateThemeButton);
  themeButton.addEventListener("click", () => {
    const theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    const url = new URL(location.href);
    if (url.searchParams.has("scoutTheme")) {
      url.searchParams.set("scoutTheme", theme);
      history.replaceState(null, "", url);
    }
    try { localStorage.setItem("copilot-docs-theme", theme); }
    catch (error) { console.warn("Theme changed for this visit, but the preference could not be saved.", error); }
    updateThemeButton();
  });

  const mobile = window.matchMedia("(max-width: 760px)");
  const contents = document.querySelector("#contents");
  contents.open = !mobile.matches;
  mobile.addEventListener("change", () => { contents.open = !mobile.matches; });
  const nav = document.querySelector("#docs-nav");
  const search = document.querySelector("#docs-search");
  const results = document.querySelector("#search-results");
  const status = document.querySelector("#search-status");
  const sections = [...document.querySelectorAll(".doc-section[id]")];
  const index = sections.map((section) => ({
    id: section.id,
    title: document.getElementById(section.getAttribute("aria-labelledby")).textContent.trim(),
    text: section.textContent.replace(/\s+/g, " ").trim(),
  }));
  document.querySelector("#search-box").hidden = false;
  const updateSearch = () => {
    const query = search.value.trim().toLowerCase();
    results.replaceChildren();
    results.hidden = !query;
    nav.hidden = Boolean(query);
    status.textContent = "";
    if (!query) return;
    const matches = index.filter((entry) => query.split(/\s+/).every((word) => entry.text.toLowerCase().includes(word)));
    status.textContent = matches.length
      ? `${matches.length} ${matches.length === 1 ? "section matches" : "sections match"}.`
      : "No matching sections. Try “resume”, “model”, or “Pages”.";
    for (const entry of matches) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${entry.id}`;
      link.textContent = entry.title;
      const snippet = document.createElement("span");
      const position = entry.text.toLowerCase().indexOf(query.split(/\s+/)[0]);
      const start = Math.max(0, position - 30);
      snippet.textContent = `${start ? "…" : ""}${entry.text.slice(start, start + 120)}…`;
      link.append(snippet);
      item.append(link);
      results.append(item);
    }
  };
  search.addEventListener("input", updateSearch);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      updateSearch();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      results.querySelector("a")?.click();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey ||
        event.target.closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    contents.open = true;
    search.focus();
  });
  const navLinks = [...nav.querySelectorAll('a[href^="#"]')];
  const markActive = (id) => {
    for (const link of navLinks) {
      if (link.hash === `#${id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  const hashTarget = (hash) => {
    try {
      return document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      console.warn("The documentation link contains an invalid fragment; showing the overview.", error);
      return null;
    }
  };
  const showTarget = (target) => {
    const section = target?.closest(".doc-section") ??
      (target?.id === "main" ? sections.find((entry) => !entry.hidden) : null) ??
      sections[0];
    for (const entry of sections) entry.hidden = entry !== section;
    markActive(section.id);
    const label = navLinks.find((link) => link.hash === `#${section.id}`).textContent.trim();
    document.title = `${label} · Copilot Changelog CLI`;
    return target ?? section;
  };
  const focusTarget = (target) => {
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  };
  document.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href^="#"]');
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
    const target = hashTarget(link.hash);
    if (!target) return;
    showTarget(target);
    if (mobile.matches) contents.open = false;
    focusTarget(target);
  });
  window.addEventListener("hashchange", () => {
    const target = showTarget(hashTarget(location.hash));
    focusTarget(target);
    target.scrollIntoView({ behavior: "instant", block: "start" });
  });
  const initialTarget = showTarget(hashTarget(location.hash));
  if (location.hash) {
    requestAnimationFrame(() => initialTarget.scrollIntoView({ behavior: "instant", block: "start" }));
  }

  const copyStatus = document.querySelector("#copy-status");
  let messageTimer;
  const announce = (message) => {
    clearTimeout(messageTimer);
    copyStatus.textContent = message;
    messageTimer = setTimeout(() => { copyStatus.textContent = ""; }, 5000);
  };
  for (const block of document.querySelectorAll(".code-block")) {
    const code = block.querySelector("code");
    const pre = block.querySelector("pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", block.querySelector(".code-heading span").textContent);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", `Copy ${block.querySelector(".code-heading span").textContent.toLowerCase()}`);
    button.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable.");
        await navigator.clipboard.writeText(code.textContent);
        announce("Copied to clipboard.");
      } catch (error) {
        console.warn("Clipboard access failed; select the command to copy it manually.", error);
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        pre.focus();
        announce("Clipboard unavailable. Text selected; copy it manually.");
      }
    });
    block.querySelector(".code-heading").append(button);
  }
})();
