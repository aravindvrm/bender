const FLOWCHART_HEADER_RE = /^(?:flowchart|graph)\b/i;
const FENCED_MERMAID_RE = /^\s*```(?:\s*mermaid)?\s*\n([\s\S]*?)\n?```\s*$/i;
const FLOW_NODE_ID = String.raw`[A-Za-z_][A-Za-z0-9_-]*`;
const SQUARE_NODE_RE = new RegExp(String.raw`\b(${FLOW_NODE_ID})\[([^\[\]\n]+)\]`, "g");
const DECISION_NODE_RE = new RegExp(String.raw`\b(${FLOW_NODE_ID})\{([^\{\}\n]+)\}`, "g");
const ADJACENT_NODE_BREAK_RE = new RegExp(
  String.raw`([\]\}\)])\s+(${FLOW_NODE_ID}\s*[\[\{\(])`,
  "g",
);

function firstMeaningfulLine(text: string): string {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    return trimmed;
  }
  return "";
}

function escapeFlowLabel(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isWrappedInQuotes(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  return (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"));
}

function shouldQuoteLabel(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  if (isWrappedInQuotes(trimmed)) {
    return false;
  }
  return /[^\w]/.test(trimmed);
}

function sanitizeFlowLabel(raw: string): string {
  const unwrapped = isWrappedInQuotes(raw) ? raw.trim().slice(1, -1) : raw.trim();
  return unwrapped
    .replace(/\\"/g, "'")
    .replace(/\\'/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/"/g, "'")
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteSquareAndDecisionLabels(line: string): string {
  const withSquareQuoted = line.replace(SQUARE_NODE_RE, (full, id: string, label: string) => {
    const sanitized = sanitizeFlowLabel(label);
    const preserveQuoted = isWrappedInQuotes(label) || /["\\]/.test(label);
    if (!preserveQuoted && !shouldQuoteLabel(sanitized)) return `${id}[${sanitized}]`;
    return `${id}["${escapeFlowLabel(sanitized)}"]`;
  });
  return withSquareQuoted.replace(DECISION_NODE_RE, (full, id: string, label: string) => {
    const sanitized = sanitizeFlowLabel(label);
    const preserveQuoted = isWrappedInQuotes(label) || /["\\]/.test(label);
    if (!preserveQuoted && !shouldQuoteLabel(sanitized)) return `${id}{${sanitized}}`;
    return `${id}{"${escapeFlowLabel(sanitized)}"}`;
  });
}

export function normalizeMermaidChartInput(input: string): string {
  const normalized = input.replace(/\r\n?/g, "\n").trim();
  const fenced = normalized.match(FENCED_MERMAID_RE);
  return (fenced?.[1] ?? normalized).trim();
}

export function looksLikeMermaidErrorSvg(svg: string): boolean {
  if (!svg) return false;
  // Match actual Mermaid error messages embedded in the SVG <text> elements.
  // Deliberately excludes "mermaid version" which appears in valid SVG metadata
  // emitted by Mermaid v10+ (e.g. <!-- Mermaid version 10.x.x -->).
  return /syntax error in (?:text|graph)|parse error on line|Lexical error on line/i.test(svg);
}

export function isFlowchartChart(input: string): boolean {
  const normalized = normalizeMermaidChartInput(input);
  return FLOWCHART_HEADER_RE.test(firstMeaningfulLine(normalized));
}

export function repairMermaidChart(input: string): string {
  const normalized = normalizeMermaidChartInput(input);
  if (!normalized) return normalized;
  if (!isFlowchartChart(normalized)) return normalized;

  const lines = normalized.split("\n");
  const transformedLines = lines.map((line) => quoteSquareAndDecisionLabels(line));
  return transformedLines
    .join("\n")
    .replace(ADJACENT_NODE_BREAK_RE, (_full, tail: string, next: string) => `${tail}\n${next}`)
    .trim();
}
