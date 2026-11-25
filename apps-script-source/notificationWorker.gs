/**
 * notificationWorker.gs — Notification Worker: push notifications (Firebase
 * Cloud Messaging) for kitchen requests.
 *
 * Owns the PushSubscriptions collection (one row per device token) and push
 * delivery. Nothing here decides WHEN a kitchen request exists — the kitchen
 * code calls notifyKitchenRequests() after it created a request or a reminder
 * fell due. Delivery never throws into the caller: a push failure must not
 * break a request or the reminder sweep.
 *
 * Events (routed by the Orchestrator):
 *   push.subscribed    → NotificationWorker.subscribe    (save this device's token)
 *   push.unsubscribed  → NotificationWorker.unsubscribe  (stop pushes to this device)
 *   push.test.requested → NotificationWorker.sendTest    (test push to the caller's own device)
 *
 * One-time setup per outlet (Apps Script → Project Settings → Script Properties):
 *   FIREBASE_SERVICE_ACCOUNT = the whole JSON key file of a Firebase service
 *   account (project_id, client_email, private_key). Never commit it.
 * Without it, subscribe still works and sending is skipped (the app falls back
 * to in-app polling notifications).
 */

var PUSH_SUBSCRIPTION_HEADERS = [
  'Token', 'Username', 'Outlet', 'Device ID', 'Language', 'Platform',
  'Active', 'Created At', 'Updated At', 'Last Error'
];

