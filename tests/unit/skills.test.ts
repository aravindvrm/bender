import { describe, expect, it } from "vitest";
import {
  buildProjectContextQuery,
  scoreSkill,
  selectSkillsByKeyword,
  type SkillMeta,
} from "../../src/state/skills.js";

describe("state/skills keyword matching", () => {
  const skills: SkillMeta[] = [
    {
      name: "security-best-practices",
      description: "Review common secure coding defaults and remediation options.",
      size: 1200,
    },
    {
      name: "vercel-deploy",
      description: "Deploy and validate services on Vercel with environment checks.",
      size: 1800,
    },
    {
      name: "playwright-interactive",
      description: "Interactive browser testing and end-to-end verification flows.",
      size: 9000,
    },
  ];

  it("scores stronger matches higher", () => {
    const securityScore = scoreSkill(
      skills[0],
      "run a security review and secure coding pass",
    );
    const deployScore = scoreSkill(
      skills[1],
      "run a security review and secure coding pass",
    );

    expect(securityScore).toBeGreaterThan(deployScore);
  });

  it("returns highest-ranked skills for a query", () => {
    const selected = selectSkillsByKeyword(
      skills,
      "deploy to vercel and verify deployment logs",
      2,
    );
    expect(selected[0]).toBe("vercel-deploy");
    expect(selected).toHaveLength(1);
  });

  it("builds lower-cased project context query from config + architecture", () => {
    const query = buildProjectContextQuery(
      {
        stack: { framework: "Next.js", database: "Postgres" },
        deploy: { target: "Vercel" },
        test: { command: "playwright test" },
      },
      "This system uses Figma design handoff and Vercel preview deployments.",
    );

    expect(query).toContain("next.js");
    expect(query).toContain("postgres");
    expect(query).toContain("vercel");
    expect(query).toContain("playwright test");
    expect(query).toContain("figma");
    expect(query).toBe(query.toLowerCase());
  });
});

