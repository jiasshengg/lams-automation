import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import {
  applyAEAnswerScoring,
  clickRowControl,
  exactQuestionRow,
  expandAuthoringSections,
  questionDescriptionHtml,
  verifyAEPrintContent,
  resizeOptions
} from '../src/lams/ae-editor.js';

// Reproduces qb-option.js: removeOption() gates the deletion behind confirm(), and the
// delete control stays hidden until its option row is expanded. resizeOptions attaches
// its dialog handler to frame.page(), so these run in a real child frame, not the page.
function optionMarkup(count: number): string {
  const tables = Array.from({ length: count }, (_, index) => `
    <table id="option-table-${index}" class="single-option-table">
      <tbody><tr><td>
        <button type="button" class="delete-button option-settings-hidden"
                onclick="removeOption(Number('${index}'))" style="display: none;">x</button>
      </td></tr></tbody>
    </table>`).join('');
  return `${tables}
    <a onclick="addOption()" style="display:block">Add option</a>
    <script>
      function removeOption(idx) {
        if (confirm('Delete this answer?')) document.getElementById('option-table-' + idx).remove();
      }
      function addOption() {
        const next = document.querySelectorAll('.single-option-table').length;
        const table = document.createElement('table');
        table.id = 'option-table-' + next;
        table.className = 'single-option-table';
        table.innerHTML = '<tbody><tr><td>Answer ' + (next + 1) + '</td></tr></tbody>';
        document.querySelector('a[onclick*="addOption"]').before(table);
      }
    </script>`;
}

async function childFrameWith(page: Page, html: string): Promise<Frame> {
  await page.setContent(`<iframe id="activity" srcdoc="${html.replace(/"/g, '&quot;')}"></iframe>`);
  const frame = page.frame({ url: /about:srcdoc/ }) ?? page.frames()[1];
  if (!frame) throw new Error('test harness did not create a child frame');
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

test('removes surplus answer options by accepting the deletion confirm', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(4));
  await resizeOptions(frame, 3, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(3);
});

test('removes several surplus options in one pass', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(5));
  await resizeOptions(frame, 2, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(2);
});

test('adds missing answer options and leaves a matching count alone', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(2));
  await resizeOptions(frame, 4, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(4);
  await resizeOptions(frame, 4, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(4);
});

test('does not leave a dialog handler attached to the page', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(4));
  await resizeOptions(frame, 3, 5000);
  // A leaked handler would keep swallowing later confirms; with none attached
  // Playwright reverts to auto-dismiss, so the option survives.
  await frame.locator('.single-option-table').first().locator('.delete-button')
    .evaluate((element: HTMLElement) => element.click());
  await page.waitForTimeout(250);
  expect(await frame.locator('.single-option-table').count()).toBe(3);
});

// The attempts and passing-mark controls sit in an accordion that loads collapsed.
const ACCORDION = `
  <div id="advancedCollapse" style="display: none;">
    <input type="radio" id="attemptsAllowedRadio">
    <select id="attemptsAllowed"><option value="1">1</option></select>
  </div>
  <button id="expandAllButton" onclick="document.getElementById('advancedCollapse').style.display = 'block'">Expand all</button>`;

test('expands collapsed authoring sections so attempt settings become actionable', async ({ page }) => {
  const frame = await childFrameWith(page, ACCORDION);
  await expect(frame.locator('#attemptsAllowed')).toBeHidden();
  await expandAuthoringSections(frame, 5000);
  await expect(frame.locator('#attemptsAllowed')).toBeVisible();
  await frame.locator('#attemptsAllowedRadio').check();
  await frame.locator('#attemptsAllowed').selectOption('1');
});

test('fails loudly when the expand control is missing', async ({ page }) => {
  const frame = await childFrameWith(page, '<div id="advancedCollapse" style="display:none"></div>');
  await expect(expandAuthoringSections(frame, 1000)).rejects.toThrow();
});

test('sets and verifies multiple-answer mode with fractional option weights', async ({ page }) => {
  const frame = await childFrameWith(page, `
    <select id="multipleAnswersAllowed">
      <option value="false">One answer only</option>
      <option value="true">Multiple answers allowed</option>
    </select>
    <input id="optionMaxMark0" type="hidden">
    <input id="optionMaxMark1" type="hidden">
    <input id="optionMaxMark2" type="hidden">
  `);

  await applyAEAnswerScoring(frame, {
    title: 'Question 2',
    multipleAnswersAllowed: true,
    options: [
      { text: 'First', html: 'First', creditPercent: 50 },
      { text: 'Second', html: 'Second', creditPercent: 50 },
      { text: 'Third', html: 'Third', creditPercent: 0 }
    ]
  });

  expect(await frame.locator('#multipleAnswersAllowed').inputValue()).toBe('true');
  expect(await frame.locator('[id^="optionMaxMark"]').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  )).toEqual(['0.5', '0.5', '0']);
});

