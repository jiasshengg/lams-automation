import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';

export interface SurfaceSummary {
  url: string;
  title: string;
  frameCount: number;
  frameUrls: string[];
  iframeCount: number;
  canvasCount: number;
  svgCount: number;
  svgText: string[];
  dataAttributes: string[];
  visibleControls: string[];
}

export async function inspectPageSurface(page: Page): Promise<SurfaceSummary> {
  const summaries = await Promise.all(page.frames().map(inspectFrame));
  return {
    url: page.url(),
    title: await page.title(),
    frameCount: page.frames().length,
    frameUrls: unique(summaries.map((item) => item.frameUrl)),
    iframeCount: await page.locator('iframe').count(),
    canvasCount: summaries.reduce((sum, item) => sum + item.canvasCount, 0),
    svgCount: summaries.reduce((sum, item) => sum + item.svgCount, 0),
    svgText: unique(summaries.flatMap((item) => item.svgText)).slice(0, 200),
    dataAttributes: unique(summaries.flatMap((item) => item.dataAttributes)).slice(0, 200),
    visibleControls: unique(summaries.flatMap((item) => item.visibleControls)).slice(0, 200)
  };
}

export async function saveDiagnostics(page: Page, label: string): Promise<string> {
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const directory = path.resolve('artifacts', `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}`);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, 'page.png'), fullPage: true });
  await writeFile(path.join(directory, 'page.html'), await page.content(), 'utf8');
  await Promise.all(
    page.frames().map(async (frame, index) => {
      if (frame === page.mainFrame()) return;
      const frameName = frame.name().replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || `frame-${index}`;
      try {
        await writeFile(path.join(directory, `${frameName}.html`), await frame.content(), 'utf8');
      } catch {
        // Some cross-origin or transient frames cannot be serialized. Their URL remains in the summary.
      }
    })
  );
  await writeFile(
    path.join(directory, 'dom-summary.json'),
    JSON.stringify(await inspectPageSurface(page), null, 2),
    'utf8'
  );
  return directory;
}

async function inspectFrame(frame: Frame) {
  try {
    return await frame.evaluate(() => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const compact = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim();
      const controls = Array.from(
        document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], [role="treeitem"]')
      )
        .filter(visible)
        .map((element) => compact(element.getAttribute('aria-label')) || compact(element.textContent))
        .filter(Boolean);
      const dataAttributes = new Set<string>();
      for (const element of document.querySelectorAll('*')) {
        for (const attribute of element.getAttributeNames()) {
          if (attribute.startsWith('data-')) dataAttributes.add(attribute);
        }
      }
      return {
        frameUrl: window.location.href,
        canvasCount: document.querySelectorAll('canvas').length,
        svgCount: document.querySelectorAll('svg').length,
        svgText: Array.from(document.querySelectorAll('svg text'))
          .filter(visible)
          .map((element) => compact(element.textContent))
          .filter(Boolean),
        dataAttributes: Array.from(dataAttributes),
        visibleControls: controls
      };
    });
  } catch {
    return { frameUrl: frame.url(), canvasCount: 0, svgCount: 0, svgText: [], dataAttributes: [], visibleControls: [] };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
