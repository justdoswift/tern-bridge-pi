/** Public-format synthetic data only; no installed skill files are read. */
export const SYNTHETIC_SKILL_BODY = 'References are relative to /synthetic/skills/review.\n\n# Synthetic review\n\nSYNTHETIC_SKILL_BODY_SENTINEL\nReview only the supplied synthetic example.\nDo not call any provider.';
export function skillFixture(args = ''): string {
  const wrapper = `<skill name="review" location="/synthetic/skills/review/SKILL.md">\n${SYNTHETIC_SKILL_BODY}\n</skill>`;
  return args ? `${wrapper}\n\n${args}` : wrapper;
}
