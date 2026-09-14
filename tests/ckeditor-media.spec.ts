import { expect, test } from '@playwright/test';
import { imageHtml, parseCkEditorUploadResponse, withUploadCallbackId } from '../src/lams/ckeditor-media.js';

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

test('adds the legacy uploader callback id, and keeps one the URL already carries', () => {
  const base = 'https://lams.example/lams/ckeditor/filemanager/upload/simpleuploader?Type=Image&CurrentFolder=/42/';
  expect(withUploadCallbackId(new URL(base)).searchParams.get('CKEditorFuncNum')).toBe('1');
  expect(withUploadCallbackId(new URL(`${base}&CKEditorFuncNum=7`)).searchParams.get('CKEditorFuncNum')).toBe('7');
  // The folder the upload targets must survive untouched.
  expect(withUploadCallbackId(new URL(base)).searchParams.get('CurrentFolder')).toBe('/42/');
});
