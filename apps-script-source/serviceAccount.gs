/**
 * serviceAccount.gs — Service-account OAuth token for hidden-DB access.
 *
 * ARCHITECTURE (see /AGENTS.md): the Web App deploys "execute as the user
 * accessing", and end users must NOT have access to the backing spreadsheet.
 * Therefore the data layer cannot use SpreadsheetApp (that runs as the user and
 * would fail). Instead, SheetsAdapter talks to the Sheets REST API using THIS
 * service-account token, so all data access runs under the service account
 * while the rest of the request still runs as the real user.
 *
 * One-time setup (Script Properties → Project Settings):
 *   SA_CLIENT_EMAIL  = the service account's client_email
 *   SA_PRIVATE_KEY   = the service account's private_key (keep the \n newlines)
 * Share the backing spreadsheet with SA_CLIENT_EMAIL as Editor. Do NOT share it
 * with app users.
 */

var ServiceAccount = {

  TOKEN_SCOPE: 'https://www.googleapis.com/auth/spreadsheets',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  _CACHE_KEY: 'sa_access_token',

  /** @return {string} a cached or freshly minted service-account access token. */
  getAccessToken: function () {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(this._CACHE_KEY);
    if (cached) return cached;

    var props = PropertiesService.getScriptProperties();
    var clientEmail = props.getProperty('SA_CLIENT_EMAIL');
    var privateKey = props.getProperty('SA_PRIVATE_KEY');
    if (!clientEmail || !privateKey) {
      throw new Error('ServiceAccount not configured: set SA_CLIENT_EMAIL and SA_PRIVATE_KEY in Script Properties.');
    }
    var token = this._mintToken_(clientEmail, privateKey, this.TOKEN_SCOPE);
    // Google tokens last 3600s; cache a little under that.
    cache.put(this._CACHE_KEY, token, 3300);
    return token;
  },

  /**
   * Cached access token for another service account / scope (e.g. Firebase
   * Cloud Messaging). The caller supplies the credentials from Script Properties.
   */
  getAccessTokenFor: function (clientEmail, privateKey, scope, cacheKey) {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    if (cached) return cached;
    var token = this._mintToken_(clientEmail, privateKey, scope);
    cache.put(cacheKey, token, 3300);
    return token;
  },

  _mintToken_: function (clientEmail, privateKey, scope) {
    privateKey = privateKey.replace(/\\n/g, '\n');

    var now = Math.floor(Date.now() / 1000);
    var header = { alg: 'RS256', typ: 'JWT' };
    var claim = {
      iss: clientEmail,
      scope: scope,
      aud: this.TOKEN_URL,
      iat: now,
      exp: now + 3600
    };

    var toSign = this._b64url_(JSON.stringify(header)) + '.' + this._b64url_(JSON.stringify(claim));
    var signature = Utilities.computeRsaSha256Signature(toSign, privateKey);
    var jwt = toSign + '.' + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, '');

    var resp = UrlFetchApp.fetch(this.TOKEN_URL, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      muteHttpExceptions: true,
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      }
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      throw new Error('ServiceAccount token request failed (' + code + '): ' + body);
    }
    var parsed = JSON.parse(body);
    if (!parsed.access_token) {
      throw new Error('ServiceAccount token response missing access_token: ' + body);
    }
    return parsed.access_token;
  },

  _b64url_: function (str) {
    return Utilities.base64EncodeWebSafe(Utilities.newBlob(str).getBytes()).replace(/=+$/, '');
  }
};
