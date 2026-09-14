import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { IratRequest } from '../src/config.js';
import { LamsIratEditor, canonicalInlineHtml, formattingProblems, inlineHtml, missingInlineFormatting, verifySavedRequiredFlags } from '../src/lams/irat-editor.js';

const request: IratRequest = {
  activityName: 'iRAT', teamSetupName: 'Team Setup',
  gate: { name: 'iRAT Gate', description: 'iRAT Gate', type: 'password', dynamicPassword: true, rotationSeconds: 10 },
  questions: [],
  advanced: { shuffleQuestions: false, shuffleAnswers: true, questionsNumbering: true, displayAllQuestions: true, displayAllAfterCompletion: true, answerJustification: false, confidenceLevels: false }
};

// Local UI fixture follows the observed live iRAT: Create menu, initNewReference iframe,
// four initial answers, collapsed advanced controls, and separate Save / Save as new version.
// It deliberately removes the old edit iframe but merely hides the creation modal.
// `transform` mimics an editor that rewrites the HTML it is given, as LAMS can when a profile carries font defaults.
async function fixture(
  page: Page,
  existing = false,
  versionSave = true,
  transform = 'value => value',
  toggleDelayMs = 0,
  syncPromptOnQuestionSave = false
) {
  await page.route('https://irat.test/**', async route => {
    const toggle = /\/toggleQuestionRequired\.do\?next=(true|false)/.exec(route.request().url());
    if (toggle) {
      if (toggleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, toggleDelayMs));
      await route.fulfill({ contentType: 'text/plain', body: toggle[1]! });
      return;
    }
    if (route.request().url() === 'https://irat.test/') {
      await route.fulfill({ contentType: 'text/html', body: `
        <button onclick="document.querySelector('#menu').hidden=false">Create question</button>
        <div id="menu" hidden><button onclick="openQuestion(false)">Multiple choice</button></div>
        <table id="referencesTable"><tbody></tbody></table>
        <div id="qb-question-authoring-modal" hidden></div>
        <script>
          window.saves=[];
          function row(title) {
            const tr = document.createElement('tr');
            tr.innerHTML='<td><span class="fw-semibold"></span></td><td><input class="max-mark-input" value="1"></td><td><button class="text-danger" onclick="toggleQuestionRequired(this)">Answer required</button><button class="edit-reference-link" onclick="openQuestion(true)">Edit</button></td>';
            tr.querySelector('span').textContent=title;
            return tr;
          }
          // Mirrors LAMS: the stored value comes back from the server, and the class is
          // only stamped when the reply matches what the handler predicted.
          async function toggleQuestionRequired(button) {
            const predicted = !button.classList.contains('text-danger');
            const reply = await (await fetch('/toggleQuestionRequired.do?next=' + predicted)).text();
            const stored = reply === 'true';
            if (stored === predicted) {
              button.classList.toggle('text-danger', stored);
              button.classList.toggle('text-muted', !stored);
            }
          }
          function openQuestion(existing) {
            const modal=document.querySelector('#qb-question-authoring-modal');
            modal.hidden=false; modal.className='show';
            modal.innerHTML='<iframe src="/'+(existing?'editReference.do':'initNewReference.do')+'"></iframe>';
          }
          function saved(data, existing) {
            window.saves.push(data);
            const modal=document.querySelector('#qb-question-authoring-modal');
            modal.hidden=true; modal.className='';
            if(existing) modal.innerHTML='';
            // Simulate the asynchronous reference-list refresh after modal dismissal.
            setTimeout(()=> { if(!existing) document.querySelector('tbody').append(row(data.title)); }, 40);
          }
          ${existing ? "document.querySelector('tbody').append(row('Question 1'));" : ''}
        </script>` });
      return;
    }
    const editing = route.request().url().includes('editReference');
    await route.fulfill({ contentType: 'text/html', body: `
      <form id="assessmentQuestionForm" onsubmit="return false">
        <input id="title"><textarea id="description"></textarea>
        <a onclick="addOption()">Add another answer</a><div id="options"></div>
        <button data-bs-target="#advancedSettingsCollapse" onclick="document.querySelector('#advancedSettingsCollapse').hidden=false">Advanced settings</button>
        <div id="advancedSettingsCollapse" hidden><input id="maxMark"><select id="multipleAnswersAllowed"><option value="false">One</option><option value="true">Multiple</option></select><input type="checkbox" id="prefixAnswersWithLetters"></div>
        <button onclick="initEditor('feedback')">Feedback for students (optional)</button>
        ${editing && versionSave ? '<button id="saveAsButton" onclick="save(true)">Save as new version</button>' : ''}
        <button id="saveButton" onclick="save(false)">Save</button>
      </form>
      <script>
        window.CKEDITOR={instances:{}};
        const transform=${transform};
        function initEditor(id) { CKEDITOR.instances[id]={setData(value){this.data=transform(value)},getData(){return this.data??""},fire(){}}; }
        initEditor('description');
        function addOption(){
          const index=document.querySelectorAll('.single-option-table').length;
          const div=document.createElement('div'); div.className='single-option-table';
          div.innerHTML='Answer <input type="hidden" id="optionMaxMark'+index+'"><button class="delete-button" style="display:none">Delete</button>';
          div.querySelector('button').onclick=()=>{if(confirm('Delete this answer?'))div.remove()};
          document.querySelector('#options').append(div); initEditor('optionName'+index);
        }
        for(let i=0;i<4;i++)addOption();
        function save(version){
          const data={title:document.querySelector('#title').value, version, marks:document.querySelector('#maxMark').value,
            multiple:document.querySelector('#multipleAnswersAllowed').value,
            prefix:document.querySelector('#prefixAnswersWithLetters').checked,
            weights:Array.from(document.querySelectorAll('[id^="optionMaxMark"]')).map(e=>e.value),
            content:CKEDITOR.instances.description.data,feedback:CKEDITOR.instances.feedback?.data,
            answers:Array.from(document.querySelectorAll('.single-option-table')).map((_,i)=>CKEDITOR.instances['optionName'+i].data)};
          if(!data.title || !data.content || data.answers.some(a=>!a))throw Error('Incomplete question');
          if(${syncPromptOnQuestionSave} && !confirm("You've made edits to the questions. Sync with the matching tRAT?")) return;
          parent.saved(data,${editing});
        }
      </script>` });
  });
  await page.goto('https://irat.test/');
  const editor = new LamsIratEditor(page, request, 1500);
  // Supply a ready activity frame, isolating question UI behavior from graph navigation.
  Object.assign(editor, { activityFrame: page.mainFrame() });
  return editor;
}

