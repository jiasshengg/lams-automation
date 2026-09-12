import { readFile } from 'node:fs/promises';
import type { IratRequest } from '../config.js';
import { resolveInputFile } from '../input-file.js';
import { readZipEntries, requireZipEntry } from './archive.js';
import { createQuestionTracker, decodeXml } from './media.js';

/** One DOCX text run with the direct character formatting LAMS can reproduce. */
export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  vertical: 'sub' | 'sup' | null;
}

export interface StyledParagraph {
  questionNumber: number | null;
  runs: StyledRun[];
}

export interface SotFormattingResult {
  /** Fields whose inline formatting now comes from the SoT, as "Question 1 content". */
  applied: string[];
  /** Fields whose text was not found in the SoT, so the request's own formatting stayed. */
  warnings: string[];
}

const PLAIN: Omit<StyledRun, 'text'> = { bold: false, italic: false, underline: false, vertical: null };
/** Mark annotations such as "(mark 1)" or "[2 marks]" are SoT metadata, never question text. */
const MARK_ANNOTATION = /\(\s*(?:mark\s*\d+|\d+\s*marks?)\s*\)|\[\s*\d+\s*marks?\s*\]/gi;

/**
 * Reads every paragraph's runs with their direct run properties. Style-sheet formatting
 * (paragraph or character styles) is intentionally ignored: only explicit bold, italic,
 * underline, and sub/superscript marks in the document are treated as SoT formatting.
 */
export function extractStyledParagraphs(documentXml: string): StyledParagraph[] {
  const questionFor = createQuestionTracker();
  const paragraphs: StyledParagraph[] = [];
  for (const paragraph of documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const runs: StyledRun[] = [];
    for (const run of (paragraph[1] ?? '').matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      const xml = run[1] ?? '';
      const properties = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(xml)?.[1] ?? '';
      const style = {
        bold: toggleOn(properties, 'b'),
        italic: toggleOn(properties, 'i'),
        underline: /<w:u\b(?![^>]*w:val="none")[^>]*\/?>/.test(properties),
        vertical: /<w:vertAlign\b[^>]*w:val="subscript"/.test(properties)
          ? 'sub' as const
          : /<w:vertAlign\b[^>]*w:val="superscript"/.test(properties) ? 'sup' as const : null
      };
      for (const piece of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)) {
        runs.push({ text: piece[1] !== undefined ? decodeXml(piece[1]) : ' ', ...style });
      }
    }
    const text = runs.map((run) => run.text).join('').replace(/\s+/g, ' ').trim();
    paragraphs.push({ questionNumber: questionFor(text), runs });
  }
  return paragraphs;
}

/**
 * Rewrites every question's content, answers, and feedback so their inline formatting is
 * exactly what the SoT shows for the same words. The reviewed request text stays the
 * source of the words; the DOCX becomes the source of italics, bold, underline, and
 * sub/superscript. Text that cannot be found in the SoT keeps the request's own tags and
 * is reported so the reviewer can check the transcription.
 */
export function applySotFormatting(request: IratRequest, paragraphs: StyledParagraph[]): SotFormattingResult {
  const result: SotFormattingResult = { applied: [], warnings: [] };
  const document = flatten(paragraphs);
  request.questions.forEach((question, index) => {
    const sourceNumber = question.sourceQuestionNumber ?? index + 1;
    const region = flatten(paragraphs.filter((paragraph) => paragraph.questionNumber === sourceNumber));
    const format = (value: string, label: string): string => {
      const styled = formatFromSot(value, region) ?? formatFromSot(value, document);
      if (styled === undefined) {
        result.warnings.push(`${label}: text was not found in SoT question ${sourceNumber}; request formatting kept.`);
        return value;
      }
      result.applied.push(label);
      return styled;
    };
    question.content = format(question.content, `${question.title} content`);
    question.answers.forEach((answer, answerIndex) => {
      // The SoT marks the answer key by bolding a whole option, which must never reach
      // learners. Bold spanning the entire option is dropped; partial bold is genuine.
      answer.text = unwrapWholeBold(format(answer.text, `${question.title} answer ${answerIndex + 1}`));
    });
    if (question.feedback !== undefined && question.feedback.trim() !== '') {
      question.feedback = format(question.feedback, `${question.title} feedback`);
    }
  });
  return result;
}

export async function applySotFormattingFromDocx(request: IratRequest): Promise<SotFormattingResult> {
  if (!request.sourceDocx) return { applied: [], warnings: [] };
  const filename = await resolveInputFile(request.sourceDocx, '.docx');
  const entries = readZipEntries(await readFile(filename));
  return applySotFormatting(request, extractStyledParagraphs(requireZipEntry(entries, 'word/document.xml').toString('utf8')));
}

