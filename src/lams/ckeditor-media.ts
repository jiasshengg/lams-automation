import type { Frame, Page } from '@playwright/test';
import { sanitizeInlineHtml } from '../ae/inline-html.js';
import type { ImagePlacement } from '../docx/media.js';
import type { QuestionImageAsset } from '../docx/question-images.js';

export interface UploadedImage {
  url: string;
  altText: string;
  widthPx: number | null;
  placement: ImagePlacement;
  caption: string;
  source: string;
}

export async function uploadCkEditorImages(
  page: Page,
  frame: Frame,
  editorId: string,
  images: QuestionImageAsset[]
): Promise<UploadedImage[]> {
  if (images.length === 0) return [];
  const uploadValue = await frame.evaluate((id) => {
    const editor = (window as typeof window & {
      CKEDITOR?: { instances?: Record<string, { config?: { filebrowserImageUploadUrl?: string } }> };
    }).CKEDITOR?.instances?.[id];
    return editor?.config?.filebrowserImageUploadUrl ?? null;
  }, editorId);
  if (!uploadValue) throw new Error(`CKEditor instance "${editorId}" does not expose an image upload URL.`);
  const uploadUrl = withUploadCallbackId(new URL(uploadValue, frame.url()));
  if (uploadUrl.origin !== new URL(frame.url()).origin) {
    throw new Error(`Refusing to upload a question image to a different origin: ${uploadUrl.origin}`);
  }

  const uploaded: UploadedImage[] = [];
  for (const image of images) {
    const data = await applyDocumentCrop(page, image);
    const response = await page.context().request.post(uploadUrl.toString(), {
      multipart: { upload: { name: image.filename, mimeType: image.contentType, buffer: data } }
    });
    const body = await response.text();
    if (!response.ok()) throw new Error(`CKEditor image upload failed (${response.status()}): ${body.slice(0, 300)}`);
    if (body.trim() === '') {
      throw new Error(
        `CKEditor image upload returned ${response.status()} with an empty body for ${image.filename}. ` +
          `Upload URL: ${uploadUrl.pathname}${uploadUrl.search}`
      );
    }
    const returnedUrl = parseCkEditorUploadResponse(body);
    const absoluteUrl = new URL(returnedUrl, frame.url());
    if (absoluteUrl.origin !== new URL(frame.url()).origin) {
      throw new Error(`CKEditor returned an image URL on a different origin: ${absoluteUrl.origin}`);
    }
    uploaded.push({
      url: absoluteUrl.toString(),
      altText: image.altText,
      widthPx: image.widthPx,
      placement: image.placement,
      caption: image.caption,
      source: image.source
    });
  }
  return uploaded;
}

/**
 * LAMS serves the legacy CKEditor "simpleuploader", which answers with a script calling
 * CKEDITOR.tools.callFunction(<id>, '<url>'). It reads that id from CKEditorFuncNum, which the
 * editor adds itself when a user uploads through the UI. A direct POST has to supply it, or the
 * servlet answers 200 with an empty body and there is no URL to read back.
 */
export function withUploadCallbackId(uploadUrl: URL): URL {
  if (!uploadUrl.searchParams.has('CKEditorFuncNum')) uploadUrl.searchParams.set('CKEditorFuncNum', '1');
  return uploadUrl;
}

/**
 * Word crops a picture for display but embeds the whole file, so the archived bytes show more than
 * the document does. The crop is applied here rather than at extraction because it needs an image
 * decoder, and the browser already driving LAMS is the one this project ships.
 */
async function applyDocumentCrop(page: Page, image: QuestionImageAsset): Promise<Buffer> {
  if (image.crop === null) return image.data;
  const source = `data:${image.contentType};base64,${image.data.toString('base64')}`;
  const cropped = await page.evaluate(
    async ([dataUrl, type, left, top, right, bottom]) => {
      const picture = new Image();
      picture.src = dataUrl as string;
      await picture.decode();
      const width = picture.naturalWidth;
      const height = picture.naturalHeight;
      const box = {
        x: Math.round(width * (left as number)),
        y: Math.round(height * (top as number)),
        width: Math.round(width * (1 - (left as number) - (right as number))),
        height: Math.round(height * (1 - (top as number) - (bottom as number)))
      };
      if (box.width < 1 || box.height < 1) return null;
      const canvas = document.createElement('canvas');
      canvas.width = box.width;
      canvas.height = box.height;
      const context = canvas.getContext('2d');
      if (context === null) return null;
      context.drawImage(picture, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
      return canvas.toDataURL(type as string);
    },
    [source, image.contentType, image.crop.left, image.crop.top, image.crop.right, image.crop.bottom] as const
  );
  if (cropped === null) throw new Error(`Could not apply the document crop to ${image.filename}.`);
  return Buffer.from(cropped.slice(cropped.indexOf(',') + 1), 'base64');
}

export function parseCkEditorUploadResponse(body: string): string {
  try {
    const parsed = JSON.parse(body) as { url?: unknown; uploaded?: unknown; error?: { message?: unknown } };
    if (typeof parsed.url === 'string' && parsed.url.trim()) return parsed.url;
    if (parsed.error?.message) throw new Error(`CKEditor upload rejected the image: ${String(parsed.error.message)}`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // The legacy simple uploader returns a script invoking CKEDITOR.tools.callFunction.
    } else {
      throw error;
    }
  }
  const callFunction = /callFunction\(\s*\d+\s*,\s*['"]([^'"]+)['"]/.exec(body)?.[1];
  if (callFunction) return decodeJavascriptString(callFunction);
  const urlProperty = /\burl\s*[:=]\s*['"]([^'"]+)['"]/.exec(body)?.[1];
  if (urlProperty) return decodeJavascriptString(urlProperty);
  throw new Error(`Could not read the uploaded image URL from CKEditor response: ${body.slice(0, 300)}`);
}

/** Renders each image followed by its Source-of-Truth caption, as the document prints it. */
export function imageHtml(images: UploadedImage[], placement?: ImagePlacement): string {
  return images.filter((image) => placement === undefined || image.placement === placement).map((image) => {
    const width = image.widthPx ? ` width="${Math.min(Math.round(image.widthPx), 1200)}"` : '';
    const caption = image.caption === '' ? '' : `<div>${sanitizeInlineHtml(image.caption)}</div>`;
    return `<div><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText)}"${width}></div>${caption}`;
  }).join('');
}

function decodeJavascriptString(value: string): string {
  return value.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}