for (const count of [2, 5, 6]) {
  test(`creates a new MCQ with ${count} answers, scoring, formatting and feedback`, async ({ page }) => {
    const editor = await fixture(page);
    const multiple = count === 6;
    const question = {
      title: 'Question 1', type: 'multiple-choice', marks: 2, content: 'H<sub>2</sub>O and 10<sup>9</sup>',
      feedback: 'Supplied rationale', prefixAnswersWithLetters: true, mandatory: false,
      answers: Array.from({ length: count }, (_, i) => ({ text: `Answer ${i+1}`, correct: multiple ? i < 2 : i === 0, weight: multiple ? (i < 2 ? 50 : 0) : (i === 0 ? 100 : 0) }))
    };
    await editor.createQuestion(question);
    const saves = await page.evaluate(() => (window as unknown as { saves: Record<string, unknown>[] }).saves);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ version: false, marks: '2', prefix: true, multiple: String(multiple), weights: question.answers.map(answer=>String(answer.weight/100)) });
    expect(saves[0]!.content).toContain('H<sub>2</sub>O and 10<sup>9</sup>');
    expect(saves[0]!.feedback).toContain('Supplied rationale');
    await expect(page.locator('#referencesTable tbody tr')).toHaveCount(1);
    await expect(page.locator('.max-mark-input')).toHaveValue('2');
    // Creating a question no longer touches "answer required"; the separate pass does.
    await expect(page.getByRole('button', { name: 'Answer required', exact: true })).toHaveClass('text-danger');
    await editor.applyAnswerRequired([question]);
    await expect(page.getByRole('button', { name: 'Answer required', exact: true })).toHaveClass('text-muted');
    await expect(editor.createQuestion(question)).rejects.toThrow('no existing');
  });
}

