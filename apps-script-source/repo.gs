/**
 * repo.gs — Data Access Layer facade (Seam 2, see /AGENTS.md).
 *
 * Business logic (Orchestrator → Workers) MUST read and write data only through
 * Repo — never SpreadsheetApp and never a specific adapter directly. Repo is
 * provider-agnostic: it maps SHEETS keys to the underlying store and delegates
 * to the active adapter. By default this is SpreadsheetAppAdapter (Option C:
 * execute-as-owner, no Google Cloud, free). To switch to the service-account
 * REST path (Option B, per-user concurrency) set `Repo.adapter = SheetsAdapter`;
 * to migrate the database, implement a new adapter with the same method surface
 * (getValues / getValuesFromEnd / ensureTable / appendRows / updateValues /
 * clearRange; getHeaders is optional) and set `Repo.adapter`.
 *
 * Methods are collection-oriented and work with row OBJECTS keyed by the sheet's
 * header row, so callers don't depend on column order.
 */

var Repo = {

  /**
   * Explicit adapter override. Leave null to use the default (Option C,
   * SpreadsheetAppAdapter). Set to SheetsAdapter to switch to the service-account
   * REST path (Option B), or to any future adapter to migrate the database.
   */
  adapter: null,

  /** Resolve the active adapter lazily (avoids Apps Script file load-order issues). */
  _adapter: function () {
    if (this.adapter) return this.adapter;
    if (typeof SpreadsheetAppAdapter !== 'undefined') return SpreadsheetAppAdapter;
    if (typeof SheetsAdapter !== 'undefined') return SheetsAdapter;
    throw new Error('Repo: no data adapter available.');
  },

  /** Resolve a SHEETS key (e.g. 'ORDERS') or a literal sheet name to a name. */
  _name: function (collection) {
    if (!collection) throw new Error('Repo: collection is required.');
    return (SHEETS && SHEETS[collection]) ? SHEETS[collection] : collection;
  },

  /**
   * Read a whole collection as an array of objects keyed by the header row.
   * @param {string} collection SHEETS key or sheet name.
   * @return {{ headers: string[], rows: Object[] }}
   */
  readTable: function (collection) {
    var values = this._adapter().getValues(this._name(collection));
    if (!values.length) return { headers: [], rows: [] };
    var headers = values[0].map(function (h) { return (h == null ? '' : String(h)).trim(); });
    var rows = [];
    for (var r = 1; r < values.length; r++) {
      rows.push(this._rowToObject_(headers, values[r]));
    }
    return { headers: headers, rows: rows };
  },

  /**
   * Read only the header row (cheap: no data rows). Use before appends instead
   * of readTable, whose cost grows with the collection.
   * Same width and trimming as readTable().headers.
   * @return {string[]} headers; [] if the collection is missing/empty.
   */
  readHeaders: function (collection) {
    var name = this._name(collection);
    var adapter = this._adapter();
    var row = (typeof adapter.getHeaders === 'function')
      ? adapter.getHeaders(name)
      : ((adapter.getValues(name + '!1:1') || [])[0] || []);
    return row.map(function (h) { return (h == null ? '' : String(h)).trim(); });
  },

  /** Convenience: just the row objects for a collection. */
  readRows: function (collection) {
    return this.readTable(collection).rows;
  },

  /**
   * Read a window of data rows counted back from the end of a collection.
   * SpreadsheetAppAdapter serves this without reading older order rows.
   * @return {{ headers: string[], rows: Object[], startRow: number, totalRows: number }}
   */
  readRowsFromEnd: function (collection, offset, count, anchorTotalRows) {
    var name = this._name(collection);
    var adapter = this._adapter();
    var result;
    if (typeof adapter.getValuesFromEnd === 'function') {
      result = adapter.getValuesFromEnd(name, offset, count, anchorTotalRows);
    } else {
      var values = adapter.getValues(name);
      var headers = values.length ? values[0].map(function (h) {
        return (h == null ? '' : String(h)).trim();
      }) : [];
      var availableRows = Math.max(0, values.length - 1);
      var totalRows = anchorTotalRows === undefined
        ? availableRows
        : Math.min(availableRows, Math.max(0, Number(anchorTotalRows) || 0));
      var end = Math.max(0, totalRows - Math.max(0, Number(offset) || 0));
      var start = Math.max(0, end - Math.max(0, Number(count) || 0));
      result = {
        headers: headers,
        rows: values.slice(start + 1, end + 1),
        startRow: start + 2,
        totalRows: totalRows
      };
    }

    return {
      headers: result.headers || [],
      rows: (result.rows || []).map(function (row) {
        return Repo._rowToObject_(result.headers || [], row);
      }),
      startRow: result.startRow || 2,
      totalRows: result.totalRows || 0
    };
  },

  /** Ensure a collection exists with the supplied header row. */
  ensureTable: function (collection, headers) {
    var adapter = this._adapter();
    if (typeof adapter.ensureTable !== 'function') {
      throw new Error('Repo: active adapter cannot ensure tables.');
    }
    return adapter.ensureTable(this._name(collection), headers);
  },

  /**
   * Replace collection data rows while retaining the existing header row.
   * Callers coordinating read-modify-write updates must hold the appropriate lock.
   */
  replaceRows: function (collection, objects) {
    var name = this._name(collection);
    var table = this.readTable(collection);
    if (!table.headers.length) {
      throw new Error('Repo.replaceRows: collection "' + collection + '" has no header row.');
    }
    var list = Array.isArray(objects) ? objects : [];
    var values = list.map(function (obj) {
      return table.headers.map(function (header) {
        var value = obj[header];
        return value == null ? '' : value;
      });
    });
    var lastColumn = table.headers.length;
    var columnName = '';
    while (lastColumn > 0) {
      var remainder = (lastColumn - 1) % 26;
      columnName = String.fromCharCode(65 + remainder) + columnName;
      lastColumn = Math.floor((lastColumn - 1) / 26);
    }
    var adapter = this._adapter();
    adapter.clearRange(name + '!A2:' + columnName);
    if (values.length) adapter.appendRows(name, values);
    return { replaced: values.length };
  },

  /**
   * Append one or more objects to a collection, aligning each object's values to
   * the existing header row.
   * @param {string} collection
   * @param {Object|Object[]} objects
   */
  appendObjects: function (collection, objects) {
    var list = Array.isArray(objects) ? objects : [objects];
    if (!list.length) return { appended: 0 };
    var headers = this.readHeaders(collection);
    if (!headers.length) {
      throw new Error('Repo.appendObjects: collection "' + collection + '" has no header row.');
    }
    var rows = list.map(function (obj) {
      return headers.map(function (h) {
        var v = obj[h];
        return v == null ? '' : v;
      });
    });
    this._adapter().appendRows(this._name(collection), rows);
    return { appended: rows.length };
  },

  /** Append raw 2D rows when you already have ordered arrays. */
  appendRows: function (collection, rows) {
    this._adapter().appendRows(this._name(collection), rows);
    return { appended: (rows || []).length };
  },

  /** Overwrite an explicit A1 range within a collection, e.g. 'A2:F2'. */
  updateRange: function (collection, a1, rows) {
    this._adapter().updateValues(this._name(collection) + '!' + a1, rows);
  },

  _rowToObject_: function (headers, row) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = (c < row.length) ? row[c] : '';
    }
    return obj;
  }
};

/**
 * repoSelfTest — run from the Apps Script editor (Run ▸ repoSelfTest) to verify
 * the data layer reads through the active adapter. Read-only; writes nothing.
 * Reads the Products sheet and logs the active adapter, header count, and row
 * count. Returns a short status string.
 */
function repoSelfTest() {
  try {
    var adapterName = (Repo._adapter() === (typeof SpreadsheetAppAdapter !== 'undefined' ? SpreadsheetAppAdapter : null))
      ? 'SpreadsheetAppAdapter (Option C)'
      : 'SheetsAdapter (Option B)';
    var table = Repo.readTable('PRODUCTS');
    var msg = 'Repo OK via ' + adapterName + ' — headers: ' + table.headers.length +
      ', rows: ' + table.rows.length;
    Logger.log(msg);
    return msg;
  } catch (e) {
    var err = 'repoSelfTest FAILED: ' + e.toString();
    Logger.log(err);
    return err;
  }
}
