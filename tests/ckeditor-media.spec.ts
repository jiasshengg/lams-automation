import { expect, test } from '@playwright/test';
import { imageHtml, parseCkEditorUploadResponse } from '../src/lams/ckeditor-media.js';

test('parses modern and legacy CKEditor upload responses', () => {
  expect(parseCkEditorUploadResponse('{"uploaded":1,"url":"/content/image.png"}')).toBe('/content/image.png');
  expect(parseCkEditorUploadResponse('<script>window.parent.CKEDITOR.tools.callFunction(7, "/content/a.jpg", "")</script>'))
    .toBe('/content/a.jpg');
});

test('renders uploaded images with escaped alt text and bounded width', () => {
  expect(imageHtml([{ url: 'https://example.test/a.png?a=1&b=2', altText: 'A "chart"', widthPx: 2000, source: 'test' }]))
    .toBe('<p><img src="https://example.test/a.png?a=1&amp;b=2" alt="A &quot;chart&quot;" width="1200"></p>');
});
