import { expect, test, type Page } from '@playwright/test';
import { discoverLessons } from '../src/lams/lesson-discovery.js';

async function library(page: Page, nonExpandingEmpty = false): Promise<void> {
  await page.setContent(`
    <button id="openButton" onclick="document.querySelector('[role=dialog]').hidden=false">Open</button>
    <div role="dialog" aria-label="Open design" hidden><div id="tree"></div></div>
    <script>
      (() => {
      const tree = [
        {name:'Courses', children:[
          {name:'Medicine 2025', children:[
            {name:'FOM', children:[{name:'TBL06 revision'}, {name:'TBL07'}]},
            {name:'Archive', children:[{name:'FOM TBL06 revision'}]}
          ]},
          {name:'Medicine 2026', children:[{name:'FOM', children:[{name:'TBL06 revision'}]}]},
          {name:'Empty', children:[]}
        ]},
        {name:'Private', children:[{name:'FOM TBL06 private'}]}
      ];
      window.lessonClicks = 0;
      function render() {
        document.querySelector('#tree').replaceChildren();
        function visit(nodes, depth) {
          for (const node of nodes) {
            const el = document.createElement('div');
            el.setAttribute('role','treeitem');
            for(let i=0;i<depth;i++) {
              const indent = document.createElement('span'); indent.className='indent'; el.append(indent);
            }
            el.append(document.createTextNode(node.name));
            if(node.children) {
              el.className='tree-parent'; el.setAttribute('aria-expanded', String(!!node.expanded));
              if (${nonExpandingEmpty} && node.children.length === 0) {
                el.insertAdjacentHTML('beforeend', '<span class="node-icon treeview-empty"></span>');
              } else el.onclick=()=>{node.expanded=!node.expanded;render();};
            } else el.onclick=()=>window.lessonClicks++;
            document.querySelector('#tree').append(el);
            if(node.expanded) visit(node.children,depth+1);
          }
        }
        visit(tree,0);
      }
      render();
      })();
    </script>
  `);
}

test('searches non-playground folders, returns duplicate titles with distinct paths, and never opens lessons', async ({ page }) => {
  await library(page);
  const results = await discoverLessons(page, { query: 'fom tbl06', timeoutMs: 2000 });
  expect(results).toEqual([
    { sourceLessonTitle: 'TBL06 revision', sourceFolderPath: ['Courses', 'Medicine 2025', 'FOM'] },
    { sourceLessonTitle: 'FOM TBL06 revision', sourceFolderPath: ['Courses', 'Medicine 2025', 'Archive'] },
    { sourceLessonTitle: 'TBL06 revision', sourceFolderPath: ['Courses', 'Medicine 2026', 'FOM'] }
  ]);
  expect(await page.evaluate(() => (window as unknown as { lessonClicks: number }).lessonClicks)).toBe(0);
});

test('matches an exact title without accepting a folder or title substring', async ({ page }) => {
  await library(page);
  expect(await discoverLessons(page, { exactTitle: 'TBL06 revision', timeoutMs: 2000 })).toEqual([
    { sourceLessonTitle: 'TBL06 revision', sourceFolderPath: ['Courses', 'Medicine 2025', 'FOM'] },
    { sourceLessonTitle: 'TBL06 revision', sourceFolderPath: ['Courses', 'Medicine 2026', 'FOM'] }
  ]);
  expect(await discoverLessons(page, { exactTitle: 'Medicine 2026', timeoutMs: 2000 })).toEqual([]);
  expect(await discoverLessons(page, { exactTitle: 'TBL06', timeoutMs: 2000 })).toEqual([]);
});

