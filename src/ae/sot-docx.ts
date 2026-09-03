import { inflateRawSync } from 'node:zlib';

export interface SOTParagraph {
  text: string;
  bold: boolean;
  imageCount: number;
}

export type ObservedAEQuestionType = 'single-select' | 'multiple-select' | 'open-response';

export interface AEQuestionObservation {
  number: number;
  type: ObservedAEQuestionType;
  explicitMarks: number | null;
  optionLabels: string[];
  correctAnswerLabels: string[];
}

export interface AENodeObservation {
  index: number;
  questionNumbers: number[];
  firstQuestionNumber: number;
  lastQuestionNumber: number;
  questionRange: string;
  caseHeadings: string[];
  imageCount: number;
  suggestedTitle: string;
}

export interface AEGateObservation {
  index: number;
  afterNodeIndex: number;
  beforeNodeIndex: number;
  beforeQuestionNumber: number;
  suggestedTitle: string;
}

export interface AESOTAnalysis {
  sourceLabel: string;
  metadata: {
    applicationTitle: string | null;
    module: string | null;
    sessionTitle: string | null;
  };
  breakMarkerCount: number;
  requiredAENodes: number;
  requiredAEGates: number;
  questionCount: number;
  explicitMarksTotal: number;
  questionsWithoutExplicitMarks: number[];
  nodes: AENodeObservation[];
  gates: AEGateObservation[];
  questions: AEQuestionObservation[];
  requestVariables: {
    expectedAENodes: number;
    expectedAEGates: number;
  };
  reviewRequired: string[];
  warnings: string[];
}

const BREAK_MARKER = /^-{3}\s*BREAK\s*-{3}$/i;
const END_MARKER = /^END$/i;
const QUESTION_START = /^(\d+)[.)]\s+\S/;
const OPTION_START = /^([A-Z])[.)]\s+\S/;

export function readDocumentXmlFromDocx(buffer: Buffer): string {
  const entry = readZipEntry(buffer, 'word/document.xml');
  return entry.toString('utf8');
}

export function extractSOTParagraphs(documentXml: string): SOTParagraph[] {
  const paragraphs: SOTParagraph[] = [];
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let paragraphMatch: RegExpExecArray | null;

  while ((paragraphMatch = paragraphPattern.exec(documentXml)) !== null) {
    const xml = paragraphMatch[1] ?? '';
    const pieces: string[] = [];
    const contentPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
    let contentMatch: RegExpExecArray | null;
    while ((contentMatch = contentPattern.exec(xml)) !== null) {
      if (contentMatch[1] !== undefined) pieces.push(decodeXml(contentMatch[1]));
      else pieces.push(' ');
    }

    const text = normalizeText(pieces.join(''));
    if (text === '' && !/<w:drawing\b/.test(xml)) continue;
    paragraphs.push({
      text,
      bold: text !== '' && isFullyBoldParagraph(xml),
      imageCount: countMatches(xml, /<w:drawing\b/g)
    });
  }
  return paragraphs;
}

