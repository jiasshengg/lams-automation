import { expect, test } from '@playwright/test';
import { buildAEDraft } from '../src/ae/draft.js';
import { IMAGE_SLOT_LINE, buildAEPlan } from '../src/ae/plan.js';
import { analyzeAESOT, extractSOTParagraphs } from '../src/ae/sot-docx.js';
import { questionDescriptionHtml } from '../src/lams/ae-editor.js';

type Spacing = { before?: number; after?: number };

function p(text: string, options: { spacing?: Spacing; list?: number; style?: string; pageBreak?: boolean; drawing?: boolean } = {}): string {
  const properties = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
    options.list !== undefined ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.list}"/></w:numPr>` : '',
    options.spacing
      ? `<w:spacing${options.spacing.before !== undefined ? ` w:before="${options.spacing.before}"` : ''}${options.spacing.after !== undefined ? ` w:after="${options.spacing.after}"` : ''}/>`
      : ''
  ].join('');
  const pageBreak = options.pageBreak ? '<w:r><w:br w:type="page"/></w:r>' : '';
  const drawing = options.drawing ? '<w:r><w:drawing><wp:inline/></w:drawing></w:r>' : '';
  const run = text === '' ? '' : `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${pageBreak}${drawing}${run}</w:p>`;
}

const doc = (...blocks: string[]) => `<w:document><w:body>${blocks.join('')}</w:body></w:document>`;

