/**
 * Kanban code sink: writes a published lesson's 5-digit LAMS code into the Kanban sheet, and
 * lets the automation read the sheet without the sheet being shared by link.
 *
 * Paste this into the spreadsheet's own Apps Script project (Extensions > Apps Script) and
 * deploy it as a Web App. It is bound to that spreadsheet through getActiveSpreadsheet(), so
 * every spreadsheet needs its own copy and its own deployment; see apps-script/README.md.
 *
 * Write a code - request body (JSON): { secret, code, identifier, tab }
 *   tab         the Kanban tab the user named for this run; no tab is assumed
 *   identifier  the row's TBL/Quiz Details text, matched against column G
 *   code        the 5-digit LAMS lesson ID, written to the "Lesson ID" column
 *
 * Read (never writes):
 *   { secret, action: 'tabs' }              -> { status: 'ok', tabs: [{ name, gid }] }
 *   { secret, action: 'read', tab: <exact> } -> { status: 'ok', tab, values: [[...], ...] }
 *   values are the cells as displayed, header row first, like the sheet's CSV export.
 *
 * The shared secret lives in Project Settings > Script properties as SHARED_SECRET, never in
 * this source, so the file can be kept in the repository and pasted into any sheet.
 */

// Columns are found by their header text, so inserting a column (as "(For Automation) Source
// Lesson" was inserted at L, moving "Lesson ID" from M to N) never sends the code elsewhere.
const KANBAN_DETAILS_HEADER = 'TBL/Quiz Details';
const KANBAN_CODE_HEADER = 'Lesson ID';

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

    if (data.action === 'tabs' || data.action === 'read') return kanbanRead(data);
    if (data.action !== undefined) {
      return kanbanJsonResponse({ status: 'error', message: 'Unknown action: ' + data.action });
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

    const detailsColumn = kanbanHeaderColumn(tab, KANBAN_DETAILS_HEADER);
    const codeColumn = kanbanHeaderColumn(tab, KANBAN_CODE_HEADER);
    if (typeof detailsColumn === 'string') return kanbanJsonResponse({ status: 'error', message: detailsColumn });
    if (typeof codeColumn === 'string') return kanbanJsonResponse({ status: 'error', message: codeColumn });

    const details = tab.getRange(1, detailsColumn, tab.getLastRow(), 1).getValues();
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

    tab.getRange(matches[0], codeColumn).setValue(code);
    SpreadsheetApp.flush();

    return kanbanJsonResponse({ status: 'ok', tab: tab.getName(), row: matches[0] });
  } catch (err) {
    return kanbanJsonResponse({ status: 'error', message: err.message });
  }
}

/**
 * The 1-based column whose header (row 1) is exactly `header`, spacing and case ignored, or an
 * error message when no column or more than one column has it, so a code is never written to a
 * guessed column.
 */
function kanbanHeaderColumn(tab, header) {
  const normalize = text => String(text).split(/\s+/).filter(Boolean).join(' ').toLowerCase();
  const names = tab.getRange(1, 1, 1, tab.getLastColumn()).getDisplayValues()[0];
  const columns = [];
  names.forEach((name, index) => {
    if (normalize(name) === normalize(header)) columns.push(index + 1);
  });
  if (columns.length === 1) return columns[0];
  return columns.length === 0
    ? 'No "' + header + '" column in "' + tab.getName() + '"'
    : 'Several "' + header + '" columns in "' + tab.getName() + '"';
}

/**
 * Read-only access for the Elentra scripts. Reading takes the exact tab name: the caller lists
 * the tabs first and resolves the name the user typed itself, so both read paths (this one and
 * the shared-link CSV export) choose tabs by the same rules.
 */
function kanbanRead(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (data.action === 'tabs') {
    const tabs = ss.getSheets().map(sheet => ({ name: sheet.getName(), gid: String(sheet.getSheetId()) }));
    return kanbanJsonResponse({ status: 'ok', tabs: tabs });
  }
  const tabName = String(data.tab || '');
  const tab = tabName ? ss.getSheetByName(tabName) : null;
  if (!tab) {
    return kanbanJsonResponse({ status: 'error', message: 'Tab not found: "' + tabName + '"' });
  }
  return kanbanJsonResponse({ status: 'ok', tab: tab.getName(), values: tab.getDataRange().getDisplayValues() });
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
