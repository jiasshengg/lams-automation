import type { Frame, Page } from '@playwright/test';
import type { QuestionImageAsset } from '../docx/question-images.js';

export interface UploadedImage {
  url: string;
  altText: string;
  widthPx: number | null;
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
  const uploadUrl = new URL(uploadValue, frame.url());
  if (uploadUrl.origin !== new URL(frame.url()).origin) {
    throw new Error(`Refusing to upload a question image to a different origin: ${uploadUrl.origin}`);
  }

  const uploaded: UploadedImage[] = [];
  for (const image of images) {
    const response = await page.context().request.post(uploadUrl.toString(), {
      multipart: { upload: { name: image.filename, mimeType: image.contentType, buffer: image.data } }
    });
    const body = await response.text();
    if (!response.ok()) throw new Error(`CKEditor image upload failed (${response.status()}): ${body.slice(0, 300)}`);
    const returnedUrl = parseCkEditorUploadResponse(body);
    const absoluteUrl = new URL(returnedUrl, frame.url());
    if (absoluteUrl.origin !== new URL(frame.url()).origin) {
      throw new Error(`CKEditor returned an image URL on a different origin: ${absoluteUrl.origin}`);
    }
    uploaded.push({
      url: absoluteUrl.toString(),
      altText: image.altText,
      widthPx: image.widthPx,
      source: image.source
    });
  }
  return uploaded;
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

export function imageHtml(images: UploadedImage[]): string {
  return images.map((image) => {
    const width = image.widthPx ? ` width="${Math.min(Math.round(image.widthPx), 1200)}"` : '';
    return `<p><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText)}"${width}></p>`;
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