test('keeps a figure above the stem when the Source-of-Truth printed it there', () => {
  const pedigree = {
    url: 'https://example.test/pedigree.png', altText: '', widthPx: null,
    placement: 'before' as const, caption: '', source: 'sot'
  };
  const graph = {
    url: 'https://example.test/graph.png', altText: '', widthPx: null,
    placement: 'after' as const, caption: '<strong>Figure 1.</strong> Profile', source: 'sot'
  };

  expect(questionDescriptionHtml('<div>7. Study the pedigree.</div>', [pedigree])).toBe(
    '<div><img src="https://example.test/pedigree.png" alt=""></div><div>7. Study the pedigree.</div>'
  );
  expect(questionDescriptionHtml('<div>4. Which explanation applies?</div>', [graph])).toBe(
    '<div>4. Which explanation applies?</div>' +
    '<div><img src="https://example.test/graph.png" alt=""></div><div><strong>Figure 1.</strong> Profile</div>'
  );
  expect(questionDescriptionHtml('<div>Stem</div>', [graph, pedigree])).toBe(
    '<div><img src="https://example.test/pedigree.png" alt=""></div><div>Stem</div>' +
    '<div><img src="https://example.test/graph.png" alt=""></div><div><strong>Figure 1.</strong> Profile</div>'
  );
});

test('a figure printed above the stem sits below the case narrative that introduces it', () => {
  const karyotype = { url: 'https://example.test/karyotype.png', caption: '', altText: '', widthPx: null, placement: 'before' as const, source: 'sot' };
  const prompt =
    '<div><strong><u>Case 6</u></strong></div>' +
    '<div>A patient has been referred for fertility testing and has the resulting karyotype below:</div>' +
    '<div>11. What syndrome does the patient have?</div>';
  // The figure goes between the narrative and the stem, exactly where the document prints it.
  expect(questionDescriptionHtml(prompt, [karyotype])).toBe(
    '<div><strong><u>Case 6</u></strong></div>' +
    '<div>A patient has been referred for fertility testing and has the resulting karyotype below:</div>' +
    '<div><img src="https://example.test/karyotype.png" alt=""></div>' +
    '<div>11. What syndrome does the patient have?</div>'
  );
});

test('a figure printed above the stem sits above its QUESTION heading', () => {
  const karyotype = { url: 'https://example.test/karyotype.png', caption: '', altText: '', widthPx: null, placement: 'before' as const, source: 'sot' };
  const prompt =
    '<div>The resulting karyotype is below:</div>' +
    '<div>QUESTION 11</div><div><br></div><div>What syndrome does the patient have?</div>';
  expect(questionDescriptionHtml(prompt, [karyotype])).toBe(
    '<div>The resulting karyotype is below:</div>' +
    '<div><img src="https://example.test/karyotype.png" alt=""></div>' +
    '<div>QUESTION 11</div><div><br></div><div>What syndrome does the patient have?</div>'
  );
});

test('waits for the activity dialog to render its question rows before matching one', async ({ page }) => {
  // LAMS fills #referencesTable after the activity frame loads. Counting rows straight away sees
  // an empty table and reports the question as missing, which is how a rerun on an already
  // written lesson failed.
  await page.setContent(`
    <table id="referencesTable"><tbody></tbody></table>
    <script>
      setTimeout(() => {
        document.querySelector('#referencesTable tbody').innerHTML =
          '<tr><td><span class="fw-semibold">Question 5</span></td></tr>' +
          '<tr><td><span class="fw-semibold">Question 6</span></td></tr>';
      }, 1200);
    </script>
  `);

  const row = await exactQuestionRow(page.mainFrame(), 'Question 6', 5000);
  await expect(row.locator('.fw-semibold')).toHaveText('Question 6');
});

test('still reports a question the activity does not hold', async ({ page }) => {
  await page.setContent('<table id="referencesTable"><tbody><tr><td><span class="fw-semibold">Question 5</span></td></tr></tbody></table>');

  await expect(exactQuestionRow(page.mainFrame(), 'Question 6', 1000)).rejects.toThrow('found 0');
});

test('opens a question row that LAMS\'s sticky footer is covering', async ({ page }) => {
  // The authoring footer is fixed to the bottom of the activity dialog, and a Bootstrap tooltip
  // follows the pointer, so a row scrolled to the bottom edge cannot be clicked where it lands.
  await page.setContent(`
    <style>
      body { margin: 0; height: 2000px; }
      #referencesTable { margin-top: 1400px; }
      .lams-authoring-footer { position: fixed; bottom: 0; left: 0; right: 0; height: 140px; background: #eee; }
      .tooltip { position: fixed; bottom: 150px; left: 0; right: 0; height: 60px; background: #333; }
    </style>
    <table id="referencesTable"><tbody>
      <tr><td><a class="edit-reference-link" href="#" onclick="window.edited = true; return false;">Edit</a></td></tr>
    </tbody></table>
    <div class="lams-authoring-footer"><div id="saveCancelButtons">Save</div></div>
    <div role="tooltip" class="tooltip show"><div class="tooltip-inner">Answer required</div></div>
  `);

  await clickRowControl(page.mainFrame().locator('#referencesTable tbody tr').first().locator('.edit-reference-link'), 3000);

  expect(await page.evaluate(() => (window as unknown as { edited?: boolean }).edited)).toBe(true);
});

