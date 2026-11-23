/**
 * Shared helpers live in utils.js — do not redeclare getSheetData, monthKey, etc.
 *
 * The server-rendered HTML UI has been removed. The only application entry
 * point is doPost (apiRouter.gs), used by the PWA client. doGet just reports
 * status so opening the Web App URL in a browser doesn't error.
 */
function doGet(e) {
  var body = 'TSONE API is running. Use POST /exec with { eventType, payload, ctx }.';
  if (!initializeSpreadsheet()) {
    var detail = getLastSpreadsheetInitError_();
    body = 'Error: Could not initialize spreadsheet' + (detail ? '\n\n' + detail : '');
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.TEXT);
}

function getPaymentSources() {
  try {
    Logger.log("=== Getting Payment Sources ===");

    if (typeof SHEETS === 'undefined') {
      Logger.log("SHEETS configuration not accessible");
      return [];
    }

    const spreadsheet = getGlobalSpreadsheet();
    if (!spreadsheet) {
      Logger.log("Unable to access spreadsheet");
      return [];
    }

    const sheet = spreadsheet.getSheetByName(SHEETS.PAYMENT_SOURCES);
    if (!sheet) {
      Logger.log("Payment Sources sheet not found");
      return [];
    }

    const data = sheet.getDataRange().getValues();
    Logger.log("Retrieved " + data.length + " rows from Payment Sources sheet");

    if (data.length < 2) {
      Logger.log("No data rows found (only headers or empty sheet)");
      return [];
    }

    data.shift();
    const nameCol = COLUMNS.PAYMENT_SOURCES.NAME.col;
    const sources = data.map(function(row) { return row[nameCol]; }).filter(Boolean);
    Logger.log("Returning " + sources.length + " payment sources: " + JSON.stringify(sources));

    return sources;

  } catch (error) {
    Logger.log("Error getting payment sources: " + error.toString());
    return [];
  }
}

function getTutorials() {
  try {
    const spreadsheet = getGlobalSpreadsheet();
    if (!spreadsheet) {
      throw new Error("Could not access spreadsheet");
    }

    const sheet = spreadsheet.getSheetByName(SHEETS.TUTORIALS);
    if (!sheet) {
      throw new Error("Tutorials sheet not found");
    }

    const range = sheet.getDataRange();
    const values = range.getValues();

    if (values.length < 2) {
      return [];
    }

    const headers = values[0];
    const tutorials = [];

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const tutorial = {
        courseId: getFixedRowField(row, 'TUTORIALS', 'COURSE_ID') || '',
        description: getFixedRowField(row, 'TUTORIALS', 'DESCRIPTION') || '',
        category: getFixedRowField(row, 'TUTORIALS', 'CATEGORY') || '',
        supplier: getFixedRowField(row, 'TUTORIALS', 'SUPPLIER') || '',
        status: getFixedRowField(row, 'TUTORIALS', 'STATUS') || '',
        url: getFixedRowField(row, 'TUTORIALS', 'URL') || ''
      };

      if (tutorial.courseId || tutorial.description) {
        tutorials.push(tutorial);
      }
    }

    Logger.log(`Retrieved ${tutorials.length} tutorials from Tutorials sheet`);
    return tutorials;

  } catch (error) {
    Logger.log('Error in getTutorials: ' + error.toString());
    throw error;
  }
}