test('reads the folder endpoint sequentially and matches exact titles', async ({ page }) => {
  const children = new Map<number | null, { folders: Array<{ name: string; folderID: number }>; designs: Array<{ name: string; learningDesignId: number }> }>([
    [null, { folders: [{ name: 'Courses', folderID: -2 }], designs: [] }],
    [-2, { folders: [{ name: 'One', folderID: 1 }, { name: 'Two', folderID: 2 }], designs: [] }],
    [1, { folders: [], designs: [{ name: '[Jss-Demo-Test]', learningDesignId: 10 }] }],
    [2, { folders: [], designs: [{ name: '[Jss-Demo-Test] copy', learningDesignId: 11 }] }]
  ]);
  let active = 0;
  let maxActive = 0;
  await page.route('https://lams.test/authoring', route => route.fulfill({
    contentType: 'text/html',
    body: `<button id="openButton">Open</button>
      <div role="dialog" aria-label="Open design">Open design</div>
      <script>window.LAMS_URL='https://lams.test/lams/'</script>`
  }));
  await page.route('https://lams.test/lams/home/getFolderContents.do*', async route => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    const rawID = new URL(route.request().url()).searchParams.get('folderID');
    const content = children.get(rawID === '' ? null : Number(rawID))!;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ folders: content.folders, learningDesigns: content.designs }) });
    active -= 1;
  });
  await page.goto('https://lams.test/authoring');
  expect(await discoverLessons(page, { exactTitle: '[Jss-Demo-Test]', timeoutMs: 2000 })).toEqual([
    { sourceLessonTitle: '[Jss-Demo-Test]', sourceFolderPath: ['Courses', 'One'] }
  ]);
  expect(maxActive).toBe(1);
});

test('falls back to the rendered tree when the folder endpoint returns HTML', async ({ page }) => {
  await page.route('https://lams.test/blank', route => route.fulfill({ contentType: 'text/html', body: '' }));
  await page.goto('https://lams.test/blank');
  await library(page);
  await page.evaluate(() => { (window as Window & { LAMS_URL?: string }).LAMS_URL = 'https://lams.test/lams/'; });
  await page.route('https://lams.test/lams/home/getFolderContents.do*', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Temporary response</title>'
  }));
  expect(await discoverLessons(page, { exactTitle: 'TBL06 revision', timeoutMs: 2000 })).toHaveLength(2);
});

