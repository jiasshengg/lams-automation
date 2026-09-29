# Kanban code sink (Google Apps Script)

`kanban-code-sink.gs` writes a published lesson's 5-digit LAMS code into the Kanban sheet.
The publishing stage (`lesson:index`, `run:tbl --publish`) and `send:code` call it.

- **Tab:** named per run (`kanbanTab` in `--request-json`, or `--tab` for `send:code`).
  The script writes only to that tab and never assumes one. Case, spacing, and `_` versus
  space are ignored, but only for a whole tab name.
- **Row:** the one row whose column G ("TBL/Quiz Details") contains the run's TBL/Quiz
  Details text (`kanbanDetails`, or `--details`). No match or more than one match is an
  error; nothing is written.
- **Column:** the code goes into column M.
- **Secret:** read from the script's `SHARED_SECRET` Script property, not from the source.

The script is bound to the spreadsheet it is pasted into (`getActiveSpreadsheet()`), so each
spreadsheet needs its own copy and its own Web App deployment.

## Setting up a new Kanban spreadsheet

The same steps apply to a brand-new spreadsheet and to a **File > Make a copy** of an existing
one. A copy brings the script along, but not its deployment, so it still needs steps 3-6.

1. **Share for reading.** Share > General access > *Anyone with the link* - *Viewer*. The
   Elentra scripts read tabs through the public CSV export, without signing in.
2. **Add the script.** Extensions > Apps Script. Replace the editor contents with
   `kanban-code-sink.gs` from this folder and save.
3. **Set the secret.** Project Settings (gear) > Script properties > Add script property:
   `SHARED_SECRET` = a new random value. Check this on a copied sheet too.
4. **Deploy.** Deploy > New deployment > type *Web app*. Execute as: *Me*. Who has access:
   **Anyone**. The automation calls the URL without a Google sign-in, so *Anyone within NTU*
   answers HTTP 401 and nothing reaches the script; `SHARED_SECRET` is what keeps other
   callers out. Deploy, then authorise the script when asked.
5. **Copy the Web app URL** (ends in `/exec`).
6. **Point this machine at it** in the ignored `configs/local.json`:

   ```json
   "sheet": {
     "spreadsheetId": "<the id between /spreadsheets/d/ and /edit in the sheet's URL>",
     "webhookUrl": "<the /exec URL from step 5>",
     "secret": "<the SHARED_SECRET from step 3>"
   }
   ```

   `LAMS_SHEET_WEBHOOK_URL` / `LAMS_SHEET_SECRET` in `.env` **override** `webhookUrl` / `secret`,
   and `KANBAN_SHEET_ID` overrides `spreadsheetId`. Update or remove those `.env` lines, or the
   old sheet keeps receiving the codes.

`spreadsheetId` is what the Elentra scripts read; `webhookUrl` decides where codes are written.
Both must name the same spreadsheet.

## Updating the script on an existing sheet

After pasting a new version, use Deploy > Manage deployments > edit (pencil) > Version:
*New version* > Deploy. This keeps the same `/exec` URL. A *New deployment* would create a
new URL, which would then have to go into `configs/local.json`.

## Checking it

```bash
npm run send:code -- --code 12345 --tab "<tab>" --details "<TBL/Quiz Details text>" --dry-run
```

Drop `--dry-run` to write for real, and only against a test row.
