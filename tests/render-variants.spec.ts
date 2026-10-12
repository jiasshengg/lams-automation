import { expect, test } from '@playwright/test';
import {
  asFinallyPrinted,
  emptyParagraphsAfter,
  paintedOut,
  shadedOver,
  unpaintableContent,
  withMarkedParagraphs,
  withPaintedBlocks,
  wordsPaintedOut
} from '../src/docx/render-variants.js';

const body = (inner: string) => `<w:document><w:body>${inner}</w:body></w:document>`;

test('shading a table fills every cell in schema order and moves nothing else', () => {
  const xml = '<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr><w:tcW w:w="100"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:t>Hb</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>9.7</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const shaded = shadedOver(xml);
  expect(shaded).toContain('<w:tcPr><w:tcW w:w="100"/><w:shd w:val="clear" w:color="auto" w:fill="000000"/><w:vAlign w:val="center"/></w:tcPr>');
  expect(shaded).toContain('<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="000000"/></w:tcPr><w:p><w:pPr>');
  expect(shaded).toContain('<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="000000"/><w:spacing w:after="0"/></w:pPr>');
  // Borders, widths and text are untouched: a border's width is part of the row height.
  expect(shaded).not.toContain('tcBorders');
  expect(shaded).toContain('<w:t>Hb</w:t>');
});

test('painting a figure out whitens its words in schema order and makes its drawings see-through', () => {
  const xml =
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:sz w:val="20"/><w:u w:val="single" w:color="00FF00"/></w:rPr><w:t>Label</w:t></w:r>' +
    '<w:r><w:drawing><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill><pic:spPr><a:xfrm/><a:prstGeom prst="rect"/><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></pic:spPr></pic:pic>' +
    '<wps:wsp><wps:spPr><a:prstGeom prst="line"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:extLst><a:ext uri="x"><a14:hiddenFill><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a14:hiddenFill></a:ext></a:extLst></wps:spPr>' +
    '<wps:txbx><w:txbxContent><w:p><w:r><w:t>A</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></w:r></w:p>';
  const painted = paintedOut(xml);
  expect(painted).toContain('<w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="20"/><w:u w:val="single"/></w:rPr>');
  expect(painted).toContain('<w:pPr><w:jc w:val="center"/><w:rPr><w:color w:val="FFFFFF"/></w:rPr></w:pPr>');
  expect(painted).toContain('<a:blip r:embed="rId5"><a:alphaModFix amt="0"/></a:blip>');
  expect(painted).toContain('<a:prstGeom prst="rect"/><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></pic:spPr>');
  // Office's own extension keeps the fill Word requires there.
  expect(painted).toContain('<a:prstGeom prst="line"/><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/><a:extLst><a:ext uri="x"><a14:hiddenFill><a:solidFill>');
  expect(painted).toContain('<w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>A</w:t></w:r>');
  // Painting only the words keeps the text-box label and the drawing itself.
  const words = wordsPaintedOut(xml);
  expect(words).toContain('<w:r><w:t>A</w:t></w:r>');
  expect(words).not.toContain('alphaModFix');
});

test('only the blocks asked for are painted, and a self-closing paragraph stays valid', () => {
  const xml = body('<w:p w14:paraId="1"/><w:p><w:r><w:t>keep</w:t></w:r></w:p><w:p><w:r><w:t>paint</w:t></w:r></w:p>');
  const painted = withPaintedBlocks(xml, [{ firstBlock: 2, lastBlock: 2 }], paintedOut);
  expect(painted).toContain('<w:p w14:paraId="1"/><w:p><w:r><w:t>keep</w:t></w:r></w:p>');
  expect(painted).toContain('<w:color w:val="FFFFFF"/></w:rPr><w:t>paint</w:t>');
});

test('names what cannot be painted out without moving anything', () => {
  expect(unpaintableContent('<w:r><w:drawing><c:chart r:id="rId9"/></w:drawing></w:r>')).toBe('a chart');
  expect(unpaintableContent('<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>')).toBe('an equation');
  expect(unpaintableContent('<w:r><w:pict><v:shape/></w:pict></w:r>')).toBe('a legacy (VML) drawing');
  // A legacy copy kept only as the fallback of a modern drawing is not read.
  expect(unpaintableContent('<mc:AlternateContent><mc:Choice><w:drawing/></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent>')).toBeNull();
});

test('marks take the paragraph size but always print black', () => {
  const xml = body('<w:p><w:r><w:drawing/></w:r></w:p><w:p><w:pPr><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="16"/></w:rPr></w:pPr></w:p><w:p/><w:p><w:r><w:t>Next</w:t></w:r></w:p>');
  expect(emptyParagraphsAfter(xml, 0, 10)).toEqual([1, 2]);
  const marked = withMarkedParagraphs(xml, [1, 2], 'bar');
  expect(marked).toContain('<w:r><w:rPr><w:color w:val="000000"/><w:sz w:val="16"/></w:rPr><w:t>|</w:t></w:r></w:p>');
  expect(marked).toContain('<w:p><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t>|</w:t></w:r></w:p>');
  expect(withMarkedParagraphs(xml, [0], 'square')).toContain('<w:t>■</w:t>');
});

test('the copy shows the document as printed: changes accepted, comments gone', () => {
  const xml = '<w:p><w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>gone</w:delText></w:r></w:del><w:commentRangeStart w:id="3"/><w:r><w:t>kept</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p>';
  expect(asFinallyPrinted(xml)).toBe('<w:p><w:r><w:t>added</w:t></w:r><w:r><w:t>kept</w:t></w:r></w:p>');
});
