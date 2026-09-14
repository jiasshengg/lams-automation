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