export function analyzeAESOT(paragraphs: SOTParagraph[], fallbackLabel: string): AESOTAnalysis {
  const endIndex = paragraphs.findIndex((paragraph) => END_MARKER.test(paragraph.text));
  const contentEnd = endIndex >= 0 ? endIndex : paragraphs.length;
  const relevant = paragraphs.slice(0, contentEnd);
  const breakIndexes = relevant
    .map((paragraph, index) => (BREAK_MARKER.test(paragraph.text) ? index : -1))
    .filter((index) => index >= 0);

  const boundaries = [-1, ...breakIndexes, relevant.length];
  const groups = boundaries.slice(0, -1).map((boundary, index) => {
    const next = boundaries[index + 1]!;
    return relevant.slice(boundary + 1, next);
  });

  if (groups.length === 0) throw new Error('The AE SOT did not contain any content.');

  const questions: AEQuestionObservation[] = [];
  const nodes = groups.map<AENodeObservation>((untrimmedGroup, index) => {
    const firstQuestionIndex = untrimmedGroup.findIndex((paragraph) => QUESTION_START.test(paragraph.text));
    const precedingCaseIndex = untrimmedGroup.reduce(
      (latest, paragraph, paragraphIndex) =>
        paragraphIndex < firstQuestionIndex && /^Case\s+\d+\b/i.test(paragraph.text) ? paragraphIndex : latest,
      -1
    );
    const group = precedingCaseIndex >= 0 ? untrimmedGroup.slice(precedingCaseIndex) : untrimmedGroup;
    const questionStarts = group
      .map((paragraph, paragraphIndex) => {
        const match = paragraph.text.match(QUESTION_START);
        return match ? { paragraphIndex, number: Number(match[1]) } : null;
      })
      .filter((value): value is { paragraphIndex: number; number: number } => value !== null);

    if (questionStarts.length === 0) {
      throw new Error(`Break-derived AE group ${index + 1} does not contain a numbered question.`);
    }

    questionStarts.forEach((start, questionIndex) => {
      const nextStart = questionStarts[questionIndex + 1]?.paragraphIndex ?? group.length;
      questions.push(observeQuestion(group.slice(start.paragraphIndex, nextStart), start.number));
    });

    const questionNumbers = questionStarts.map((question) => question.number);
    const firstQuestionNumber = questionNumbers[0]!;
    const lastQuestionNumber = questionNumbers.at(-1)!;
    const questionRange = formatQuestionRange(firstQuestionNumber, lastQuestionNumber);
    return {
      index: index + 1,
      questionNumbers,
      firstQuestionNumber,
      lastQuestionNumber,
      questionRange,
      caseHeadings: group.map((paragraph) => paragraph.text).filter((text) => /^Case\s+\d+\b/i.test(text)),
      imageCount: group.reduce((sum, paragraph) => sum + paragraph.imageCount, 0),
      suggestedTitle: `AE ${questionRange}`
    };
  });

  assertSequentialQuestions(questions.map((question) => question.number));

  const applicationTitle = valueAfterLabel(relevant, 'Application title');
  const module = valueAfterLabel(relevant, 'Module');
  const sessionTitle = valueAfterLabel(relevant, 'Session Title');
  const questionsWithoutExplicitMarks = questions
    .filter((question) => question.explicitMarks === null)
    .map((question) => question.number);
  const multipleSelectQuestions = questions
    .filter((question) => question.type === 'multiple-select')
    .map((question) => question.number);
  const missingAnswerKeys = questions
    .filter((question) => question.type !== 'open-response' && question.correctAnswerLabels.length === 0)
    .map((question) => question.number);
  const warnings: string[] = [];
  if (endIndex < 0) warnings.push('No standalone END marker was found; extraction continued to the end of the document.');
  if (questionsWithoutExplicitMarks.length > 0) {
    warnings.push(`Questions without explicit marks: ${formatNumberList(questionsWithoutExplicitMarks)}.`);
  }
  if (multipleSelectQuestions.length > 0) {
    warnings.push(
      `Multiple-select questions detected: ${formatNumberList(multipleSelectQuestions)}. The current AE execution-plan schema requires exactly one correct MCQ option.`
    );
  }
  if (missingAnswerKeys.length > 0) {
    warnings.push(`Selectable questions without a confidently detected answer key: ${formatNumberList(missingAnswerKeys)}.`);
  }

  const sourceLabel = applicationTitle ?? fallbackLabel;
  const gates = nodes.slice(1).map<AEGateObservation>((node, index) => ({
    index: index + 1,
    afterNodeIndex: index + 1,
    beforeNodeIndex: index + 2,
    beforeQuestionNumber: node.firstQuestionNumber,
    suggestedTitle: `AE Gate before Q${node.firstQuestionNumber}`
  }));
  return {
    sourceLabel,
    metadata: { applicationTitle, module, sessionTitle },
    breakMarkerCount: breakIndexes.length,
    requiredAENodes: groups.length,
    requiredAEGates: breakIndexes.length,
    questionCount: questions.length,
    explicitMarksTotal: questions.reduce((sum, question) => sum + (question.explicitMarks ?? 0), 0),
    questionsWithoutExplicitMarks,
    nodes,
    gates,
    questions,
    requestVariables: {
      expectedAENodes: groups.length,
      expectedAEGates: breakIndexes.length
    },
    reviewRequired: [
      'Confirm exact AE node titles; suggested titles are not authority for existing LAMS nodes.',
      'Confirm exact AE gate titles and build the linear expectedFlow from the approved naming convention.',
      'Review question text, answers, marks, tables, images, and links before creating AE plan JSON.'
    ],
    warnings
  };
}

