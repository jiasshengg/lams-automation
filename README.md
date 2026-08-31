# LAMS automation

This project contains the reusable Playwright layer for the LAMS TBL authoring workflow. The current implementation covers the first-box workflow: verify the safe playground course, open LAMS Authoring, traverse a configurable folder path, open an exact source design, and reach Save As. It does not modify authoring nodes.

## Agent skill

The repository includes one vendor-neutral skill at `skills/lams-tbl-authoring/`. Thin discovery adapters expose the same instructions to both supported coding agents:

- Codex: invoke `$lams-tbl-authoring` or describe a matching LAMS copy/validation request.
- Claude Code: invoke `/lams-tbl-authoring` or describe a matching request.

For example:

```text
Copy the exact lesson "FOM TBL06 2025Y1" from Courses > Cohort_2025Y1 > FOM,
rename it to "FOM TBL06 030926 2026Y1", save it in
Courses > Cohort_2026Y1 > FOM, then validate the supplied linear flow with
5 AE nodes and 4 AE gates.
```

The agent passes changing lesson values directly to the scripts as per-run JSON, runs the safe dry run first, and calls the existing Playwright commands. It does not rewrite `configs/local.json` for every lesson. That ignored file holds stable local LAMS/browser settings and fallback defaults. The skill requires exact copy targets and explicit authorization before the committed Save action. Automatic Source-of-Truth parsing and automatic node correction remain out of scope.

## Setup

```bash
npm install
npm run install:browsers
cp configs/example.json configs/local.json
```

Edit `configs/local.json` once with the real LAMS URL, approved workspace, browser settings, and valid fallback values. The browser runs visibly and uses `.playwright/lams-profile`, so you can sign in manually and reuse that local browser session. Passwords are never read from configuration and `.playwright/` is ignored by Git.

For individual operations, pass changing lesson values without editing the file:

```bash
npm run milestone1 -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"sourceLessonTitle":"[Jss] TEST LESSON A 280826","destinationFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"lessonTitle":"[Jss-Skill] TEST LESSON B 280826"}'
```

The skill constructs this per-run JSON automatically from the user's prompt. The command opens and verifies the source lesson, Save As dialog, and requested destination, but does not save.

After a successful dry run, reuse the identical request JSON and explicitly enable the final Save action with:

```bash
npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit
```

`--commit` refuses to run when the new title matches the source or still contains a placeholder such as `REPLACE`.
It also refuses to overwrite an existing destination title and reopens the destination after saving to verify the copy exists.

Inspect the copied lesson's SVG graph without changing it:

```bash
npm run inspect:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

This prints each activity's UIID, name, type, Team Setup grouping association, and every transition endpoint available from the LAMS runtime model.

Validate the copied lesson against the exact manually configured reference flow:

```bash
npm run validate:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

Gate settings can also be validated without opening or changing the gate property dialogs. Add exact expectations to the per-run request JSON:

```json
{
  "expectedGateProperties": [
    {
      "name": "iRAT Gate",
      "type": "password",
      "description": "iRAT Gate",
      "dynamicPassword": true,
      "rotationSeconds": 10
    },
    {
      "name": "tRAT Gate",
      "type": "permission",
      "description": "tRAT Gate"
    }
  ]
}
```

Each property is optional, so different lessons can validate only the settings they require. A mismatch is reported as a validation failure; the script never corrects or saves the gate automatically.

## Selector discovery workflow

No LAMS-specific selector has been guessed. The example config only uses the supplied visible cohort and TBL text. Selectors use one of these forms:

```json
{ "by": "role", "role": "button", "name": "Authoring", "exact": true }
{ "by": "label", "label": "Open authoring", "exact": true }
{ "by": "text", "text": "{{tbl}}", "exact": false }
{ "by": "testId", "testId": "open-authoring" }
{ "by": "css", "css": "[data-purpose='authoring-node']" }
```

Prefer role, label, text, or a stable test ID. CSS is the escape hatch for a stable attribute when LAMS exposes no accessible locator.

When an unknown selector is reached, the run stops without changing LAMS and writes an `artifacts/<timestamp>-.../` directory containing:

- `page.png`: full-page screenshot
- `page.html`: top-level document HTML (plus separate HTML files for serializable child frames)
- `dom-summary.json`: frames, iframe/canvas/SVG counts, SVG text, data-attribute names, and visible control names

Collect the following from the actual LAMS page before adding the remaining selectors:

1. The accessible role/name or stable attribute for opening the lesson after selecting the TBL, if a separate action is required.
2. The accessible role/name or stable attribute for opening LAMS Authoring.
3. Whether Authoring is in the main page, a popup/new tab, or an iframe. If it is an iframe, record its `title`, `name`, or stable attribute.
4. Whether nodes are HTML, SVG, or canvas-rendered. For HTML/SVG, record one repeated node element's outer HTML and which child/attribute contains its name and type. For canvas, DOM selectors cannot enumerate nodes; record any accompanying model/network data or accessibility tree exposed by LAMS.
5. One example each for Team Setup, a gate, iRAT/tRAT, Leader Selection, and AE, including stable classes/data attributes and displayed text.

Once known, add `openLesson`, `openAuthoring`, `authoringRoot`, and `authoringNode` under `selectors`. For example (illustrative only, not a LAMS selector):

```json
{
  "selectors": {
    "openAuthoring": { "by": "role", "role": "button", "name": "Authoring" },
    "authoringNode": {
      "locator": { "by": "css", "css": "[data-purpose='authoring-node']" },
      "nameAttribute": "data-node-name",
      "typeAttribute": "data-node-type"
    }
  }
}
```

The final block is only a schema example. Replace it with evidence from the DOM diagnostics.
