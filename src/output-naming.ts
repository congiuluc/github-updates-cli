function datePart(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function outputFileStem(from: Date, to: Date): string {
  return `copilot-changelog-${datePart(from)}-to-${datePart(to)}`;
}
