import type { MessageBlock } from './contracts.js';
import { record } from './transcript.js';

type ToolSource = Pick<Extract<MessageBlock, { kind: 'tool' }>, 'name' | 'output' | 'status'>;
type LanguageForPath = (path: string) => string | undefined;
export interface SourceMatch { n: number; text: string; mark: boolean }
export type ToolSourcePart =
  | { kind: 'read'; text: string; lang: string }
  | { kind: 'matches'; path: string; lang: string; lines: SourceMatch[] }
  | { kind: 'plain'; lines: string[] };

/** Display metadata only: inspect Pi's actual output, never open files for a preview. */
export function toolSourceParts(tool: ToolSource, args: unknown, languageForPath: LanguageForPath): ToolSourcePart[] | undefined {
  if (tool.status === 'error' || !tool.output) return undefined;
  const input = record(args);
  if (tool.name === 'read') {
    const path = typeof input.path === 'string' ? input.path : undefined;
    const lang = path ? languageForPath(path) : undefined;
    return lang ? [{ kind: 'read', text: tool.output, lang }] : undefined;
  }
  if (tool.name !== 'grep') return undefined;
  const location = /([:-])([1-9]\d*)\1 /g;
  const parts: ToolSourcePart[] = [];
  let hasSource = false;
  for (const line of tool.output.split('\n')) {
    let source: { path: string; lang: string; line: SourceMatch } | undefined;
    location.lastIndex = 0;
    for (let match = location.exec(line); match; match = location.exec(line)) {
      const path = line.slice(0, match.index);
      const lang = languageForPath(path);
      if (!lang) continue;
      const n = Number(match[2]);
      if (Number.isSafeInteger(n)) source = { path, lang, line: { n, text: line.slice(match.index + match[0].length), mark: match[1] === ':' } };
      break;
    }
    const previous = parts.at(-1);
    if (source) {
      hasSource = true;
      if (previous?.kind === 'matches' && previous.path === source.path && previous.lines.at(-1)!.n < source.line.n) {
        previous.lines.push(source.line);
      } else parts.push({ kind: 'matches', path: source.path, lang: source.lang, lines: [source.line] });
    } else if (previous?.kind === 'plain') previous.lines.push(line);
    else parts.push({ kind: 'plain', lines: [line] });
  }
  return hasSource ? parts : undefined;
}