test('existing questions still require Save as new version', async ({ page }) => {
  const editor = await fixture(page, true);
  await editor.updateQuestion({ title: 'Question 1', type: 'multiple-choice', marks: 1, content: 'Updated', mandatory: true, answers: [{ text: 'Yes', correct: true, weight: 100 }, { text: 'No', correct: false, weight: 0 }] });
  expect(await page.evaluate(() => (window as unknown as { saves: {version:boolean}[] }).saves.map(s=>s.version))).toEqual([true]);
});

for (const existing of [false, true]) {
  test(`confirms the tRAT sync prompt raised by an ${existing ? 'existing' : 'new'} question save`, async ({ page }) => {
    const editor = await fixture(page, existing, true, 'value => value', 0, true);
    const question = {
      title: 'Question 1', type: 'multiple-choice', marks: 1, content: 'Synced', mandatory: true,
      answers: [{ text: 'Yes', correct: true, weight: 100 }, { text: 'No', correct: false, weight: 0 }]
    };
    if (existing) await editor.updateQuestion(question);
    else await editor.createQuestion(question);
    expect(editor.confirmedDialogs).toEqual([
      "You've made edits to the questions. Sync with the matching tRAT?"
    ]);
    expect(await page.evaluate(() => (window as unknown as { saves: unknown[] }).saves)).toHaveLength(1);
  });
}

test('never falls back to shared-question Save if version Save is missing', async ({ page }) => {
  const editor = await fixture(page, true, false);
  await expect(editor.updateQuestion({ title: 'Question 1', type: 'multiple-choice', marks: 1, content: 'Updated', mandatory: true, answers: [{ text: 'Yes', correct: true, weight: 100 }, { text: 'No', correct: false, weight: 0 }] })).rejects.toThrow('refusing to save the shared question');
  expect(await page.evaluate(() => (window as unknown as { saves: unknown[] }).saves)).toEqual([]);
});

test('scientific formatting preserves sub/sup but never active markup or attributes', () => {
  expect(inlineHtml('10<sup>9</sup> H<sub>2</sub>O <img src=x onerror=alert(1)>')).toContain('10<sup>9</sup> H<sub>2</sub>O');
  expect(inlineHtml('<b onclick="alert(1)">text</b>')).not.toContain('onclick');
});

test('writes questions without any font or size styling and keeps SoT inline formatting', async ({ page }) => {
  const editor = await fixture(page);
  await editor.createQuestion({
    title: 'Question 1', type: 'multiple-choice', marks: 1, mandatory: true,
    content: 'The <em>lac</em> operon is <strong>repressed</strong> by <u>glucose</u>',
    answers: [{ text: '<i>True</i>', correct: true, weight: 100 }, { text: 'False', correct: false, weight: 0 }]
  });
  const saves = await page.evaluate(() => (window as unknown as { saves: Record<string, unknown>[] }).saves);
  expect(saves[0]!.content).toBe('The <em>lac</em> operon is <strong>repressed</strong> by <u>glucose</u>');
  expect(saves[0]!.answers).toEqual(['<i>True</i>', 'False']);
  expect(JSON.stringify(saves[0])).not.toMatch(/font-family|font-size|<span/);
});

