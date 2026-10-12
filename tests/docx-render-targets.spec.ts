import { expect, test } from '@playwright/test';
import { readZipEntries } from '../src/docx/archive.js';
import { findRenderTargets, readParagraphBlockIndexes } from '../src/docx/render-targets.js';
import { bookmarkedCopy } from '../src/docx/word-render.js';
import { writeZipEntries } from '../src/docx/zip-writer.js';
import { drawing, groupedDrawing, mediaDocx, paragraph } from './helpers/docx-media.js';

const table = (...rows: string[][]) =>
  `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows
    .map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
    .join('')}</w:tbl>`;

/** A floating arrow anchored in a line of text, with no picture of its own. */
const floatingArrow = '<w:r><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wps:wsp><wps:spPr/></wps:wsp></wp:anchor></w:drawing></w:r>';

test('finds every table and drawn figure, but not a plain picture', () => {
  const xml =
    paragraph('1. Read the results.') +
    table(['Test', 'Result'], ['Hb', '9.7']) +
    paragraph('', drawing) +
    paragraph('Figure 1. A plain photograph') +
    paragraph('', groupedDrawing) +
    paragraph('2. Next question?');
  expect(findRenderTargets(xml)).toEqual([
    { id: 'b1', kind: 'table', firstBlock: 1, lastBlock: 1, hasPictures: false },
    { id: 'b4', kind: 'figure', firstBlock: 4, lastBlock: 4, hasPictures: true }
  ]);
});

test('drawing paragraphs with only empty lines between them are one figure, as the page lays them out', () => {
  const label = '<w:r><w:drawing><wp:anchor><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>2000X</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wp:anchor></w:drawing></w:r>';
  const xml = paragraph('Refer to films A to H.') + paragraph('', drawing) + '<w:p/><w:p/>' + paragraph('', label) + '<w:p/>' + paragraph('', drawing) + paragraph('1. Which film?');
  expect(findRenderTargets(xml)).toEqual([{ id: 'b1-6', kind: 'figure', firstBlock: 1, lastBlock: 6, hasPictures: true }]);
  // Pictures with nothing drawn on them are uploaded as they are.
  expect(findRenderTargets(paragraph('', drawing) + '<w:p/>' + paragraph('', drawing))).toEqual([]);
});

test('an arrow anchored in the caption below a picture takes in the picture it is drawn over', () => {
  const xml = paragraph('', drawing) + '<w:p/>' + paragraph('Figure 1A. Chest radiograph', floatingArrow);
  expect(findRenderTargets(xml)).toEqual([{ id: 'b0-2', kind: 'figure', firstBlock: 0, lastBlock: 2, hasPictures: true }]);
});

test('a table that carries its own answer key is not rendered', () => {
  expect(findRenderTargets(table(['Drug', 'Effect'], ['Answer: B', '']))).toEqual([]);
});

test('maps every paragraph the image reader counts to its block', () => {
  const xml = paragraph('one') + table(['a', 'b'], ['c', 'd']) + paragraph('two');
  expect(readParagraphBlockIndexes(xml)).toEqual([0, 1, 1, 1, 1, 2]);
});

test('writes a ZIP the DOCX reader reads back unchanged', () => {
  const entries = new Map([['word/document.xml', Buffer.from('<w:document>é</w:document>')], ['a/b.bin', Buffer.from([0, 1, 2, 255])]]);
  expect(readZipEntries(writeZipEntries(entries))).toEqual(entries);
});

test('bookmarks each target for Word and removes the highlighting inside it only', () => {
  const highlighted = '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>key</w:t></w:r></w:p>';
  const highlightedTable = `<w:tbl><w:tr><w:tc>${highlighted}</w:tc><w:tc>${paragraph('y')}</w:tc></w:tr></w:tbl>`;
  const docx = mediaDocx(highlighted + highlightedTable);
  const target = { id: 'b1', kind: 'table' as const, firstBlock: 1, lastBlock: 1, hasPictures: false };
  const copy = readZipEntries(bookmarkedCopy(docx, [{ target, name: '_LamsRender1', id: 990000 }]));
  const xml = copy.get('word/document.xml')!.toString('utf8');
  expect(xml).toMatch(/<w:bookmarkStart w:id="990000" w:name="_LamsRender1"\/><w:tbl>[\s\S]*<\/w:tbl><w:bookmarkEnd w:id="990000"\/>/);
  // The paragraph outside the target keeps its highlight; the table loses its own.
  expect(xml.match(/<w:highlight/g)).toHaveLength(1);
  expect(copy.get('word/media/chart.png')).toEqual(readZipEntries(docx).get('word/media/chart.png'));
});
