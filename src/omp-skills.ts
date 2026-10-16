import type { SkillMessageComponent } from '@oh-my-pi/pi-tui/chat/skill-message';

type SkillView = ConstructorParameters<typeof SkillMessageComponent>[0];

/** Display-only adapter for Pi's _expandSkillCommand/parseSkillBlock wire format.
 * Keep the complete authoritative text in content; never replace a backend message.
 */
export function piSkillView(text: string): SkillView | undefined {
  if (!text.startsWith('<skill name="')) return;
  const match = /^<skill name="([^"\r\n]+)" location="([^"\r\n]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  // Unlike a generic XML/code sample, Pi's generated body always starts with this
  // reference preamble. Partial, prefixed and malformed wrappers remain user prose.
  if (!match || match[0] !== text || !/^References are relative to [^\r\n]+\.\n\n/.test(match[3]!)) return;
  const args = match[4]?.trim() || undefined;
  return {
    role: 'custom', customType: 'skill-prompt', display: true, attribution: 'user', timestamp: 0,
    content: text,
    details: { name: match[1]!, path: match[2]!, args, lineCount: match[3]!.split('\n').length },
  };
}