var NotificationWorker = {

  PERMISSION: 'kitchenCooking',
  FCM_SCOPE: 'https://www.googleapis.com/auth/firebase.messaging',
  /** More items than this in one alert become a single summary push per device. */
  SUMMARY_OVER: 3,

  // Copilot: Save this device's push token for the caller's outlet (Kitchen users only).
  subscribe: function (payload, ctx) {
    var session = requirePermission_(payload, this.PERMISSION);
    var outlet = String(session.outlet || '').trim();
    if (!outlet) return apiFail('No outlet is assigned to this account.', 'PUSH_NO_OUTLET');
    var token = String((payload && payload.token) || '').trim();
    if (!/^[A-Za-z0-9_:.\-]{20,4096}$/.test(token)) return apiFail('Invalid push token.', 'PUSH_BAD_TOKEN');

    Repo.ensureTable('PUSH_SUBSCRIPTIONS', PUSH_SUBSCRIPTION_HEADERS);
    var table = Repo.readTable('PUSH_SUBSCRIPTIONS');
    var now = new Date();
    var at = -1;
    for (var i = 0; i < table.rows.length; i++) {
      if (String(table.rows[i]['Token'] || '') === token) { at = i; break; }
    }
    var row = {
      'Token': token,
      'Username': session.username,
      'Outlet': outlet,
      'Device ID': session.deviceId || '',
      'Language': payload.lang === 'id' ? 'id' : 'en',
      'Platform': String(payload.platform || '').slice(0, 120),
      'Active': 'Y',
      'Created At': at >= 0 ? table.rows[at]['Created At'] : now,
      'Updated At': now,
      'Last Error': ''
    };
    if (at >= 0) this._writeRow_(table.headers, at, row);
    else Repo.appendObjects('PUSH_SUBSCRIPTIONS', row);
    return apiOk({ subscribed: true, sending: !!this._fcmConfig_() }, 'PUSH_SUBSCRIBED');
  },

  // Copilot: Stop pushes to this device token (sign-out, or notifications turned off).
  unsubscribe: function (payload, ctx) {
    var session = requireAuth_(payload);
    var token = String((payload && payload.token) || '').trim();
    if (!token) return apiFail('Token is required.', 'PUSH_BAD_TOKEN');
    var table = Repo.readTable('PUSH_SUBSCRIPTIONS');
    var changed = 0;
    for (var i = 0; i < table.rows.length; i++) {
      var r = table.rows[i];
      if (String(r['Token'] || '') !== token || String(r['Username'] || '') !== session.username) continue;
      r['Active'] = 'N';
      r['Updated At'] = new Date();
      this._writeRow_(table.headers, i, r);
      changed++;
    }
    return apiOk({ unsubscribed: changed }, 'PUSH_UNSUBSCRIBED');
  },

  /**
   * Push kitchen-request alerts to this outlet's subscribed devices.
   * items: [{ requestId, productName, remaining, requestedQty, requestedBy, reminder }]
   * options.excludeUsername: never alert the person who raised the request.
   * @return {{ sent: number, failed: number, removed: number, skipped?: string, error?: string }}
   */
  notifyKitchenRequests: function (outlet, items, options) {
    var result = { sent: 0, failed: 0, removed: 0 };
    try {
      if (!items || !items.length) return result;
      var cfg = this._fcmConfig_();
      if (!cfg) { result.skipped = 'not-configured'; return result; }

      var key = canonicalOutletKey_(outlet);
      var exclude = String((options && options.excludeUsername) || '').toLowerCase();
      var table = Repo.readTable('PUSH_SUBSCRIPTIONS');
      var seen = {};
      var subs = [];
      table.rows.forEach(function (r, i) {
        var token = String(r['Token'] || '');
        if (!token || seen[token] || String(r['Active'] || '').toUpperCase() !== 'Y') return;
        if (canonicalOutletKey_(String(r['Outlet'] || '')) !== key) return;
        if (exclude && String(r['Username'] || '').toLowerCase() === exclude) return;
        seen[token] = true;
        subs.push({ token: token, lang: r['Language'] === 'id' ? 'id' : 'en', index: i, row: r });
      });
      if (!subs.length) { result.skipped = 'no-devices'; return result; }

      var self = this;
      var sent = this._send_(cfg, table, subs, function (sub) {
        return items.length > self.SUMMARY_OVER
          ? [self._summaryData_(items, sub.lang)]
          : items.map(function (it) { return self._itemData_(it, sub.lang); });
      });
      result.sent = sent.sent;
      result.failed = sent.failed;
      result.removed = sent.removed;
    } catch (e) {
      result.error = String(e && e.message || e);
      try { Logger.log('notifyKitchenRequests error: ' + result.error); } catch (e2) { /* ignore */ }
    }
    return result;
  },

  /** For admin status: is push set up, and how many devices of this outlet receive alerts. */
  deviceSummary: function (outlet) {
    var key = canonicalOutletKey_(outlet);
    var seen = {};
    Repo.readTable('PUSH_SUBSCRIPTIONS').rows.forEach(function (r) {
      if (String(r['Active'] || '').toUpperCase() !== 'Y') return;
      if (key && canonicalOutletKey_(String(r['Outlet'] || '')) !== key) return;
      seen[String(r['Token'] || '')] = true;
    });
    return { configured: !!this._fcmConfig_(), devices: Object.keys(seen).filter(Boolean).length };
  },

  // Copilot: Send a test notification to the caller's own device(s) so they can
  // check the whole push chain. Optional delay (max 15 s) lets them close the app first.
  sendTest: function (payload, ctx) {
    var session = requirePermission_(payload, this.PERMISSION);
    var cfg = this._fcmConfig_();
    if (!cfg) {
      return apiFail('Push is not set up for this outlet yet: add FIREBASE_SERVICE_ACCOUNT to its Script Properties.', 'PUSH_NOT_CONFIGURED');
    }
    var token = String((payload && payload.token) || '').trim();
    var me = String(session.username || '').toLowerCase();
    var table = Repo.readTable('PUSH_SUBSCRIPTIONS');
    var subs = [];
    table.rows.forEach(function (r, i) {
      if (String(r['Active'] || '').toUpperCase() !== 'Y') return;
      if (String(r['Username'] || '').toLowerCase() !== me) return;
      if (token && String(r['Token'] || '') !== token) return;
      subs.push({ token: String(r['Token']), lang: r['Language'] === 'id' ? 'id' : 'en', index: i, row: r });
    });
    if (!subs.length) {
      return apiFail('This device is not registered for push. Turn notifications off and on again in the bell.', 'PUSH_NO_DEVICE');
    }
    var delay = Math.min(Math.max(Number(payload && payload.delaySeconds) || 0, 0), 15);
    if (delay) Utilities.sleep(delay * 1000);
    var self = this;
    var r = this._send_(cfg, table, subs, function (sub) {
      var tx = self._text_[sub.lang];
      return [{ type: 'test', tag: 'tsone-test', title: '🔔 ' + tx.testTitle, body: tx.testBody, renotify: '1' }];
    });
    if (!r.sent) {
      return apiFail('Firebase did not accept the test push: ' + (r.lastError || 'unknown error'), r.removed ? 'PUSH_DEVICE_EXPIRED' : 'PUSH_SEND_FAILED');
    }
    return apiOk({ sent: r.sent, failed: r.failed }, 'PUSH_TEST_SENT');
  },

  /**
   * Sends data-only pushes; `dataFor(sub)` returns the messages for one device.
   * Switches off tokens FCM reports as unregistered.
   * @return {{ sent: number, failed: number, removed: number, lastError: string }}
   */
  _send_: function (cfg, table, subs, dataFor) {
    var out = { sent: 0, failed: 0, removed: 0, lastError: '' };
    var accessToken = ServiceAccount.getAccessTokenFor(cfg.client_email, cfg.private_key, this.FCM_SCOPE, 'fcm_access_token');
    var url = 'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(cfg.project_id) + '/messages:send';
    var sends = [];
    subs.forEach(function (sub) {
      dataFor(sub).forEach(function (d) {
        sends.push({
          sub: sub,
          request: {
            url: url,
            method: 'post',
            contentType: 'application/json',
            headers: { Authorization: 'Bearer ' + accessToken },
            muteHttpExceptions: true,
            // Data-only message: the app's service worker builds the notification.
            payload: JSON.stringify({ message: { token: sub.token, webpush: { headers: { Urgency: 'high', TTL: '1800' }, data: d } } })
          }
        });
      });
    });
    if (!sends.length) return out;

    var responses = UrlFetchApp.fetchAll(sends.map(function (s) { return s.request; }));
    var dead = {};
    responses.forEach(function (resp, n) {
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) { out.sent++; return; }
      out.failed++;
      var body = resp.getContentText() || '';
      out.lastError = code + ' ' + body.slice(0, 300);
      // Token no longer valid (app uninstalled, permission revoked, …): stop using it.
      if (code === 404 || /UNREGISTERED|registration-token-not-registered|Requested entity was not found/i.test(body)) {
        dead[sends[n].sub.token] = { sub: sends[n].sub, error: code + ' ' + body.slice(0, 200) };
      } else {
        Logger.log('FCM send failed (' + code + '): ' + body.slice(0, 300));
      }
    });
    var self = this;
    Object.keys(dead).forEach(function (t) {
      var d = dead[t];
      d.sub.row['Active'] = 'N';
      d.sub.row['Updated At'] = new Date();
      d.sub.row['Last Error'] = d.error;
      self._writeRow_(table.headers, d.sub.index, d.sub.row);
      out.removed++;
    });
    return out;
  },

  _text_: {
    en: { newTitle: 'Cook more', reminderTitle: 'Still waiting', many: 'new kitchen requests', remaining: 'Remaining', qty: 'qty', by: 'by', testTitle: 'TSONE test notification', testBody: 'Push notifications work on this device.' },
    id: { newTitle: 'Masak lagi', reminderTitle: 'Masih menunggu', many: 'permintaan dapur baru', remaining: 'Sisa', qty: 'jml', by: 'oleh', testTitle: 'Notifikasi uji TSONE', testBody: 'Notifikasi push berfungsi di perangkat ini.' }
  },

  /** FCM data values must all be strings. */
  _itemData_: function (it, lang) {
    var tx = this._text_[lang];
    var name = String(it.productName || it.productCode || '?');
    var parts = [];
    if (it.remaining !== '' && it.remaining != null) parts.push(tx.remaining + ' ' + it.remaining);
    if (Number(it.requestedQty) > 0) parts.push(tx.qty + ' ' + it.requestedQty);
    if (it.requestedBy && it.requestedBy !== 'auto') parts.push(tx.by + ' ' + it.requestedBy);
    return {
      type: 'kitchen-request',
      requestId: String(it.requestId || ''),
      tag: 'kitchen-request:' + String(it.requestId || ''),
      title: (it.reminder ? '⏰ ' + tx.reminderTitle : '🍳 ' + tx.newTitle) + ': ' + name,
      body: parts.join(' · '),
      renotify: it.reminder ? '1' : '0'
    };
  },

  _summaryData_: function (items, lang) {
    var tx = this._text_[lang];
    return {
      type: 'kitchen-request',
      requestId: String(items[0].requestId || ''),
      tag: 'kitchen-request:summary',
      title: '🍳 ' + items.length + ' ' + tx.many,
      body: items.map(function (it) { return it.productName || it.productCode; }).join(', '),
      renotify: '1'
    };
  },

  /** Parsed FIREBASE_SERVICE_ACCOUNT, or null when push isn't set up for this outlet. */
  _fcmConfig_: function () {
    var raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT');
    if (!raw) return null;
    try {
      var cfg = JSON.parse(raw);
      return cfg.project_id && cfg.client_email && cfg.private_key ? cfg : null;
    } catch (e) {
      Logger.log('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
      return null;
    }
  },

  /** Overwrite data row `index` (0-based, below the header) of PushSubscriptions. */
  _writeRow_: function (headers, index, obj) {
    var values = headers.map(function (h) { return obj[h] == null ? '' : obj[h]; });
    var r = index + 2;
    Repo.updateRange('PUSH_SUBSCRIPTIONS', 'A' + r + ':' + this._col_(headers.length) + r, [values]);
  },

  _col_: function (n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
};
