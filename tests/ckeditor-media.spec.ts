import { expect, test } from '@playwright/test';
import { imageHtml, parseCkEditorUploadResponse, withUploadCallback } from '../src/lams/ckeditor-media.js';

test('parses modern and legacy CKEditor upload responses', () => {
  expect(parseCkEditorUploadResponse('{"uploaded":1,"url":"/content/image.png"}')).toBe('/content/image.png');
  expect(parseCkEditorUploadResponse('<script>window.parent.CKEDITOR.tools.callFunction(7, "/content/a.jpg", "")</script>'))
    .toBe('/content/a.jpg');
});

test('renders uploaded images with escaped alt text and bounded width', () => {
  expect(imageHtml([{ url: 'https://example.test/a.png?a=1&b=2', altText: 'A "chart"', widthPx: 2000, placement: 'after' as const, caption: '', source: 'test' }]))
    .toBe('<div><img src="https://example.test/a.png?a=1&amp;b=2" alt="A &quot;chart&quot;" width="1200"></div>');
});

test('renders only the images printed on the requested side of the question stem', () => {
  const images = [
    { url: 'https://example.test/pedigree.png', altText: '', widthPx: null, placement: 'before' as const, caption: '', source: 'sot' },
    { url: 'https://example.test/graph.png', altText: '', widthPx: null, placement: 'after' as const, caption: '<strong>Figure 1.</strong> Profile', source: 'sot' }
  ];
  expect(imageHtml(images, 'before')).toBe('<div><img src="https://example.test/pedigree.png" alt=""></div>');
  expect(imageHtml(images, 'after')).toBe(
    '<div><img src="https://example.test/graph.png" alt=""></div><div><strong>Figure 1.</strong> Profile</div>'
  );
  expect(imageHtml(images)).toContain('pedigree.png');
});

test('adds the upload callback LAMS needs, without re-encoding CurrentFolder', () => {
  expect(withUploadCallback('/lams/ckeditor/filemanager/upload/simpleuploader?Type=Image&CurrentFolder=/abc-123/'))
    .toBe('/lams/ckeditor/filemanager/upload/simpleuploader?Type=Image&CurrentFolder=/abc-123/&CKEditorFuncNum=1');
  expect(withUploadCallback('/upload')).toBe('/upload?CKEditorFuncNum=1');
  expect(withUploadCallback('/upload?CKEditorFuncNum=7')).toBe('/upload?CKEditorFuncNum=7');
});

test('reads the legacy response LAMS returns for an image upload', () => {
  // Captured from ilams.lamsinternational.com with CKEditorFuncNum present.
  const body = '<script type="text/javascript">\r\nthis.parent.CKEDITOR.tools.callFunction(1,\'/lams//www/secure/42/bd/f9/00/4f/21/Image/curves_1.png\',\'\');\r\n</script>\r\n';
  expect(parseCkEditorUploadResponse(body)).toBe('/lams//www/secure/42/bd/f9/00/4f/21/Image/curves_1.png');
});

test('an empty upload response is reported as a failure, not a stored image', () => {
  // LAMS answers 200 with an empty body when CKEditorFuncNum is missing.
  expect(() => parseCkEditorUploadResponse('')).toThrow(/empty upload response/);
});
