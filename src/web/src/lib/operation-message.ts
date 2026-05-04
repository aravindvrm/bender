/**
 * Operation messages — assistant chat messages that carry the full event log
 * of a deterministic backend operation (e.g. /analyze, /audit security).
 *
 * Persisted via the existing chat message endpoint. The LLM sees only the
 * `text` part summary on subsequent turns; the UI uses metadata.bender to
 * render an interactive collapsible OperationBlock with approval gates.
 */
import type { UIMessage } from "ai";
import type { OutputLine } from "../hooks/useOperation";
import type { OperationStatus, OperationSummary } from "../components/OperationBlock";
import { computeCounts } from "../components/OperationBlock";

export interface BenderOperationMetadata {
  kind: "operation";
  label: string;
  url?: string;
  status: OperationStatus;
  startedAt: number;
  finishedAt?: number;
  events: OutputLine[];
  counts?: OperationSummary["counts"];
}

interface MessageMetadataBag {
  bender?: BenderOperationMetadata;
  [key: string]: unknown;
}

/** Type guard — does this UIMessage carry operation metadata? */
export function isOperationMessage(message: UIMessage): boolean {
  const meta = (message.metadata ?? {}) as MessageMetadataBag;
  return meta.bender?.kind === "operation";
}

/** Extract the OperationSummary from an operation UIMessage (or null). */
export function getOperationSummary(message: UIMessage): OperationSummary | null {
  const meta = (message.metadata ?? {}) as MessageMetadataBag;
  const bender = meta.bender;
  if (!bender || bender.kind !== "operation") return null;
  return {
    label: bender.label,
    url: bender.url,
    status: bender.status,
    startedAt: bender.startedAt,
    finishedAt: bender.finishedAt,
    events: bender.events,
    counts: bender.counts,
  };
}

/** Build a synthetic assistant UIMessage representing a completed operation. */
export function buildOperationMessage(input: {
  id: string;
  label: string;
  url?: string;
  status: OperationStatus;
  startedAt: number;
  finishedAt?: number;
  events: OutputLine[];
}): UIMessage {
  const counts = computeCounts(input.events);
  const summaryText = buildSummaryText(input.label, input.status, counts);

  const metadata: MessageMetadataBag = {
    bender: {
      kind: "operation",
      label: input.label,
      url: input.url,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      events: input.events,
      counts,
    },
  };

  return {
    id: input.id,
    role: "assistant",
    parts: [{ type: "text", text: summaryText }],
    metadata,
  } as UIMessage;
}

function buildSummaryText(
  label: string,
  status: OperationStatus,
  counts: OperationSummary["counts"],
): string {
  const verb = status === "done" ? "completed" : status === "error" ? "failed" : status;
  const bits: string[] = [`Operation \`${label}\` ${verb}.`];
  if (counts?.spinners) bits.push(`Steps: ${counts.spinners}.`);
  if (counts?.filesChanged) bits.push(`Files changed: ${counts.filesChanged}.`);
  if (counts?.errors) bits.push(`Errors: ${counts.errors}.`);
  return bits.join(" ");
}

/** POST a finished operation message to the chat thread for persistence. */
export async function persistOperationMessage(
  threadId: string,
  message: UIMessage,
): Promise<void> {
  await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  }).catch(() => {});
}
