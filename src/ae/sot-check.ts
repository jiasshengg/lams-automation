import { readFile } from 'node:fs/promises';
import { resolveInputFile } from '../input-file.js';
import { buildAEDraft } from './draft.js';
import { buildAEPlan, type AEPlan } from './plan.js';
import { analyzeAESOT, extractSOTParagraphs, readSOTDocxParts, type AESOTAnalysis } from './sot-docx.js';

export const SKIP_SOT_CHECK_FLAG = '--skip-sot-check';

/**
 * Lists every way a reviewed AE plan departs from its Source-of-Truth: node titles, node and
 * question structure, prompts (paragraphs, blank lines, emphasis, tables), and options.
 *
 * Answer keys, marks, and weights are not compared: resolving those is what review is for.
 */
export function compareAEPlanToSOT(plan: AEPlan, analysis: AESOTAnalysis): string[] {
  const expected = expectedPlan(analysis, plan);
  if (plan.nodes.length !== expected.nodes.length) {
    return [`The AE JSON has ${count(plan.nodes.length, 'AE node')}; the Source-of-Truth has ${expected.nodes.length}.`];
  }
  const differences: string[] = [];
  plan.nodes.forEach((node, nodeIndex) => {
    const source = expected.nodes[nodeIndex]!;
    if (node.title !== source.title) {
      differences.push(`Node ${nodeIndex + 1} title is "${node.title}"; the Source-of-Truth names it "${source.title}".`);
    }
    const numbers = node.questions.map((question) => question.number).join(', ');
    const sourceNumbers = source.questions.map((question) => question.number).join(', ');
    if (numbers !== sourceNumbers) {
      differences.push(`Node ${nodeIndex + 1} holds questions ${numbers}; the Source-of-Truth puts ${sourceNumbers} there.`);
      return;
    }
    node.questions.forEach((question, questionIndex) => {
      const sourceQuestion = source.questions[questionIndex]!;
      if (question.type !== sourceQuestion.type) {
        differences.push(`Question ${question.number} is ${question.type}; the Source-of-Truth makes it ${sourceQuestion.type}.`);
      }
      if (question.promptHtml !== sourceQuestion.promptHtml) {
        differences.push(
          `Question ${question.number} prompt differs from the Source-of-Truth.\n    JSON: ${question.promptHtml}\n    SoT:  ${sourceQuestion.promptHtml}`
        );
      }
      if (question.options.length !== sourceQuestion.options.length) {
        differences.push(`Question ${question.number} has ${count(question.options.length, 'option')}; the Source-of-Truth has ${sourceQuestion.options.length}.`);
        return;
      }
      question.options.forEach((option, optionIndex) => {
        const sourceOption = sourceQuestion.options[optionIndex]!;
        if (option.html !== sourceOption.html) {
          differences.push(`Question ${question.number} option ${optionIndex + 1} differs: JSON "${option.html}", SoT "${sourceOption.html}".`);
        }
      });
    });
  });
  return differences;
}

/**
 * Refuses a plan that does not follow its Source-of-Truth, before anything is written to LAMS.
 * A hand-written or stale AE JSON is exactly how node titles, blank lines, and tables go missing.
 */
export async function assertAEPlanMatchesSOT(plan: AEPlan, argv: readonly string[] = process.argv): Promise<void> {
  if (argv.includes(SKIP_SOT_CHECK_FLAG)) {
    console.warn(`${SKIP_SOT_CHECK_FLAG}: the AE JSON is NOT being compared with its Source-of-Truth.`);
    return;
  }
  const regenerate = "Generate the AE JSON from the document with: npm run extract:ae-sot -- --sot-docx '<AE SOT.docx>' --draft '<AE JSON>'";
  if (!plan.sourceDocx) {
    throw new Error(`The AE JSON names no sourceDocx, so it cannot be checked against the AE Source-of-Truth. ${regenerate}`);
  }
  const { documentXml, ...layout } = readSOTDocxParts(await readFile(await resolveInputFile(plan.sourceDocx, '.docx')));
  const analysis = analyzeAESOT(extractSOTParagraphs(documentXml, layout), plan.sourceLabel, {
    columnQuestions: plan.columnQuestions === true
  });
  const differences = compareAEPlanToSOT(plan, analysis);
  if (differences.length > 0) {
    throw new Error(
      `The AE JSON does not follow ${plan.sourceDocx}:\n- ${differences.join('\n- ')}\n${regenerate}\n` +
        `Only if the difference is intentional, rerun with ${SKIP_SOT_CHECK_FLAG}.`
    );
  }
  console.log(`AE JSON matches ${plan.sourceDocx}: node titles, prompts, tables, and options follow the document.`);
}

/** The plan a fresh draft of the document produces, with any unstated answer key filled so it builds. */
function expectedPlan(analysis: AESOTAnalysis, plan: AEPlan): AEPlan {
  const draft = buildAEDraft(analysis);
  // A question whose figure the reviewer replaced is read the same way on both sides, so the
  // comparison still covers every word around the figure it could not reproduce.
  const reviewed = new Map(plan.nodes.flatMap((node) => node.questions).map((question) => [question.number, question]));
  const replaced = new Set([...reviewed.values()].filter((question) => question.replaceSourceFigures).map((question) => question.number));
  for (const question of draft.nodes.flatMap((node) => node.questions)) {
    if (question.options && !question.options.some((option) => option.correct)) question.options[0]!.correct = true;
    if (replaced.has(question.number)) (question as { replaceSourceFigures?: boolean }).replaceSourceFigures = true;
    const declared = reviewed.get(question.number)?.promptReplacements ?? [];
    if (declared.length > 0) {
      (question as { promptReplacements?: { find: string; replaceWith: string }[] }).promptReplacements = declared;
    }
  }
  try {
    // Credit is not compared, so either multiple-answer choice builds the same prompts and options.
    return buildAEPlan({ ...draft, multipleAnswerCredit: 'split' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The AE Source-of-Truth could not be transcribed for comparison: ${reason}. Rerun with ${SKIP_SOT_CHECK_FLAG} after checking the JSON by hand.`);
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
