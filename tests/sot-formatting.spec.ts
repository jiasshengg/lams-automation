import { expect, test } from '@playwright/test';
import type { IratRequest } from '../src/config.js';
import { readZipEntries, requireZipEntry } from '../src/docx/archive.js';
import { applySotFormatting, extractStyledParagraphs, formatFromSot } from '../src/docx/sot-formatting.js';
import { mediaDocx } from './helpers/docx-media.js';

const run = (text: string, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;

const documentXml = [
  p(run('1. The '), run('lac', '<w:i/>'), run(' operon is '), run('repressed', '<w:b/>'), run(' by glucose ('), run('mark 1', '<w:b w:val="0"/>'), run(')')),
  p(run('A. '), run('True', '<w:i/><w:b/>')),
  p(run('B. False')),
  p(run('Answer: A')),
  p(run('Rationale: CO'), run('2', '<w:vertAlign w:val="subscript"/>'), run(' and 10'), run('9', '<w:vertAlign w:val="superscript"/>'), run(' with '), run('“curly”', '<w:u w:val="single"/>'), run(' quotes')),
  p(run('2. Second question'), run('\t'), run('spans'), '<w:r><w:br/></w:r>', run('two lines')),
  p(run('A. '), run('lac', '<w:i/>'), run(' again'))
].join('');

function request(): IratRequest {
  return {
    gate: { name: 'iRAT Gate', description: 'iRAT Gate', type: 'password', dynamicPassword: true, rotationSeconds: 10 },
    activityName: 'iRAT',
    teamSetupName: 'Team Setup',
    questions: [
      {
        title: 'Question 1', type: 'multiple-choice', marks: 1, mandatory: true,
        content: 'The lac operon is repressed by glucose (mark 1)',
        feedback: 'CO2 and 109 with "curly" quotes',
        answers: [{ text: 'True', correct: true, weight: 100 }, { text: 'False', correct: false, weight: 0 }]
      },
      {
        title: 'Question 2', type: 'multiple-choice', marks: 1, mandatory: true,
        content: 'Second question spans<br>two lines',
        answers: [{ text: '<em>lac</em> again', correct: true, weight: 100 }, { text: 'Not in the SoT at all', correct: false, weight: 0 }]
      }
    ],
    advanced: { shuffleQuestions: true, shuffleAnswers: true, questionsNumbering: true, displayAllQuestions: true, displayAllAfterCompletion: true, answerJustification: true, confidenceLevels: true }
  };
}

test('reads direct run formatting and assigns paragraphs to SoT questions', () => {
  const paragraphs = extractStyledParagraphs(documentXml);
  expect(paragraphs.map((paragraph) => paragraph.questionNumber)).toEqual([1, 1, 1, 1, 1, 2, 2]);
  expect(paragraphs[0]!.runs.map((run) => [run.text, run.italic, run.bold])).toEqual([
    ['1. The ', false, false], ['lac', true, false], [' operon is ', false, false], ['repressed', false, true], [' by glucose (', false, false], ['mark 1', false, false], [')', false, false]
  ]);
  expect(paragraphs[4]!.runs.map((run) => run.vertical)).toEqual([null, 'sub', null, 'sup', null, null, null]);
  expect(paragraphs[4]!.runs[5]!.underline).toBe(true);
});

test('re-renders request text with the SoT formatting for the same words', () => {
  const paragraphs = extractStyledParagraphs(documentXml);
  const irat = request();
  const result = applySotFormatting(irat, paragraphs);
  expect(irat.questions[0]!.content).toBe('The <em>lac</em> operon is <strong>repressed</strong> by glucose (mark 1)');
  expect(irat.questions[0]!.answers.map((answer) => answer.text)).toEqual(['<strong><em>True</em></strong>', 'False']);
  expect(irat.questions[0]!.feedback).toBe('CO<sub>2</sub> and 10<sup>9</sup> with <u>"curly"</u> quotes');
  expect(irat.questions[1]!.content).toBe('Second question spans<br>two lines');
  expect(irat.questions[1]!.answers[0]!.text).toBe('<em>lac</em> again');
  expect(irat.questions[1]!.answers[1]!.text).toBe('Not in the SoT at all');
  expect(result.applied).toEqual([
    'Question 1 content', 'Question 1 answer 1', 'Question 1 answer 2', 'Question 1 feedback',
    'Question 2 content', 'Question 2 answer 1'
  ]);
  expect(result.warnings).toEqual(['Question 2 answer 2: text was not found in SoT question 2; request formatting kept.']);
});

test('request tags are replaced by the SoT, not merged with it', () => {
  const paragraphs = extractStyledParagraphs(documentXml);
  const irat = request();
  irat.questions[0]!.content = 'The lac operon is <em>repressed</em> by glucose (mark 1)';
  applySotFormatting(irat, paragraphs);
  expect(irat.questions[0]!.content).toBe('The <em>lac</em> operon is <strong>repressed</strong> by glucose (mark 1)');
});

test('matches inside the numbered question before falling back to the whole document', () => {
  const paragraphs = extractStyledParagraphs(documentXml);
  const irat = request();
  irat.questions = [{ ...irat.questions[1]!, sourceQuestionNumber: 2, answers: [{ text: 'lac', correct: true, weight: 100 }, { text: 'False', correct: false, weight: 0 }] }];
  applySotFormatting(irat, paragraphs);
  // "lac" is italic in both questions; "False" only exists in question 1 and is found by fallback.
  expect(irat.questions[0]!.answers.map((answer) => answer.text)).toEqual(['<em>lac</em>', 'False']);
});

test('formatFromSot returns undefined for text the SoT does not contain', () => {
  const characters = extractStyledParagraphs(documentXml).flatMap((paragraph) => paragraph.runs.flatMap((run) => [...run.text].map((text) => ({ ...run, text }))));
  expect(formatFromSot('never written', characters)).toBeUndefined();
});

test('reads formatting from a real DOCX archive', () => {
  const buffer = mediaDocx(p(run('1. Only '), run('this', '<w:i/>'), run(' word')));
  const xml = requireZipEntry(readZipEntries(buffer), 'word/document.xml').toString('utf8');
  const irat = request();
  irat.questions = [{ ...irat.questions[0]!, content: 'Only this word', answers: [{ text: 'A', correct: true, weight: 100 }, { text: 'B', correct: false, weight: 0 }] }];
  delete irat.questions[0]!.feedback;
  const result = applySotFormatting(irat, extractStyledParagraphs(xml));
  expect(irat.questions[0]!.content).toBe('Only <em>this</em> word');
  expect(result.warnings).toHaveLength(2);
});
