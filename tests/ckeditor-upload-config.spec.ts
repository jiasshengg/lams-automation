import { expect, test } from '@playwright/test';
import { uploadCkEditorImages } from '../src/lams/ckeditor-media.js';

test('waits for an inline editor to receive its upload URL before uploading', async ({ page }) => {
  // LAMS's editReference.do creates the inline editor first; CKEditor merges the page's
  // configuration, upload URL included, only once the instance has loaded.
  await page.route('http://lams.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      expect(request.url()).toContain('/lams/ckeditor/filemanager/upload/simpleuploader?Type=Image');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ uploaded: 1, url: '/lams/www/secure/folder/Image/q.png' }) });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<html><body><script>
        window.CKEDITOR = { instances: { description: { config: {} } } };
        setTimeout(function () {
          window.CKEDITOR.instances.description.config.filebrowserImageUploadUrl =
            '/lams/ckeditor/filemanager/upload/simpleuploader?Type=Image&CurrentFolder=/abc/';
        }, 400);
      </script></body></html>`
    });
  });
  await page.goto('http://lams.test/lams/tool/laasse10/authoring/editReference.do');

  const uploaded = await uploadCkEditorImages(page.mainFrame(), 'description', [{
    filename: 'q.png', contentType: 'image/png', data: Buffer.from('iVBORw0KGgo=', 'base64'), altText: '', widthPx: null,
    placement: 'before', crop: null, caption: '', source: 'test'
  }]);

  expect(uploaded.map((image) => image.url)).toEqual(['http://lams.test/lams/www/secure/folder/Image/q.png']);
});