/**
 * Finds the request text inside the styled characters and re-renders that slice with the
 * SoT's formatting. Line breaks from the request are matched segment by segment so the
 * reviewed break structure is preserved rather than inferred from paragraph boundaries.
 */
export function formatFromSot(value: string, characters: StyledCharacter[]): string | undefined {
  const segments = value.split(/<br\s*\/?>/i).map(plainText);
  const haystack = characters.map((character) => character.text).join('');
  const rendered: string[] = [];
  let searchFrom = 0;
  for (const segment of segments) {
    if (segment === '') {
      rendered.push('');
      continue;
    }
    const start = haystack.indexOf(segment, searchFrom);
    if (start < 0) return undefined;
    rendered.push(render(characters.slice(start, start + segment.length)));
    searchFrom = start + segment.length;
  }
  return rendered.join('<br>');
}

export interface StyledCharacter extends Omit<StyledRun, 'text'> {
  text: string;
}

/** One normalised character per entry: whitespace runs collapse to a single space. */
function flatten(paragraphs: StyledParagraph[]): StyledCharacter[] {
  const characters: StyledCharacter[] = [];
  const push = (text: string, style: Omit<StyledRun, 'text'>) => {
    for (const character of normalizeCharacters(text)) {
      const isSpace = character === ' ';
      if (isSpace && (characters.length === 0 || characters[characters.length - 1]!.text === ' ')) continue;
      characters.push({ text: character, ...(isSpace ? PLAIN : style) });
    }
  };
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) push(' ', PLAIN);
    for (const { text, ...style } of paragraph.runs) push(text, style);
  });
  return removeMarkAnnotations(characters);
}

/** Drops "(mark N)" annotations so request text written without them still matches. */
function removeMarkAnnotations(characters: StyledCharacter[]): StyledCharacter[] {
  const text = characters.map((character) => character.text).join('');
  const removed = new Set<number>();
  for (const match of text.matchAll(MARK_ANNOTATION)) {
    for (let index = match.index; index < match.index + match[0].length; index += 1) removed.add(index);
  }
  const kept = characters.filter((_character, index) => !removed.has(index));
  // Removing an annotation can leave two spaces touching; collapse them like flatten does.
  return kept.filter((character, index) => !(character.text === ' ' && kept[index - 1]?.text === ' '));
}

/** Removes a single <strong> pair that wraps the complete text, leaving inner tags intact. */
export function unwrapWholeBold(value: string): string {
  const match = /^<strong>([\s\S]*)<\/strong>$/.exec(value.trim());
  if (!match || /<\/strong>/.test(match[1] ?? '')) return value;
  return match[1] ?? value;
}

function render(characters: StyledCharacter[]): string {
  const groups: { style: Omit<StyledRun, 'text'>; text: string }[] = [];
  for (const character of characters) {
    const last = groups[groups.length - 1];
    // Spaces adopt the surrounding style so a formatted phrase is emitted as one tag pair.
    if (last && (character.text === ' ' || sameStyle(last.style, character))) last.text += character.text;
    else groups.push({ style: character, text: character.text });
  }
  return groups
    .map((group) => {
      // Trailing spaces stay outside the tags so "<em>lac</em> operon" round-trips cleanly.
      const trailing = /\s*$/.exec(group.text)?.[0] ?? '';
      let html = group.text.slice(0, group.text.length - trailing.length);
      if (group.style.vertical) html = `<${group.style.vertical}>${html}</${group.style.vertical}>`;
      if (group.style.underline) html = `<u>${html}</u>`;
      if (group.style.italic) html = `<em>${html}</em>`;
      if (group.style.bold) html = `<strong>${html}</strong>`;
      return html + trailing;
    })
    .join('')
    .trim();
}

function sameStyle(left: Omit<StyledRun, 'text'>, right: Omit<StyledRun, 'text'>): boolean {
  return left.bold === right.bold && left.italic === right.italic && left.underline === right.underline && left.vertical === right.vertical;
}

/** Request text without tags, normalised the same way as the SoT characters. */
function plainText(value: string): string {
  return normalizeCharacters(
    value
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(MARK_ANNOTATION, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word's typographic punctuation and non-breaking spaces compare equal to typed ASCII. */
function normalizeCharacters(value: string): string {
  return value
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[\s   ]/g, ' ');
}

function toggleOn(properties: string, tag: 'b' | 'i'): boolean {
  const match = new RegExp(`<w:${tag}\\b([^>]*)/?>`).exec(properties);
  if (!match) return false;
  const value = /w:val="([^"]*)"/.exec(match[1] ?? '')?.[1];
  return value === undefined || !/^(?:0|false|off)$/i.test(value);
}
