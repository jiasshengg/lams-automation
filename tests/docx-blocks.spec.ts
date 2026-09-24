import { expect, test } from '@playwright/test';
import { paragraphBlocks, topLevelBlocks } from '../src/docx/blocks.js';
import { numberQuestionStems } from '../src/docx/question-numbering.js';

test('reads a paragraph that anchors a text box as one block', () => {
  const xml = '<w:p><w:pPr/><w:r><w:t>outer</w:t></w:r><w:txbxContent><w:p><w:r><w:t>label</w:t></w:r></w:p></w:txbxContent><w:r><w:t>tail</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>next</w:t></w:r></w:p>';
  const blocks = topLevelBlocks(xml);
  expect(blocks.map((block) => block.kind)).toEqual(['p', 'p', 'p']);
  expect(blocks[0]?.inner).toContain('tail');
  expect(blocks[1]?.inner).toBe('');
});

test('keeps a table whole at the top level and lists its cell paragraphs in order', () => {
  const xml = '<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>c</w:t></w:r></w:p>';
  expect(topLevelBlocks(xml).map((block) => block.kind)).toEqual(['tbl', 'p']);
  expect(paragraphBlocks(xml)).toHaveLength(3);
});

test('rejects an unbalanced document instead of misreading it', () => {
  expect(() => topLevelBlocks('<w:p><w:r><w:t>open</w:t></w:r>')).toThrow('ends inside');
});

test('infers unnumbered stems only when numbering is requested', () => {
  const texts = ['1. First?', 'A. One', 'B. Two', 'Second, unnumbered?', 'A. One', 'B. Two', 'Third (4 marks)', 'A. One'];
  expect(numberQuestionStems(texts, { inferUnnumbered: true })).toEqual([1, null, null, 2, null, null, 3, null]);
  expect(numberQuestionStems(texts, { inferUnnumbered: false })).toEqual([1, null, null, null, null, null, null, null]);
});

test('a collapsed option run opens an option list, but a sentence starting with "A" does not', () => {
  const texts = [
    '1. First?', 'A. One', 'B. Two',
    'A 46 year old man went for a checkup.',
    'What is the ECG diagnosis?',
    'A Complete heart block B First degree C Second degree D Sinus bradycardia'
  ];
  expect(numberQuestionStems(texts, { inferUnnumbered: true })).toEqual([1, null, null, null, 2, null]);
});

test('a sentence opening with the next number is narrative unless an answer or options follow it', () => {
  const texts = [
    '1. What is the diagnosis?', 'A. One', 'B. Two',
    '2 weeks later, the patient developed a fever and was readmitted.',
    'What organism is most likely responsible?', 'A. One', 'B. Two'
  ];
  expect(numberQuestionStems(texts, { inferUnnumbered: false })).toEqual([1, null, null, null, null, null, null]);
  expect(numberQuestionStems(['1. Microcytosis', 'Answer - A', '2 Increased LDH', 'Answer - C'], { inferUnnumbered: false }))
    .toEqual([1, null, 2, null]);
});