export function formatAESOTSummary(analysis: AESOTAnalysis): string {
  const lines = [
    'AE SOT extraction: REVIEW REQUIRED',
    `Source: ${analysis.sourceLabel}`,
    `Breaks: ${analysis.breakMarkerCount} | AE nodes: ${analysis.requiredAENodes} | AE gates: ${analysis.requiredAEGates}`,
    `Questions: ${analysis.questionCount} | Explicit marks subtotal: ${analysis.explicitMarksTotal}`,
    '',
    'Break-derived groups'
  ];
  analysis.nodes.forEach((node) => {
    const cases = node.caseHeadings.length > 0 ? ` | ${node.caseHeadings.join('; ')}` : '';
    const images = node.imageCount > 0 ? ` | images: ${node.imageCount}` : '';
    lines.push(`- ${node.suggestedTitle}: ${node.questionRange}${cases}${images}`);
  });
  lines.push('', 'Gate boundaries');
  analysis.gates.forEach((gate) => {
    lines.push(
      `- ${gate.suggestedTitle}: node ${gate.afterNodeIndex} -> node ${gate.beforeNodeIndex} (before Q${gate.beforeQuestionNumber})`
    );
  });
  lines.push('', 'Playwright request variables', JSON.stringify(analysis.requestVariables));
  if (analysis.warnings.length > 0) {
    lines.push('', 'Warnings', ...analysis.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('', 'Human/agent review required', ...analysis.reviewRequired.map((item) => `- ${item}`));
  return lines.join('\n');
}

function observeQuestion(paragraphs: SOTParagraph[], number: number): AEQuestionObservation {
  const optionParagraphs = paragraphs
    .map((paragraph) => ({ paragraph, match: paragraph.text.match(OPTION_START) }))
    .filter((value): value is { paragraph: SOTParagraph; match: RegExpMatchArray } => value.match !== null);
  const optionLabels = optionParagraphs.map(({ match }) => match[1]!);
  const explicitAnswer = paragraphs
    .map((paragraph) => paragraph.text.match(/^Answer\s*[-:]\s*(.+)$/i)?.[1])
    .find((value) => value !== undefined);
  const explicitLabels = explicitAnswer ? [...explicitAnswer.matchAll(/\b([A-Z])\b/g)].map((match) => match[1]!) : [];
  const boldLabels = optionParagraphs
    .filter(({ paragraph }) => paragraph.bold)
    .map(({ match }) => match[1]!);
  const correctAnswerLabels = unique(explicitLabels.length > 0 ? explicitLabels : boldLabels);
  const prompt = paragraphs[0]?.text ?? '';
  const marksMatch = prompt.match(/\(?\s*(\d+)\s+marks?\s*\)?/i);
  const multipleSelect = /select\s+(?:two|three|four|five|\d+)\b/i.test(prompt) || correctAnswerLabels.length > 1;
  const type: ObservedAEQuestionType =
    optionLabels.length === 0 ? 'open-response' : multipleSelect ? 'multiple-select' : 'single-select';
  return {
    number,
    type,
    explicitMarks: marksMatch ? Number(marksMatch[1]) : null,
    optionLabels,
    correctAnswerLabels
  };
}

function assertSequentialQuestions(numbers: number[]): void {
  if (numbers.length === 0) throw new Error('The AE SOT does not contain any numbered questions.');
  numbers.forEach((number, index) => {
    const expected = index + 1;
    if (number !== expected) throw new Error(`Question numbers must be sequential from 1; expected ${expected}, found ${number}.`);
  });
}

function valueAfterLabel(paragraphs: SOTParagraph[], label: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*(.+)$`, 'i');
  for (const paragraph of paragraphs) {
    const match = paragraph.text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function isFullyBoldParagraph(xml: string): boolean {
  const runPattern = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  let sawText = false;
  let runMatch: RegExpExecArray | null;
  while ((runMatch = runPattern.exec(xml)) !== null) {
    const runXml = runMatch[1] ?? '';
    const text = [...runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXml(match[1] ?? ''))
      .join('')
      .trim();
    if (text === '') continue;
    sawText = true;
    if (!/<w:b(?:\s[^>]*)?\/>/.test(runXml) || /<w:b\b[^>]*w:val=["'](?:0|false|off)["'][^>]*\/>/i.test(runXml)) {
      return false;
    }
  }
  return sawText;
}

function readZipEntry(buffer: Buffer, expectedName: string): Buffer {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('The supplied file is not a supported DOCX/ZIP file.');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralSignature) throw new Error('Invalid DOCX central directory.');
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    if (fileName === expectedName) {
      if (buffer.readUInt32LE(localOffset) !== localSignature) throw new Error('Invalid DOCX local file header.');
      const localFileNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localFileNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return compressed;
      if (compressionMethod === 8) return inflateRawSync(compressed);
      throw new Error(`Unsupported DOCX compression method ${compressionMethod}.`);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`The supplied DOCX does not contain ${expectedName}.`);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatQuestionRange(first: number, last: number): string {
  return first === last ? `Q${first}` : `Q${first}–${last}`;
}

function formatNumberList(values: number[]): string {
  return values.map((value) => `Q${value}`).join(', ');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