test('limits traversal to requested roots and matches year in folder ancestry', async ({ page }) => {
  await library(page);
  const results = await discoverLessons(page, { roots: ['Medicine 2026'], query: '2026 FOM TBL06', timeoutMs: 2000 });
  expect(results).toHaveLength(1);
  expect(results[0]!.sourceFolderPath).toEqual(['Courses', 'Medicine 2026', 'FOM']);
  await expect(page.getByRole('treeitem', { name: 'Medicine 2025', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('reports no matches without falling back to an unrelated lesson', async ({ page }) => {
  await library(page);
  expect(await discoverLessons(page, { roots: ['Empty'], query: 'TBL06', timeoutMs: 2000 })).toEqual([]);
});

test('refuses missing roots and incomplete traversal', async ({ page }) => {
  await library(page);
  await expect(discoverLessons(page, { roots: ['Missing'], timeoutMs: 2000 })).rejects.toThrow('found 0');
  await library(page);
  await expect(discoverLessons(page, { maxExpansions: 1, timeoutMs: 2000 })).rejects.toThrow('results are incomplete');
});

test('stops on unrecognised folder state', async ({ page }) => {
  await page.setContent('<button id="openButton">Open</button><div role="dialog" aria-label="Open design"><div role="treeitem" class="tree-parent">Courses</div></div>');
  await expect(discoverLessons(page, { timeoutMs: 2000 })).rejects.toThrow('Unknown folder expansion state');
});

test('skips DOM-verified empty folders that cannot expand and still searches siblings', async ({ page }) => {
  await library(page, true);
  expect(await discoverLessons(page, { query: 'fom tbl06', timeoutMs: 2000 })).toHaveLength(3);
  await expect(page.getByRole('treeitem', { name: 'Empty', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('accepts rendered descendants when a populated folder leaves aria-expanded false', async ({ page }) => {
  await page.setContent(`
    <button id="openButton" onclick="document.querySelector('[role=dialog]').hidden=false">Open</button>
    <div role="dialog" aria-label="Open design" hidden>
      <div role="treeitem" class="tree-parent" aria-expanded="true">Courses</div>
      <div role="treeitem" class="tree-parent" aria-expanded="true"><span class="indent"></span>Playground</div>
      <div role="treeitem" class="tree-parent" aria-expanded="false"><span class="indent"></span><span class="indent"></span>Run sequences</div>
      <div role="treeitem"><span class="indent"></span><span class="indent"></span><span class="indent"></span>FOM TBL01 2025Y1</div>
    </div>
  `);
  expect(await discoverLessons(page, { query: 'FOM TBL01', timeoutMs: 300 })).toEqual([{
    sourceLessonTitle: 'FOM TBL01 2025Y1',
    sourceFolderPath: ['Courses', 'Playground', 'Run sequences']
  }]);
  await expect(page.getByRole('treeitem', { name: 'Run sequences', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('does not hide expansion failures for folders without empty-folder evidence', async ({ page }) => {
  await page.setContent('<button id="openButton">Open</button><div role="dialog" aria-label="Open design"><div role="treeitem" class="tree-parent" aria-expanded="false">Courses</div></div>');
  await expect(discoverLessons(page, { timeoutMs: 300 })).rejects.toThrow();
});

test('recognizes folders that become empty after expansion without timing out or returning them as lessons', async ({ page }) => {
  await page.setContent(`<button id="openButton">Open</button><div role="dialog" aria-label="Open design">
    <div role="treeitem" class="tree-parent" aria-expanded="true">Courses</div>
    <div id="empty" role="treeitem" class="tree-parent" aria-expanded="false"><span class="indent"></span>Empty</div>
    </div><script>document.querySelector('#empty').onclick=function(){this.className='';this.insertAdjacentHTML('beforeend','<span class="node-icon treeview-empty"></span>');};</script>`);
  expect(await discoverLessons(page, { query: 'Empty', timeoutMs: 1000 })).toEqual([]);
});

test('uses the observed expansion icon instead of selecting a row', async ({ page }) => {
  await page.setContent(`<button id="openButton">Open</button><div role="dialog" aria-label="Open design">
    <div role="treeitem" class="tree-parent" aria-expanded="false"><span class="expand-icon" style="display:inline-block;width:20px;height:20px"></span>Courses</div>
    </div><script>document.querySelector('.expand-icon').onclick=function(event){event.stopPropagation();this.parentElement.setAttribute('aria-expanded','true');this.parentElement.insertAdjacentHTML('afterend','<div role="treeitem"><span class="indent"></span>Lesson</div>');};</script>`);
  expect(await discoverLessons(page, { query: 'Lesson', timeoutMs: 1000 })).toEqual([{ sourceLessonTitle: 'Lesson', sourceFolderPath: ['Courses'] }]);
});

test('reports a depleted Courses tree as incomplete after API fallback', async ({ page }) => {
  await page.setContent(`<button id="openButton">Open</button><div role="dialog" aria-label="Open design">
    <div role="treeitem" aria-expanded="false"><span class="node-icon treeview-empty"></span>Courses</div>
  </div>`);
  await expect(discoverLessons(page, { timeoutMs: 500 })).rejects.toThrow('Discovery is incomplete');
});

test('reports sanitized response evidence and retries one transient API response', async ({ page }) => {
  const messages: string[] = [];
  let calls = 0;
  await page.route('https://lams.test/authoring', route => route.fulfill({ contentType: 'text/html', body: '<button id="openButton">Open</button><div role="dialog" aria-label="Open design">Open design</div><script>window.LAMS_URL="https://lams.test/lams/"</script>' }));
  await page.route('https://lams.test/lams/home/getFolderContents.do*', route => {
    calls++;
    if (calls === 1) return route.fulfill({ contentType: 'text/html', body: 'temporary' });
    const top = new URL(route.request().url()).searchParams.get('folderID') === '';
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ folders: top ? [{name:'Courses',folderID:1}] : [], learningDesigns: [] }) });
  });
  await page.goto('https://lams.test/authoring');
  expect(await discoverLessons(page, { timeoutMs: 1000, onProgress: m => messages.push(m) })).toEqual([]);
  expect(calls).toBe(3);
  expect(messages.join('\n')).toContain('HTTP 200, type text/html, final URL https://lams.test/lams/home/getFolderContents.do');
});
