import { expect, test } from '@playwright/test';
import {
  inlineHtmlToText,
  renderInlineSegments,
  sanitizeInlineHtml,
  sliceInlineHtml,
  stripOptionPrefixHtml,
  withoutUniformInlineTag
} from '../src/ae/inline-html.js';

test('keeps allowlisted emphasis and escapes every other tag', () => {
  expect(sanitizeInlineHtml('For this <u>highly albumin-bound</u> drug')).toBe(
    'For this <u>highly albumin-bound</u> drug'
  );
  expect(sanitizeInlineHtml('10<sup>9</sup> and C<sub>trough</sub>')).toBe('10<sup>9</sup> and C<sub>trough</sub>');
  expect(sanitizeInlineHtml('<b>bold</b> and <i>italic</i>')).toBe('<strong>bold</strong> and <em>italic</em>');
  expect(sanitizeInlineHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(sanitizeInlineHtml('<a href="https://example.test">link</a>')).toBe(
    '&lt;a href=&quot;https://example.test&quot;&gt;link&lt;/a&gt;'
  );
});

test('escapes bare punctuation that only looks like markup', () => {
  expect(sanitizeInlineHtml('Compare 1 < 2 > 0 for "A & B"')).toBe(
    'Compare 1 &lt; 2 &gt; 0 for &quot;A &amp; B&quot;'
  );
});

test('balances stray and crossed tags instead of emitting them verbatim', () => {
  expect(sanitizeInlineHtml('<u>unclosed')).toBe('<u>unclosed</u>');
  expect(sanitizeInlineHtml('plain</u> tail')).toBe('plain tail');
  expect(inlineHtmlToText('<strong><em>crossed</strong></em>')).toBe('crossed');
});

test('decodes an entity exactly once so reviewed JSON round-trips', () => {
  expect(inlineHtmlToText('Ms Tan&#39;s results &amp; notes')).toBe("Ms Tan's results & notes");
  expect(sanitizeInlineHtml('Ms Tan&#39;s results &amp; notes')).toBe('Ms Tan&#39;s results &amp; notes');
});

test('slices formatted text by visible character offsets', () => {
  const html = 'A. <strong>600</strong> mg per dose';
  expect(sliceInlineHtml(html, 3, 9)).toBe('<strong>600</strong> mg');
  expect(inlineHtmlToText(html)).toBe('A. 600 mg per dose');
});

test('removes an answer-letter prefix but never an option that starts with its own identifier', () => {
  expect(stripOptionPrefixHtml('B.  <strong>600</strong> mg')).toBe('<strong>600</strong> mg');
  expect(stripOptionPrefixHtml('A) First option')).toBe('First option');
  // Pedigree options open with "I:1"; requiring whitespace after the separator keeps them whole.
  expect(stripOptionPrefixHtml('I:1 and I:2')).toBe('I:1 and I:2');
  expect(stripOptionPrefixHtml('III:1, III:2 and III:3')).toBe('III:1, III:2 and III:3');
});

test('drops a tag that covers a whole option and keeps emphasis inside one', () => {
  expect(withoutUniformInlineTag('<strong>The unbound concentration</strong>', 'strong')).toBe(
    'The unbound concentration'
  );
  expect(withoutUniformInlineTag('increase in <strong>TERT</strong> expression', 'strong')).toBe(
    'increase in <strong>TERT</strong> expression'
  );
});

test('renders observed formatting runs with stable, merged nesting', () => {
  expect(
    renderInlineSegments([
      { text: 'Figure 1.', tags: ['strong'] },
      { text: ' ', tags: [] },
      { text: 'Plasma', tags: [] },
      { text: ' profile', tags: [] }
    ])
  ).toBe('<strong>Figure 1.</strong> Plasma profile');
  expect(renderInlineSegments([{ text: 'Case 2', tags: ['u', 'strong'] }])).toBe('<strong><u>Case 2</u></strong>');
});
