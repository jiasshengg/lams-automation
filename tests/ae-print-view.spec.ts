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