test('stops when the editor re-applies a font instead of the LAMS default', async ({ page }) => {
  const editor = await fixture(page, false, true, 'value => \'<span style="font-family:Arial;font-size:12px">\' + value + \'</span>\'');
  await expect(editor.createQuestion({
    title: 'Question 1', type: 'multiple-choice', marks: 1, mandatory: true, content: 'Plain',
    answers: [{ text: 'Yes', correct: true, weight: 100 }, { text: 'No', correct: false, weight: 0 }]
  })).rejects.toThrow('explicit font family or size is present');
  expect(await page.evaluate(() => (window as unknown as { saves: unknown[] }).saves)).toEqual([]);
});

test('stops when the editor drops SoT inline formatting', async ({ page }) => {
  const editor = await fixture(page, false, true, 'value => value.replace(/<\\/?em>/g, "")');
  await expect(editor.createQuestion({
    title: 'Question 1', type: 'multiple-choice', marks: 1, mandatory: true, content: 'The <em>lac</em> operon',
    answers: [{ text: 'Yes', correct: true, weight: 100 }, { text: 'No', correct: false, weight: 0 }]
  })).rejects.toThrow('<em> formatting of "lac" was lost');
});

test('formatting verification tolerates CKEditor serialisation differences', () => {
  expect(formattingProblems('<p>The <strong>lac</strong>&nbsp;operon <b>is</b><br />\n<i>fine</i></p>', 'The <b>lac</b> operon <strong>is</strong><br><em>fine</em>')).toEqual([]);
  expect(formattingProblems('<h2>Heading</h2>', 'Heading')).toEqual(['a heading, font, or block format is present']);
  expect(formattingProblems('<p><span style="font-size:14px">x</span></p>', 'x')).toEqual(['explicit font family or size is present']);
  expect(canonicalInlineHtml('<B class="x">a</B>  <I>b</I>')).toBe('<strong>a</strong> <em>b</em>');
});

test('tRAT Print View formatting check detects a lost inline tag', () => {
  const printable = canonicalInlineHtml('<p>The lac operon has H<sub>2</sub>O</p>');
  expect(missingInlineFormatting(printable, 'The <em>lac</em> operon has H<sub>2</sub>O')).toEqual([
    '<em>lac</em>'
  ]);
  expect(missingInlineFormatting(printable, 'H<sub>2</sub>O')).toEqual([]);
});

// Activity-level settings mirror the observed card layout: everything sits behind
// "Expand all", the Advanced toggles carry stable ids, and the Feedback & Results
// checkbox is wrapped by its label with a description block, as in the AE adapter.
async function settingsFixture(page: Page, initialChecked: boolean) {
  const checked = initialChecked ? 'checked' : '';
  await page.setContent(`
    <button id="expandAllButton" onclick="document.querySelectorAll('.card').forEach(c => c.hidden = false)">Expand all</button>
    <div class="card" hidden>
      <input type="radio" name="questionDistributionType" id="questionDistributionTypeAll"><label for="questionDistributionTypeAll">All questions</label>
      <input type="checkbox" id="shuffled" ${checked}><input type="checkbox" id="shuffledAnswers" ${checked}>
      <input type="checkbox" id="questions-numbering" ${checked}>
    </div>
    <div class="card" hidden>
      <label><input type="checkbox" id="displaySummary" ${checked}> Display all questions and answers once the student finishes.<div class="text-muted">Shown after submission</div></label>
    </div>
    <div class="card" hidden>
      <input type="checkbox" id="allowAnswerJustification" ${checked}><input type="checkbox" id="enable-confidence-levels" ${checked}>
    </div>`);
  const editor = new LamsIratEditor(page, request, 1500);
  Object.assign(editor, { activityFrame: page.mainFrame() });
  return editor;
}

