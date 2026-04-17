import { describe, expect, it } from "vitest";
import {
  isFlowchartChart,
  looksLikeMermaidErrorSvg,
  normalizeMermaidChartInput,
  repairMermaidChart,
} from "../../src/web/src/utils/mermaid.js";

describe("mermaid utils", () => {
  it("normalizes fenced mermaid input", () => {
    const raw = "```mermaid\r\nflowchart TD\r\nA[Start]\r\n```";
    expect(normalizeMermaidChartInput(raw)).toBe("flowchart TD\nA[Start]");
  });

  it("detects flowchart charts", () => {
    expect(isFlowchartChart("flowchart TD\nA[Start]")).toBe(true);
    expect(isFlowchartChart("graph LR\nA --> B")).toBe(true);
    expect(isFlowchartChart("erDiagram\nA ||--o{ B : has")).toBe(false);
  });

  it("quotes flowchart labels with punctuation and spaces", () => {
    const source = [
      "flowchart TD",
      "A[Start] --> B[Choose File(s) to Upload]",
      "B --> C{User logged in?}",
    ].join("\n");

    const repaired = repairMermaidChart(source);
    expect(repaired).toContain("B[\"Choose File(s) to Upload\"]");
    expect(repaired).toContain("C{\"User logged in?\"}");
  });

  it("repairs escaped inner quotes in already-quoted labels", () => {
    const source = [
      "flowchart TD",
      "A[\"Upload Business Card Link or \\\"Send\\\" Button\"] --> B[\"Share Card\"]",
    ].join("\n");

    const repaired = repairMermaidChart(source);
    expect(repaired).toContain("A[\"Upload Business Card Link or 'Send' Button\"]");
    expect(repaired).toContain("--> B[\"Share Card\"]");
  });

  it("repairs inner quotes inside unquoted labels", () => {
    const source = [
      "flowchart TD",
      "A[Sender: Copy Card Link or \"Send\" Button] --> B[Share Link via Any Channel]",
    ].join("\n");

    const repaired = repairMermaidChart(source);
    expect(repaired).toContain("A[\"Sender: Copy Card Link or 'Send' Button\"]");
    expect(repaired).toContain("--> B[\"Share Link via Any Channel\"]");
    expect(repaired).not.toContain('\\"Send\\"');
  });

  it("splits adjacent node declarations into separate lines", () => {
    const source = [
      "flowchart TD",
      "A[Alpha] B[Beta]",
    ].join("\n");

    const repaired = repairMermaidChart(source);
    expect(repaired).toContain("A[Alpha]\nB[Beta]");
  });

  it("leaves non-flowchart content untouched", () => {
    const source = [
      "erDiagram",
      "USERS ||--o{ TASKS : owns",
    ].join("\n");
    expect(repairMermaidChart(source)).toBe(source);
  });

  it("detects mermaid error SVG payloads", () => {
    expect(looksLikeMermaidErrorSvg("<svg><text>Syntax error in text</text><text>mermaid version 11.14.0</text></svg>")).toBe(true);
    expect(looksLikeMermaidErrorSvg("<svg><text>Parse error on line 2</text></svg>")).toBe(true);
    expect(looksLikeMermaidErrorSvg("<svg><text>Valid diagram</text></svg>")).toBe(false);
  });
});