test('waits for a question row to carry its title, not just to exist', async ({ page }) => {
  // The dialog draws its rows first and fills the titles a moment later, so a row can be present
  // while every title is still empty.
  await page.setContent(`
    <table id="referencesTable"><tbody>
      <tr><td><span class="fw-semibold"></span></td></tr>
      <tr><td><span class="fw-semibold"></span></td></tr>
    </tbody></table>
    <script>
      setTimeout(() => {
        const titles = document.querySelectorAll('#referencesTable .fw-semibold');
        titles[0].textContent = 'Question 1';
        titles[1].textContent = 'Question 2';
      }, 1200);
    </script>
  `);

  const row = await exactQuestionRow(page.mainFrame(), 'Question 2', 5000);
  await expect(row.locator('.fw-semibold')).toHaveText('Question 2');
});

test('every figure goes where the document printed it, above or below the stem', async () => {
  // A slot marks exactly where a figure was printed. Filling only the figures printed above the
  // stem left the ones printed below to pile up at the very end — under every label meant to sit
  // beneath them, and under the credit line that closes the prompt.
  const prompt =
    '<div>This is the coronary anatomy diagram:</div><!--sot-image-->' +
    '<div>QUESTION 16</div><div>Which ECG applies?</div>' +
    '<!--sot-image--><div>ECG A.</div><!--sot-image--><div>ECG B.</div>' +
    '<div>Credit for above diagrams: http://example.test/source</div>';
  const image = (id: string, placement: 'before' | 'after') => ({ url: `https://lams.test/${id}.png`, placement, caption: '', widthPx: null, altText: '', source: id });

  const html = questionDescriptionHtml(prompt, [image('coronary', 'before'), image('ecg-a', 'after'), image('ecg-b', 'after')]);

  // Each figure sits in its own slot, so each label follows the figure it names.
  expect(html.indexOf('coronary.png')).toBeLessThan(html.indexOf('QUESTION 16'));
  expect(html.indexOf('ecg-a.png')).toBeLessThan(html.indexOf('ECG A.'));
  expect(html.indexOf('ECG A.')).toBeLessThan(html.indexOf('ecg-b.png'));
  expect(html.indexOf('ecg-b.png')).toBeLessThan(html.indexOf('ECG B.'));
  // The credit closes the prompt, below the figures it credits.
  expect(html.indexOf('ECG B.')).toBeLessThan(html.indexOf('Credit for above diagrams'));
});

test('a Print View check names the line that is missing, not the whole prompt', async ({ page }) => {
  await page.setContent('<body>Question 1 QUESTION 1 The tracings below: Which tracing fits?</body>');
  const node = {
    title: 'AE Case 3 Q1',
    description: '',
    questions: [{
      number: 1, title: 'Question 1', type: 'essay' as const,
      promptHtml: '<div>QUESTION 1</div><div>The tracings below:</div><div>Note: CSFA is the control lane.</div><div>Which tracing fits?</div>',
      marks: 4, answerRequired: true as const, prefixSequentialLetters: false, multipleAnswersAllowed: false,
      saveAsNewVersion: true as const, selectLatestVersion: true as const, options: [], sourceQuestionNumber: 1,
      images: [], replaceSourceFigures: false, promptReplacements: []
    }]
  };

  // The one line the Print View lacks is what the failure names — not the whole prompt.
  await expect(verifyAEPrintContent(page, node, [])).rejects.toThrow(
    /omitted expected text: "Note: CSFA is the control lane."/
  );
});

test('a Print View check accepts figure captions between the prompt lines, but not lines out of order', async ({ page }) => {
  const node = (promptHtml: string) => ({
    title: 'AE Case 6 Q15', description: '',
    questions: [{
      number: 15, title: 'Question 15', type: 'essay' as const, promptHtml,
      marks: 4, answerRequired: true as const, prefixSequentialLetters: false, multipleAnswersAllowed: false,
      saveAsNewVersion: true as const, selectLatestVersion: true as const, options: [], sourceQuestionNumber: 15,
      images: [], replaceSourceFigures: false, promptReplacements: []
    }]
  });
  const prompt = '<div>Mr Kong fell in his kitchen.</div><div>QUESTION 15</div><div>Which diagram applies?</div>';

  // LAMS prints each figure's caption between the lines, so the prompt is not one unbroken run.
  await page.setContent('<body>Question 15 Mr Kong fell in his kitchen. Diagram A Diagram B QUESTION 15 Which diagram applies?</body>');
  await verifyAEPrintContent(page, node(prompt), []);

  await page.setContent('<body>Question 15 Which diagram applies? Mr Kong fell in his kitchen. QUESTION 15</body>');
  await expect(verifyAEPrintContent(page, node(prompt), [])).rejects.toThrow(/out of order/);
});