const STYLES = `<w:styles>
  <w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="200" w:line="276"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<w:numbering>
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
  <w:num w:numId="10"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="11"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

test('gives Word lettered-list paragraphs the letter Word prints, so they read as answer options', () => {
  const paragraphs = extractSOTParagraphs(
    doc(
      p('Case 1'),
      p('1. Which sequencing tests detect this syndrome?'),
      p('Whole genome sequencing', { list: 11, style: 'ListParagraph' }),
      p('Exome sequencing', { list: 11, style: 'ListParagraph' }),
      p('All of the above', { list: 11, style: 'ListParagraph' }),
      p('A bulleted aside', { list: 3 }),
      p('END')
    ),
    { stylesXml: STYLES, numberingXml: NUMBERING }
  );

  expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
    'Case 1',
    '1. Which sequencing tests detect this syndrome?',
    'A. Whole genome sequencing',
    'B. Exome sequencing',
    'C. All of the above',
    'A bulleted aside',
    'END'
  ]);
  const question = analyzeAESOT(paragraphs, 'fallback').questions[0]!;
  expect(question.type).toBe('single-select');
  expect(question.options.map((option) => option.html)).toEqual(['Whole genome sequencing', 'Exome sequencing', 'All of the above']);
});

test('counts each list separately, the way Word numbers them', () => {
  const texts = extractSOTParagraphs(
    doc(p('First', { list: 10 }), p('Second', { list: 10 }), p('Other list', { list: 11 }), p('Third', { list: 10 })),
    { numberingXml: NUMBERING }
  ).map((paragraph) => paragraph.text);
  expect(texts).toEqual(['A. First', 'B. Second', 'A. Other list', 'C. Third']);
});

test('records the empty lines the document types between paragraphs', () => {
  const paragraphs = extractSOTParagraphs(
    doc(p('Case 4', { spacing: { after: 0 } }), p('', { spacing: { after: 0 } }), p('History', { spacing: { after: 0 } }), p('', { spacing: { after: 0 } }), p('', { spacing: { after: 0 } }), p('The proband', { spacing: { after: 0 } })),
    { stylesXml: STYLES }
  );
  expect(paragraphs.map((paragraph) => [paragraph.text, paragraph.blankLinesBefore])).toEqual([
    ['Case 4', 0],
    ['History', 1],
    ['The proband', 2]
  ]);
});

test('reads paragraph spacing as a blank line only when Word leaves a visible gap', () => {
  const paragraphs = extractSOTParagraphs(
    doc(
      p('Case 1', { spacing: { after: 280 } }),
      // No explicit spacing: inherits the document default of 10pt after.
      p('Ms Tan is admitted.'),
      p('Her data are below.', { spacing: { after: 0 } }),
      p('1. What dose? (4 marks)', { spacing: { before: 140, after: 100 } }),
      p('A. 300 mg', { spacing: { after: 40 } }),
      p('B. 600 mg', { spacing: { after: 40 } }),
      p('First', { style: 'ListParagraph' }),
      p('Second', { style: 'ListParagraph' })
    ),
    { stylesXml: STYLES }
  );
  expect(paragraphs.map((paragraph) => [paragraph.text, paragraph.blankLinesBefore])).toEqual([
    ['Case 1', 0],
    ['Ms Tan is admitted.', 1],
    ['Her data are below.', 1],
    ['1. What dose? (4 marks)', 1],
    ['A. 300 mg', 0],
    ['B. 600 mg', 0],
    ['First', 0],
    // Contextual spacing: Word drops the gap between paragraphs of the same style.
    ['Second', 0]
  ]);
});

test('a page break does not count as a blank line but is recorded on the next paragraph', () => {
  const paragraphs = extractSOTParagraphs(doc(p('Before'), p('', { pageBreak: true }), p('After')));
  expect(paragraphs.map((paragraph) => [paragraph.text, paragraph.blankLinesBefore, paragraph.pageBreakBefore])).toEqual([
    ['Before', 0, false],
    ['After', 0, true]
  ]);
});

function spacedSot() {
  return analyzeAESOT(
    extractSOTParagraphs(
      doc(
        p('Case 6', { spacing: { after: 0 } }),
        p('', { spacing: { after: 0 } }),
        p('A patient has the karyotype below:', { spacing: { after: 0 } }),
        p('', { spacing: { after: 0 } }),
        p('', { spacing: { after: 0 }, drawing: true }),
        p('', { spacing: { after: 0 } }),
        p('', { spacing: { after: 0 } }),
        p('1. What syndrome does the patient have?', { spacing: { after: 0 } }),
        p('', { spacing: { after: 0 } }),
        p('2. Which tests detect it?', { spacing: { after: 0 } }),
        p('Whole genome sequencing', { list: 11, style: 'ListParagraph' }),
        p('Exome sequencing', { list: 11, style: 'ListParagraph' }),
        p('', { pageBreak: true }),
        p('After stable treatment, Mr Kumar starts another medicine.', { spacing: { after: 160 } }),
        p('3. Which change is expected? (4 marks)', { spacing: { before: 140, after: 100 } }),
        p('A. Clearance decreases', { spacing: { after: 40 } }),
        p('B. Clearance increases', { spacing: { after: 40 } }),
        p('Answer - A'),
        p('END')
      ),
      { stylesXml: STYLES, numberingXml: NUMBERING }
    ),
    'fallback'
  );
}

test('the draft keeps the document blank lines and marks where a figure sits in the case text', () => {
  const draft = buildAEDraft(spacedSot());
  const [first, second] = draft.nodes[0]!.questions;
  expect(first!.prompt).toBe(
    ['Case 6', '', 'A patient has the karyotype below:', '', IMAGE_SLOT_LINE, '', '', '1. What syndrome does the patient have?'].join('\n')
  );
  // Leading blank lines belong to the previous question, not to this prompt.
  expect(second!.prompt).toBe('2. Which tests detect it?');
});

test('text after a page break opens the next question instead of trailing the previous one', () => {
  const analysis = spacedSot();
  const second = analysis.questions.find((question) => question.number === 2)!;
  expect(second.options.map((option) => option.html)).toEqual(['Whole genome sequencing', 'Exome sequencing']);
  const third = buildAEDraft(analysis).nodes[0]!.questions.find((question) => question.number === 3)!;
  expect(third.prompt).toBe(['After stable treatment, Mr Kumar starts another medicine.', '', '3. Which change is expected? (4 marks)'].join('\n'));
});

test('writes blank lines as empty Normal blocks and never doubles the gap after a Case heading', () => {
  const input = {
    sourceLabel: 'Layout',
    breakMarkerCount: 0,
    nodes: [
      {
        title: 'AE Case 6 Q1',
        questions: [
          { number: 1, type: 'essay', prompt: ['', 'Case 6', '', 'A patient.', IMAGE_SLOT_LINE, '', '', '1. Why? [4 marks]', ''].join('\n') }
        ]
      }
    ],
    gates: []
  };
  expect(buildAEPlan(input).nodes[0]!.questions[0]!.promptHtml).toBe(
    '<div><strong><u>Case 6</u></strong></div><div><br></div><div>A patient.</div><!--sot-image--><div><br></div><div><br></div><div>1. Why?</div>'
  );
});

test('a line holding only a mark annotation is removed rather than left as a blank line', () => {
  const input = {
    sourceLabel: 'Legacy',
    breakMarkerCount: 0,
    nodes: [{ title: 'AE Case 1 Q1', questions: [{ number: 1, type: 'essay', prompt: 'Case 1\n[4 marks]\nQUESTION 1\nExplain.' }] }],
    gates: []
  };
  expect(buildAEPlan(input).nodes[0]!.questions[0]!.promptHtml).toBe(
    '<div><strong><u>Case 1</u></strong></div><div><br></div><div>QUESTION 1</div><div><br></div><div>Explain.</div>'
  );
});

test('a table keeps the width and cell alignment the document gives it', () => {
  const cell = (text: string, twips: number, center = false) =>
    `<w:tc><w:tcPr><w:tcW w:w="${twips}" w:type="dxa"/></w:tcPr><w:p>${center ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : ''}<w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const [table] = extractSOTParagraphs(
    doc(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid>` +
        `<w:tr>${cell('Route', 3000, true)}${cell('Dose', 6000)}</w:tr></w:tbl>`
    )
  );
  // 9000 twips is 600px: the table is as wide as the document prints it, not stretched.
  expect(table!.html).toBe('<table width="600"><tr><td width="33%" align="center">Route</td><td width="67%">Dose</td></tr></table>');

  const plan = buildAEPlan({
    sourceLabel: 'Table',
    breakMarkerCount: 0,
    nodes: [{ title: 'AE Case 5 Q1', questions: [{ number: 1, type: 'essay', prompt: `${table!.html}\n1. Explain. <table width="9999" style="x">` }] }],
    gates: []
  });
  expect(plan.nodes[0]!.questions[0]!.promptHtml).toContain(
    '<table border="1" cellpadding="4" cellspacing="0" width="600"><tr><td width="33%" align="center">Route</td><td width="67%">Dose</td></tr></table>'
  );
});

test('a reviewed table keeps only a sane width and a centre or right alignment', () => {
  const plan = buildAEPlan({
    sourceLabel: 'Table',
    breakMarkerCount: 0,
    nodes: [{
      title: 'AE Case 5 Q1',
      questions: [{ number: 1, type: 'essay', prompt: '<table width="99999"><tr><td align="justify" valign="top">A</td><td align="right">B</td></tr></table>\n1. Explain.' }]
    }],
    gates: []
  });
  const html = plan.nodes[0]!.questions[0]!.promptHtml;
  expect(html).toContain('<table border="1" cellpadding="4" cellspacing="0" width="100%"><tr><td>A</td><td align="right">B</td></tr></table>');
});

test('places each figure in the slot the document printed it in', () => {
  const image = (url: string, placement: 'before' | 'after') => ({ url, altText: '', widthPx: null, placement, caption: '', source: 'sot' });
  const prompt = '<div>Case 6</div><div><br></div><div>Text.</div><!--sot-image--><div><br></div><div>11. Why?</div>';
  expect(questionDescriptionHtml(prompt, [image('k.png', 'before'), image('g.png', 'after')])).toBe(
    '<div>Case 6</div><div><br></div><div>Text.</div><div><img src="k.png" alt=""></div><div><br></div><div>11. Why?</div>' +
      '<div><img src="g.png" alt=""></div>'
  );
  // A slot with no figure to fill it leaves nothing behind for CKEditor.
  expect(questionDescriptionHtml(prompt, [])).not.toContain('sot-image');
});
