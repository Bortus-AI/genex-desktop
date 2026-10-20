import { t } from "./i18n.ts";

/** Plain names for the harness's instruction files, for people who never read them; functions, as main loads this before its language. */
const SKILLS: Record<string, () => string> = {
  "facet-decomposition": () => t("how Harness plans a build"),
  director: () => t("how Harness leads a build"),
};

export function skillWords(skill: string | undefined): string {
  const slug = (skill ?? "").replace(/^skills\//, "").replace(/\.md$/, "");
  const named = Object.hasOwn(SKILLS, slug) ? SKILLS[slug] : undefined;
  if (named) return named();
  return slug
    ? t("Harness's {skill} instructions", { skill: slug.replace(/[-_]+/g, " ") })
    : t("Harness's instructions");
}

/** A proposal's own plain title when the proposer wrote one; older proposals name what they change. */
export function proposalTitle(proposal: { title?: string; skill?: string }): string {
  return proposal.title?.trim() || t("Change {skill}", { skill: skillWords(proposal.skill) });
}

export function changeTitle(change: { title?: string; skill?: string; file?: string }): string {
  return change.title?.trim() || t("Changed {skill}", { skill: skillWords(change.skill || change.file) });
}

/**
 * "3 games": an English count and noun. Kept for callers not yet translated; a translated
 * sentence writes its count as an ICU plural inside `t()` instead, since languages inflect nouns
 * by number differently.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
