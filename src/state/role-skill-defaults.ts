type RoleName = "analyzer" | "architect" | "planner" | "implementer" | "reviewer";

function uniq(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

const ROLE_DEFAULT_PINNED_SKILLS: Record<RoleName, string[]> = {
  analyzer: uniq([
    "security-best-practices",
    "security-threat-model",
    "doc",
    "openai-docs",
  ]),
  architect: uniq([
    "security-best-practices",
    "doc",
    "playwright",
    "sentry",
  ]),
  planner: uniq([
    "doc",
    "openai-docs",
    "notion-spec-to-implementation",
  ]),
  implementer: uniq([
    "gh-fix-ci",
    "gh-address-comments",
    "yeet",
  ]),
  reviewer: uniq([
    "security-best-practices",
    "security-ownership-map",
    "gh-fix-ci",
    "sentry",
  ]),
};

const ROLE_RUNTIME_BASELINE_SKILLS: Record<RoleName, string[]> = {
  analyzer: uniq([
    ...ROLE_DEFAULT_PINNED_SKILLS.analyzer,
    "security-ownership-map",
    "sentry",
    "playwright",
  ]),
  architect: uniq([
    ...ROLE_DEFAULT_PINNED_SKILLS.architect,
    "figma-use",
    "frontend-skill",
    "vercel-deploy",
    "render-deploy",
  ]),
  planner: uniq([
    ...ROLE_DEFAULT_PINNED_SKILLS.planner,
    "notion-research-documentation",
    "frontend-skill",
    "figma-use",
  ]),
  implementer: uniq([
    ...ROLE_DEFAULT_PINNED_SKILLS.implementer,
    "playwright",
    "sentry",
    "vercel-deploy",
    "render-deploy",
    "frontend-skill",
  ]),
  reviewer: uniq([
    ...ROLE_DEFAULT_PINNED_SKILLS.reviewer,
    "gh-address-comments",
    "playwright",
  ]),
};

export function getRoleDefaultPinnedSkills(role: RoleName): string[] {
  return [...(ROLE_DEFAULT_PINNED_SKILLS[role] ?? [])];
}

export function getRoleRuntimeBaselineSkills(role: RoleName): string[] {
  return [...(ROLE_RUNTIME_BASELINE_SKILLS[role] ?? [])];
}

