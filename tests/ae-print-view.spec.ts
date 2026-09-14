import { expect, test } from '@playwright/test';
import { buildAEPlan } from '../src/ae/plan.js';
import { verifyAEPrintContent } from '../src/lams/ae-editor.js';

const node = buildAEPlan({
  sourceLabel: 'Print regression', breakMarkerCount: 0, gates: [],
  nodes: [{ title: 'AE 1', questions: [{
    number: 1, type: 'essay', prompt: `Explain the patient's "A & B" result: 1 < 2 > 0.\nLiteral entity text: &lt;.`
  }] }]
}).nodes[0]!;

test('Print View compares decoded punctuation and literal entity text correctly', async ({ page }) => {
  await page.setContent(`<h1>Question 1</h1>${node.questions[0]!.promptHtml}`);
  await verifyAEPrintContent(page, node, []);
});

test('Print View still rejects missing prompt text', async ({ page }) => {
  await page.setContent('<h1>Question 1</h1><p>Wrong prompt</p>');
  await expect(verifyAEPrintContent(page, node, [])).rejects.toThrow('omitted expected text');
});

const figure = { url: 'https://example.test/figure.png', caption: '<strong>Figure 1.</strong> Plasma profile' };

test('Print View requires the caption printed under an imported figure', async ({ page }) => {
  await page.setContent(
    `<h1>Question 1</h1>${node.questions[0]!.promptHtml}<img src="${figure.url}"><p>Figure 1. Plasma profile</p>`
  );
  await verifyAEPrintContent(page, node, [figure]);

  await page.setContent(`<h1>Question 1</h1>${node.questions[0]!.promptHtml}<img src="${figure.url}">`);
  await expect(verifyAEPrintContent(page, node, [figure])).rejects.toThrow('omitted the caption');
});

test('Print View compares superscript and emphasis as the page renders them', async ({ page }) => {
  const formatted = buildAEPlan({
    sourceLabel: 'Formatting regression', breakMarkerCount: 0, gates: [],
    nodes: [{ title: 'AE 1', questions: [{
      number: 1, type: 'mcq',
      prompt: '1. A sample contains 10<sup>9</sup> molecules of <em>PK-101</em>?',
      options: [{ text: 'A. 10<sup>9</sup> per litre', correct: true }, { text: 'B. None', correct: false }]
    }] }]
  }).nodes[0]!;

  await page.setContent(
    `<h1>Question 1</h1>${formatted.questions[0]!.promptHtml}` +
    formatted.questions[0]!.options.map((option) => `<div>${option.html}</div>`).join('')
  );
  await verifyAEPrintContent(page, formatted, []);
});