for (const initial of [false, true]) {
  test(`turns every deployment-guide iRAT setting on from an initially ${initial ? 'enabled' : 'disabled'} activity`, async ({ page }) => {
    const editor = await settingsFixture(page, initial);
    await editor.updateAdvancedSettings({
      shuffleQuestions: true, shuffleAnswers: true, questionsNumbering: true, displayAllQuestions: true,
      displayAllAfterCompletion: true, answerJustification: true, confidenceLevels: true
    });
    for (const id of ['shuffled', 'shuffledAnswers', 'questions-numbering', 'displaySummary', 'allowAnswerJustification', 'enable-confidence-levels', 'questionDistributionTypeAll']) {
      await expect(page.locator('#' + id), id).toBeChecked();
    }
  });
}

test('stops when the Feedback & Results checkbox cannot be found exactly once', async ({ page }) => {
  const editor = await settingsFixture(page, false);
  await page.evaluate(() => document.querySelector('#displaySummary')!.closest('label')!.remove());
  await expect(editor.updateAdvancedSettings({
    shuffleQuestions: true, shuffleAnswers: true, questionsNumbering: true, displayAllQuestions: true,
    displayAllAfterCompletion: true, answerJustification: true, confidenceLevels: true
  })).rejects.toThrow('found 0');
});

test('a slow toggle reply is read once instead of being clicked again', async ({ page }) => {
  // LAMS stamps no class until its reply lands. Polling for the class and clicking again
  // flipped the stored flag straight back, which is how most questions lost the setting.
  const editor = await fixture(page, true, true, 'value => value', 800);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('toggleQuestionRequired.do')) requests.push(request.url());
  });

  const changed = await editor.applyAnswerRequired([
    { title: 'Question 1', type: 'multiple-choice', marks: 1, content: 'x', mandatory: false, answers: [] }
  ]);

  expect(changed).toEqual(['Question 1']);
  expect(requests).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Answer required', exact: true })).toHaveClass('text-muted');
});

test('a question already in the requested state is never toggled', async ({ page }) => {
  const editor = await fixture(page, true);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('toggleQuestionRequired.do')) requests.push(request.url());
  });

  // The fixture row renders as required, which is what the request asks for.
  const changed = await editor.applyAnswerRequired([
    { title: 'Question 1', type: 'multiple-choice', marks: 1, content: 'x', mandatory: true, answers: [] }
  ]);

  expect(changed).toEqual([]);
  expect(requests).toEqual([]);
});

test('required-only dry run reports a difference without sending a toggle request', async ({ page }) => {
  const editor = await fixture(page, true);
  const requests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('toggleQuestionRequired.do')) requests.push(request.url());
  });
  const question = { ...request.questions[0]!, title: 'Question 1', mandatory: false };
  expect(await editor.applyAnswerRequired([question], { commit: false })).toEqual(['Question 1']);
  expect(requests).toEqual([]);
  await expect(page.getByRole('button', { name: 'Answer required', exact: true })).toHaveClass('text-danger');
});

test('required-only preflight rejects a missing later question before toggling the first', async ({ page }) => {
  const editor = await fixture(page, true);
  const requests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('toggleQuestionRequired.do')) requests.push(request.url());
  });
  const question = { ...request.questions[0]!, title: 'Question 1', mandatory: false };
  await expect(editor.applyAnswerRequired([question, { ...question, title: 'Missing' }])).rejects.toThrow('preflight failed');
  expect(requests).toEqual([]);
});

for (const mandatory of [true, false]) {
  test(`post-save verification rejects a reverted required flag (expected=${mandatory})`, () => {
    const question = { ...request.questions[0]!, title: 'Question 1', mandatory };
    expect(() => verifySavedRequiredFlags([
      { title: question.title, type: 'multiple-choice', mandatory: !mandatory }
    ], [question])).toThrow('Post-save answer-required verification failed');
    expect(() => verifySavedRequiredFlags([
      { title: question.title, type: 'multiple-choice', mandatory }
    ], [question])).not.toThrow();
  });
}
