import { isRecord, readJson, writeJson } from "./storage.js";
import type { DateRange } from "./types.js";

export interface IncrementalState {
  version: 1;
  identity: string;
  deliveredUrls: string[];
  through?: string;
  nextFrom?: string;
  /** Freeze the window before processing so retries cannot advance past omitted work. */
  pending?: { from: string; to: string };
}

const isDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export async function loadIncrementalState(path: string, identity: string): Promise<IncrementalState> {
  const value = await readJson(path);
  if (value === undefined) return { version: 1, identity, deliveredUrls: [] };
  if (!isRecord(value) || value.version !== 1 || value.identity !== identity ||
    !Array.isArray(value.deliveredUrls) || !value.deliveredUrls.every((url) => typeof url === "string") ||
    (value.through !== undefined && !isDate(value.through)) ||
    (value.nextFrom !== undefined && !isDate(value.nextFrom)) ||
    (value.pending !== undefined && (!isRecord(value.pending) || !isDate(value.pending.from) ||
      !isDate(value.pending.to) || Date.parse(value.pending.from) > Date.parse(value.pending.to)))) {
    throw new Error(`Invalid incremental state ${path}. Preserve it for diagnosis; use a different --state-dir to start a separate history.`);
  }
  return {
    version: 1, identity, deliveredUrls: value.deliveredUrls,
    ...(isDate(value.through) ? { through: value.through } : {}),
    ...(isDate(value.nextFrom) ? { nextFrom: value.nextFrom } : {}),
    ...(isRecord(value.pending) && isDate(value.pending.from) && isDate(value.pending.to)
      ? { pending: { from: value.pending.from, to: value.pending.to } } : {}),
  };
}

/** Pending windows win over new dates; fresh windows never extend into the future. */
export function incrementalRange(requested: DateRange, state: IncrementalState, now = new Date()): DateRange | undefined {
  if (state.pending) return { from: new Date(state.pending.from), to: new Date(state.pending.to) };
  const from = new Date(state.nextFrom ?? state.through ?? requested.from);
  if (!state.nextFrom && state.through) from.setUTCHours(0, 0, 0, 0);
  const to = new Date(Math.min(requested.to.getTime(), now.getTime()));
  return from <= to ? { from, to } : undefined;
}

export async function beginIncremental(path: string, state: IncrementalState, range: DateRange): Promise<void> {
  state.pending = { from: range.from.toISOString(), to: range.to.toISOString() };
  await writeJson(path, state);
}

/**
 * Advance history only after all selected articles and requested exports succeed.
 * limitedDates keeps backlog excluded by --limit eligible in the next window.
 */
export async function completeIncremental(
  path: string, state: IncrementalState, range: DateRange, canonicalUrls: string[], limitedDates: string[],
): Promise<void> {
  const next = new Date(range.to);
  next.setUTCHours(0, 0, 0, 0);
  for (const date of limitedDates) {
    if (Date.parse(date) < next.getTime()) next.setTime(Date.parse(date));
  }
  // Overlap the final day because the changelog archive supplies dates, not precise publication times.
  next.setUTCHours(0, 0, 0, 0);
  const completed: IncrementalState = {
    version: 1, identity: state.identity,
    deliveredUrls: [...new Set([...state.deliveredUrls, ...canonicalUrls])],
    through: range.to.toISOString(), nextFrom: next.toISOString(),
  };
  await writeJson(path, completed);
  Object.assign(state, completed);
  delete state.pending;
}
