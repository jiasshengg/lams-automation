import type { Frame } from '@playwright/test';
import { linkifyUrls, sanitizeInlineHtml } from '../ae/inline-html.js';
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
  const requestUrl = withUploadCallback(uploadValue);
  const absoluteRequestUrl = new URL(requestUrl, frame.url());
  if (absoluteRequestUrl.origin !== new URL(frame.url()).origin) {
    throw new Error(`Refusing to upload a question image to a different origin: ${absoluteRequestUrl.origin}`);
  }

  const uploaded: UploadedImage[] = [];
  for (const image of images) {
    const data = await applyDocumentCrop(frame, image);
    // The upload runs inside the authoring frame so it carries the signed-in LAMS session.
    // Playwright's APIRequestContext is a separate client here: LAMS answered it with a
    // SAML re-authentication page instead of an upload response.
    const response = await frame.evaluate(
      async ({ url, filename, contentType, base64 }) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const form = new FormData();
        form.append('upload', new File([bytes], filename, { type: contentType }));
        const result = await fetch(url, { method: 'POST', body: form, credentials: 'include' });
        return { status: result.status, ok: result.ok, body: await result.text() };
      },
      { url: requestUrl, filename: image.filename, contentType: image.contentType, base64: data.toString('base64') }
    );
    const body = response.body;
    if (!response.ok) throw new Error(`CKEditor image upload failed (${response.status}): ${body.slice(0, 300)}`);
    if (body.trim() === '') {
      throw new Error(
        `CKEditor image upload returned ${response.status} with an empty body for ${image.filename}. ` +
          `Upload URL: ${absoluteRequestUrl.pathname}${absoluteRequestUrl.search}`
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
 * CKEditor's own file browser appends CKEditorFuncNum before posting, and LAMS's
 * simpleuploader only answers when it is present: without it the servlet returns 200 with
 * an empty body, which reads as a successful upload that produced no image URL. The value
 * is the callback index the legacy response echoes back, and 1 is what CKEditor uses for a
 * single dialog. The query string is extended textually so the unencoded slashes LAMS
 * writes into CurrentFolder survive.
 */
export function withUploadCallback(uploadUrl: string): string {
  if (/[?&]CKEditorFuncNum=/.test(uploadUrl)) return uploadUrl;
  return `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}CKEditorFuncNum=1`;
}

/**
 * Word crops a picture for display but embeds the whole file, so the archived bytes show more than
 * the document does. The crop is applied inside the authenticated authoring frame before upload.
 */
async function applyDocumentCrop(frame: Frame, image: QuestionImageAsset): Promise<Buffer> {
  if (image.crop === null) return image.data;
  const source = `data:${image.contentType};base64,${image.data.toString('base64')}`;
  const cropped = await frame.evaluate(
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
  if (body.trim() === '') {
    throw new Error('CKEditor returned an empty upload response, so no image URL was stored.');
  }
  throw new Error(`Could not read the uploaded image URL from CKEditor response: ${body.slice(0, 300)}`);
}

/** Renders each image followed by its Source-of-Truth caption, as the document prints it. */
export function imageHtml(images: UploadedImage[], placement?: ImagePlacement): string {
  return images.filter((image) => placement === undefined || image.placement === placement).map((image) => {
    const width = image.widthPx ? ` width="${Math.min(Math.round(image.widthPx), 1200)}"` : '';
    const caption = image.caption === '' ? '' : `<div>${linkifyUrls(sanitizeInlineHtml(image.caption))}</div>`;
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
