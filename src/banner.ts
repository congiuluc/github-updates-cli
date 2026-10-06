const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  white: "\u001B[38;2;242;245;243m",
  green: "\u001B[38;2;15;191;62m",
  purple: "\u001B[38;2;133;52;243m",
  muted: "\u001B[38;2;140;149;143m",
};

function paint(value: string, style: string, enabled: boolean): string {
  return enabled ? `${style}${value}${ansi.reset}` : value;
}

function visibleLength(value: string): number {
  return value.replace(/\u001B\[[0-9;]*m/g, "").length;
}

function fillLine(parts: string[], width: number, color: boolean): string {
  const content = parts.join("");
  const padding = Math.max(0, width - 4 - visibleLength(content));
  return `${paint("│", ansi.muted, color)}  ${content}${" ".repeat(padding)}${paint("│", ansi.muted, color)}`;
}

export function renderStartupBanner(version: string, color = true, columns = 80): string {
  if (columns < 62) {
    return [
      `${paint("◆", ansi.purple, color)} ${paint("GitHub Copilot", ansi.bold, color)}`,
      `${paint("CHANGELOG CLI", ansi.green + ansi.bold, color)} ${paint(`v${version}`, ansi.muted, color)}`,
    ].join("\n");
  }

  const width = 60;
  const top =
    paint("╭─", ansi.muted, color) +
    paint(" ◆ ", ansi.purple, color) +
    paint("GitHub Copilot ", ansi.bold, color) +
    paint("─".repeat(width - 21) + "╮", ansi.muted, color);
  const bottom = paint(`╰${"─".repeat(width - 2)}╯`, ansi.muted, color);
  const versionPill = color
    ? `${ansi.purple}${ansi.bold} v${version} ${ansi.reset}`
    : `[v${version}]`;
  const readyPill = color
    ? `${ansi.green}${ansi.bold} ● ready ${ansi.reset}`
    : "[ready]";

  return [
    top,
    fillLine([], width, color),
    fillLine(
      [
        paint("CHANGE", ansi.white + ansi.bold, color),
        paint("LOG", ansi.green + ansi.bold, color),
      ],
      width,
      color,
    ),
    fillLine(
      [paint("Turn product updates into presentation-ready stories.", ansi.muted, color)],
      width,
      color,
    ),
    fillLine([], width, color),
    fillLine([versionPill, "  ", readyPill, "  ", paint("AI-powered briefings", ansi.dim, color)], width, color),
    fillLine([], width, color),
    bottom,
  ].join("\n");
}
