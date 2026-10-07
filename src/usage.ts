import type { SessionEventHandler } from "@github/copilot-sdk";

export interface AiUsage {
  requests: number;
  unreportedRequests: number;
  usageEvents: number;
  creditReports: number;
  totalNanoAiu: number;
  inputTokens: number;
  outputTokens: number;
  historyIncomplete: boolean;
}

export interface UsageSession {
  on?(handler: SessionEventHandler): () => void;
}

const counters = [
  "requests", "unreportedRequests", "usageEvents", "creditReports",
  "totalNanoAiu", "inputTokens", "outputTokens",
] as const;

export function emptyAiUsage(): AiUsage {
  return {
    requests: 0, unreportedRequests: 0, usageEvents: 0, creditReports: 0,
    totalNanoAiu: 0, inputTokens: 0, outputTokens: 0, historyIncomplete: false,
  };
}

export function isAiUsage(value: unknown): value is AiUsage {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return counters.every((key) => typeof data[key] === "number" &&
    Number.isSafeInteger(data[key]) && data[key] >= 0) &&
    typeof data.historyIncomplete === "boolean" &&
    Number(data.unreportedRequests) <= Number(data.requests) &&
    Number(data.creditReports) <= Number(data.usageEvents);
}

export function addAiUsage(previous: AiUsage, current: AiUsage): AiUsage {
  const result = { ...previous, historyIncomplete: previous.historyIncomplete || current.historyIncomplete };
  for (const key of counters) result[key] += current[key];
  if (!isAiUsage(result)) throw new Error("Invalid Copilot usage totals.");
  return result;
}

export function formatAiUsage(usage: AiUsage): string {
  const incomplete = usage.historyIncomplete || usage.unreportedRequests > 0 ||
    usage.creditReports < usage.usageEvents;
  if (usage.creditReports === 0 && (usage.requests > 0 || incomplete)) {
    return "AI credits: unavailable (the runtime or an earlier run did not report credit usage).";
  }
  const credits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 9 }).format(usage.totalNanoAiu / 1e9);
  return `AI credits: ${incomplete ? "at least " : ""}${credits} (reported${incomplete ? "; incomplete usage data" : ""}).`;
}

export function createUsageTracker(onUsage?: (usage: AiUsage) => Promise<void>) {
  let totals = emptyAiUsage();
  let pending = Promise.resolve();
  let failure: { error: unknown } | undefined;

  const record = (delta: AiUsage) => {
    totals = addAiUsage(totals, delta);
    const snapshot = { ...totals };
    // SDK event callbacks are synchronous; persist in order and surface failures at flush.
    pending = pending.then(async () => {
      if (failure) return;
      try {
        await onUsage?.(snapshot);
      } catch (error) {
        failure = { error };
      }
    });
  };
  const flush = async () => {
    await pending;
    if (failure) throw new Error(
      `Could not record Copilot usage: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      { cause: failure.error },
    );
  };
  return {
    flush,
    watch(session: UsageSession) {
      const seen = new Set<string>();
      let requestReported = true;
      const unsubscribe = session.on?.((event) => {
        if (event.type !== "assistant.usage") return;
        if (seen.has(event.id)) return;
        seen.add(event.id);
        try {
          const nanoAiu = event.data.copilotUsage?.totalNanoAiu;
          const delta = {
            ...emptyAiUsage(),
            usageEvents: 1,
            creditReports: nanoAiu === undefined ? 0 : 1,
            totalNanoAiu: nanoAiu ?? 0,
            inputTokens: event.data.inputTokens ?? 0,
            outputTokens: event.data.outputTokens ?? 0,
          };
          if (!isAiUsage(delta)) throw new Error("Invalid Copilot usage event.");
          if (nanoAiu !== undefined && !requestReported) {
            delta.unreportedRequests = -1;
            requestReported = true;
          }
          record(delta);
        } catch (error) {
          failure ??= { error };
        }
      });
      return {
        async startRequest() {
          if (failure) await flush();
          requestReported = false;
          record({ ...emptyAiUsage(), requests: 1, unreportedRequests: 1 });
          await flush();
        },
        markInterrupted() {
          record({ ...emptyAiUsage(), historyIncomplete: true });
        },
        dispose() { unsubscribe?.(); },
      };
    },
  };
}
