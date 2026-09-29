/**
 * Kanban code sink: writes a published lesson's 5-digit LAMS code into the Kanban sheet.
 *
 * Paste this into the spreadsheet's own Apps Script project (Extensions > Apps Script) and
 * deploy it as a Web App. It is bound to that spreadsheet through getActiveSpreadsheet(), so
 * every spreadsheet needs its own copy and its own deployment; see apps-script/README.md.
 *
 * Request body (JSON): { secret, code, identifier, tab }
 *   tab         the Kanban tab the user named for this run; no tab is assumed
 *   identifier  the row's TBL/Quiz Details text, matched against column G
 *   code        the 5-digit LAMS lesson ID, written to column M
 *
 * The shared secret lives in Project Settings > Script properties as SHARED_SECRET, never in
 * this source, so the file can be kept in the repository and pasted into any sheet.
 */

const KANBAN_DETAILS_COLUMN = 7; // G: "TBL/Quiz Details"
const KANBAN_CODE_COLUMN = 13; // M: where the lesson code is written

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expectedSecret) {
      return kanbanJsonResponse({ status: 'error', message: 'SHARED_SECRET is not set in this script\'s Script properties' });
    }
    if (data.secret !== expectedSecret) {
      return kanbanJsonResponse({ status: 'error', message: 'Unauthorized' });
    }

    const code = String(data.code || '').trim();
    const identifier = String(data.identifier || '').trim();
    const tabName = String(data.tab || '').trim();

    if (!/^\d{5}$/.test(code)) {
      return kanbanJsonResponse({ status: 'error', message: 'Invalid code format: ' + code });
    }
    if (!identifier) {
      return kanbanJsonResponse({ status: 'error', message: 'Missing identifier' });
    }
    if (!tabName) {
      return kanbanJsonResponse({ status: 'error', message: 'Missing tab: name the Kanban tab to write to' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tab = kanbanFindTab(ss, tabName);
    if (!tab) {
      const names = ss.getSheets().map(sheet => '"' + sheet.getName() + '"').join(', ');
      return kanbanJsonResponse({ status: 'error', message: 'Tab not found: "' + tabName + '". Tabs: ' + names });
    }

    const details = tab.getRange(1, KANBAN_DETAILS_COLUMN, tab.getLastRow(), 1).getValues();
    const matches = [];
    details.forEach((row, index) => {
      if (String(row[0]).includes(identifier)) matches.push(index + 1);
    });

    if (matches.length === 0) {
      return kanbanJsonResponse({ status: 'error', message: 'Identifier not found in "' + tabName + '": ' + identifier });
    }
    // A shorter title can sit inside a longer one ("TBL1" in "TBL10"), so never guess a row.
    if (matches.length > 1) {
      return kanbanJsonResponse({
        status: 'error',
        message: 'Identifier matches rows ' + matches.join(', ') + ' in "' + tabName + '": ' + identifier
      });
    }

    tab.getRange(matches[0], KANBAN_CODE_COLUMN).setValue(code);
    SpreadsheetApp.flush();

    return kanbanJsonResponse({ status: 'ok', tab: tab.getName(), row: matches[0] });
  } catch (err) {
    return kanbanJsonResponse({ status: 'error', message: err.message });
  }
}

/**
 * The exact tab, else the one tab whose whole name matches ignoring case, spacing, and
 * "_" versus space (as the Kanban reader does). Never a partial name, and never a guess
 * between two tabs.
 */
function kanbanFindTab(ss, name) {
  const exact = ss.getSheetByName(name);
  if (exact) return exact;
  const normalize = text => String(text).replace(/_/g, ' ').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
  const wanted = normalize(name);
  const matches = ss.getSheets().filter(sheet => normalize(sheet.getName()) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

function kanbanJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
