/**
 * Spotify Hörbuch-Weiterhören
 * ============================
 * Protokolliert Gehörtes inkl. Abspielposition in ein Google Sheet und stellt
 * eine mobile Web-App bereit, mit der sich ein Hörbuch exakt an der letzten
 * Stelle fortsetzen lässt.
 *
 * Einrichtung
 * -----------
 * 1) Spotify-App:  https://developer.spotify.com/dashboard
 * 2) Google Sheet → Erweiterungen → Apps Script. Dort diese Datei als Code.gs
 *    und die Index.html anlegen.
 * 3) OAuth2-Bibliothek hinzufügen:
 *    Script-ID 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 * 4) logRedirectUri() ausführen und die geloggte URL bei Spotify unter
 *    "Redirect URIs" eintragen.
 * 5) Im Editor einmal setCredentials('<CLIENT_ID>', '<CLIENT_SECRET>') ausführen.
 * 6) setup() ausführen: legt Sheets, Kopfzeile, Formate und den Trigger an.
 * 7) run() ausführen, die geloggte Authorization-URL öffnen, Zugriff erlauben.
 * 8) Bereitstellen → Neue Bereitstellung → Web-App
 *    ("Ausführen als: Ich", "Zugriff: Nur ich"). Die /exec-URL auf dem Handy
 *    zum Startbildschirm hinzufügen.
 *
 * Hinweis zu Scopes: Für das Fortsetzen an exakter Position wird
 * user-modify-playback-state benötigt (Spotify Premium). Nach einer Änderung
 * der Scopes einmal reset() ausführen und neu autorisieren.
 */

var CONFIG = {
  LOG_SHEET: 'Log',

  // Wie viele Sekunden vor der gemerkten Position wieder eingestiegen wird.
  // Gibt beim Wiedereinstieg Kontext, so wie es Hörbuch-Apps machen.
  REWIND_SECONDS: 20,

  // Hörbuch-Erkennung
  AUDIOBOOK_MIN_MINUTES: 10,          // Tracks ab dieser Länge gelten als Hörbuch
  AUDIOBOOK_PATTERNS: [               // ... oder wenn Track/Album so heißt
    'kapitel', 'kapitel \\d', 'teil \\d', 'chapter', 'track \\d{2}',
    'hörbuch', 'horbuch', 'gekürzt', 'ungekürzt', 'folge \\d', 'akt \\d'
  ],

  // Abspielsteuerung (Premium). false = nur Deep-Links in die Spotify-App.
  ENABLE_PLAYBACK_CONTROL: true,

  POLL_MINUTES: 5,                    // Trigger-Intervall = Positionsgenauigkeit
  DEDUPE_WINDOW_MIN: 45,              // Fenster gegen Doppeleinträge
  SCAN_ROWS: 400                      // wie viele Zeilen die App durchsucht
};

var HEADERS = ['Gehört am', 'Typ', 'Interpret', 'Album', 'Track',
               'Position', 'Länge', 'Link', 'Position (ms)', 'URI', 'Cover'];
var C = { DATE: 1, TYPE: 2, ARTIST: 3, ALBUM: 4, TRACK: 5,
          POS: 6, LEN: 7, LINK: 8, POS_MS: 9, URI: 10, IMAGE: 11 };

var PROP_CURSOR = 'lastPlayedAtMs';


/* =========================================================================
 * Einrichtung
 * ========================================================================= */

function setCredentials(clientId, clientSecret) {
  PropertiesService.getScriptProperties()
    .setProperties({ CLIENT_ID: clientId, CLIENT_SECRET: clientSecret });
}

function setup() {
  var sheet = getLogSheet();
  ensureHeader(sheet);

  // Alte Trigger entfernen, damit setup() mehrfach laufen darf.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create();

  Logger.log('Fertig. Trigger läuft alle %s Minuten.', CONFIG.POLL_MINUTES);
}

function ensureHeader(sheet) {
  var range = sheet.getRange(1, 1, 1, HEADERS.length);
  if (range.getValue() !== HEADERS[0]) range.setValues([HEADERS]);
  range.setFontWeight('bold').setBackground('#191414').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.getRange(1, C.DATE, sheet.getMaxRows(), 1).setNumberFormat('dd.MM.yyyy HH:mm');
  [C.POS_MS, C.URI, C.IMAGE].forEach(function (col) { sheet.hideColumns(col); });
  sheet.setColumnWidth(C.TRACK, 260);
  sheet.setColumnWidth(C.ALBUM, 220);
}

function getLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(CONFIG.LOG_SHEET) || ss.insertSheet(CONFIG.LOG_SHEET);
}


/* =========================================================================
 * Hauptlauf (Trigger)
 * ========================================================================= */

function run() {
  var service = getService();
  if (!service.hasAccess()) {
    Logger.log('Nicht autorisiert. Diese URL öffnen:\n%s', service.getAuthorizationUrl());
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // verhindert Doppelläufe

  try {
    var sheet = getLogSheet();
    ensureHeader(sheet);
    pollPlayback(sheet);          // liefert die Position – der wichtige Teil
    syncRecentlyPlayed(sheet);    // schließt Lücken zwischen zwei Läufen
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fragt ab, was gerade läuft, und merkt sich die Position im Track.
 * additional_types=episode sorgt dafür, dass auch Podcasts und echte
 * Spotify-Hörbuchkapitel zurückkommen – die fehlen in recently-played.
 */
function pollPlayback(sheet) {
  var res = spotifyGet('/me/player?additional_types=episode');
  if (!res || res.code === 204 || !res.body || !res.body.item) return;

  var item = res.body.item;
  var entry = toEntry(item, new Date(), res.body.progress_ms || 0);
  var top = readRows(sheet, 1);

  if (top.length && top[0][C.URI - 1] === entry.uri) {
    // Gleicher Track wie zuletzt: nur Zeitstempel und Position aktualisieren.
    sheet.getRange(2, C.DATE).setValue(entry.date);
    sheet.getRange(2, C.POS).setValue(msToClock(entry.positionMs));
    sheet.getRange(2, C.POS_MS).setValue(entry.positionMs);
  } else {
    prependRows(sheet, [entryToRow(entry)]);
  }
}

/**
 * Holt alles, was seit dem letzten Cursor gespielt wurde. Ohne Position,
 * aber lückenlos – etwa wenn zwischen zwei Läufen drei Songs liefen.
 */
function syncRecentlyPlayed(sheet) {
  var cursor = PropertiesService.getUserProperties().getProperty(PROP_CURSOR);
  var path = '/me/player/recently-played?limit=50' + (cursor ? '&after=' + cursor : '');
  var res = spotifyGet(path);
  if (!res || !res.body || !res.body.items || !res.body.items.length) return;

  var known = readRows(sheet, 100);   // zum Entdoppeln
  var rows = [];

  res.body.items.forEach(function (i) {
    var entry = toEntry(i.track, new Date(i.played_at), null);
    if (!isDuplicate(known, entry)) rows.push(entryToRow(entry));
  });

  if (rows.length) prependRows(sheet, rows);   // Spotify liefert neueste zuerst

  var newest = new Date(res.body.items[0].played_at).getTime();
  PropertiesService.getUserProperties().setProperty(PROP_CURSOR, String(newest + 1));
}

function isDuplicate(rows, entry) {
  var windowMs = CONFIG.DEDUPE_WINDOW_MIN * 60 * 1000;
  return rows.some(function (r) {
    if (r[C.URI - 1] !== entry.uri) return false;
    var d = r[C.DATE - 1];
    return d instanceof Date && Math.abs(d.getTime() - entry.date.getTime()) < windowMs;
  });
}


/* =========================================================================
 * Daten für die Web-App
 * ========================================================================= */

/**
 * Ein Eintrag pro Hörbuch/Album – der jeweils zuletzt gehörte Track.
 * Genau das, was man zum Weiterhören braucht.
 */
function getResumeItems(showAll) {
  var sheet = getLogSheet();
  var rows = readRows(sheet, CONFIG.SCAN_ROWS);
  var seen = {}, out = [];

  rows.forEach(function (r) {
    var album = r[C.ALBUM - 1] || r[C.TRACK - 1];
    var isBook = r[C.TYPE - 1] === 'Hörbuch';
    if (!showAll && !isBook) return;
    if (seen[album]) return;
    seen[album] = true;

    out.push({
      album: album,
      artist: r[C.ARTIST - 1],
      track: r[C.TRACK - 1],
      type: r[C.TYPE - 1],
      when: formatWhen(r[C.DATE - 1]),
      position: r[C.POS - 1] || '',
      positionMs: Number(r[C.POS_MS - 1]) || 0,
      length: r[C.LEN - 1] || '',
      percent: percentOf(r[C.POS_MS - 1], r[C.LEN - 1]),
      link: r[C.LINK - 1],
      uri: r[C.URI - 1],
      image: r[C.IMAGE - 1]
    });
  });

  return {
    items: out.slice(0, 25),
    playbackControl: CONFIG.ENABLE_PLAYBACK_CONTROL,
    rewind: CONFIG.REWIND_SECONDS
  };
}

/**
 * Startet die Wiedergabe an der gemerkten Stelle – abzüglich Rücksprung.
 * Braucht Premium und ein bekanntes Gerät.
 */
function resumePlayback(uri, positionMs) {
  if (!CONFIG.ENABLE_PLAYBACK_CONTROL) return { ok: false, message: 'Abspielsteuerung ist deaktiviert.' };

  var target = Math.max(0, (Number(positionMs) || 0) - CONFIG.REWIND_SECONDS * 1000);
  var device = pickDevice();
  if (!device) {
    return { ok: false, message: 'Kein Gerät gefunden. Spotify kurz öffnen und erneut tippen.' };
  }

  var isEpisode = uri.indexOf(':episode:') > -1;
  var payload = isEpisode ? { uris: [uri], position_ms: target }
                          : { uris: [uri], position_ms: target };

  var res = spotifyRequest('put', '/me/player/play?device_id=' + device.id, payload);

  if (res.code === 204 || res.code === 202) {
    return { ok: true, message: 'Läuft auf ' + device.name + ' ab ' + msToClock(target) + '.' };
  }
  if (res.code === 403) {
    return { ok: false, message: 'Spotify lehnt die Steuerung ab – dafür wird Premium benötigt.' };
  }
  if (res.code === 404) {
    return { ok: false, message: 'Gerät nicht mehr aktiv. Spotify kurz öffnen und erneut tippen.' };
  }
  return { ok: false, message: 'Fehler ' + res.code + ': ' + (res.raw || '').slice(0, 120) };
}

function pickDevice() {
  var res = spotifyGet('/me/player/devices');
  var devices = (res && res.body && res.body.devices) || [];
  if (!devices.length) return null;
  var active = devices.filter(function (d) { return d.is_active; })[0];
  var phone = devices.filter(function (d) { return d.type === 'Smartphone'; })[0];
  return active || phone || devices[0];
}


/* =========================================================================
 * Web-App
 * ========================================================================= */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Weiterhören')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* =========================================================================
 * Hilfsfunktionen
 * ========================================================================= */

/** Normalisiert Track-, Episoden- und Kapitel-Objekte auf eine Form. */
function toEntry(item, date, progressMs) {
  var album = item.album ? item.album.name
            : item.show ? item.show.name
            : item.audiobook ? item.audiobook.name
            : '';
  var artist = item.artists ? item.artists.map(function (a) { return a.name; }).join(', ')
             : item.audiobook && item.audiobook.authors
               ? item.audiobook.authors.map(function (a) { return a.name; }).join(', ')
             : item.show ? item.show.name
             : '';
  var images = (item.album && item.album.images) || item.images || [];

  return {
    date: date,
    type: classify(item, album, artist),
    artist: artist,
    album: album,
    track: item.name,
    positionMs: progressMs,
    durationMs: item.duration_ms || 0,
    link: (item.external_urls && item.external_urls.spotify) || '',
    uri: item.uri,
    image: images.length ? images[images.length - 1].url : ''
  };
}

function entryToRow(e) {
  var row = [];
  row[C.DATE - 1] = e.date;
  row[C.TYPE - 1] = e.type;
  row[C.ARTIST - 1] = e.artist;
  row[C.ALBUM - 1] = e.album;
  row[C.TRACK - 1] = e.track;
  row[C.POS - 1] = e.positionMs === null ? '' : msToClock(e.positionMs);
  row[C.LEN - 1] = msToClock(e.durationMs);
  row[C.LINK - 1] = e.link;
  row[C.POS_MS - 1] = e.positionMs === null ? '' : e.positionMs;
  row[C.URI - 1] = e.uri;
  row[C.IMAGE - 1] = e.image;
  return row;
}

/**
 * Hörbuch oder Musik? Podcasts und Kapitel sind eindeutig, sonst entscheiden
 * Tracklänge und Namensmuster. Manuelle Ausnahmen über die Script Properties.
 */
function classify(item, album, artist) {
  if (item.type === 'episode' || item.type === 'chapter') return 'Hörbuch';

  var overrides = getOverrides();
  if (overrides.music[album.toLowerCase()]) return 'Musik';
  if (overrides.books[album.toLowerCase()]) return 'Hörbuch';

  if ((item.duration_ms || 0) >= CONFIG.AUDIOBOOK_MIN_MINUTES * 60000) return 'Hörbuch';

  var haystack = (item.name + ' ' + album + ' ' + artist).toLowerCase();
  var hit = CONFIG.AUDIOBOOK_PATTERNS.some(function (p) {
    return new RegExp(p, 'i').test(haystack);
  });
  return hit ? 'Hörbuch' : 'Musik';
}

/** Album dauerhaft als Hörbuch bzw. als Musik einstufen. */
function markAsAudiobook(albumName) { addOverride('books', albumName); }
function markAsMusic(albumName) { addOverride('music', albumName); }

function addOverride(kind, albumName) {
  var props = PropertiesService.getScriptProperties();
  var list = JSON.parse(props.getProperty('override_' + kind) || '[]');
  var key = String(albumName).toLowerCase();
  if (list.indexOf(key) === -1) list.push(key);
  props.setProperty('override_' + kind, JSON.stringify(list));
}

function getOverrides() {
  var props = PropertiesService.getScriptProperties();
  var toMap = function (json) {
    var m = {};
    JSON.parse(json || '[]').forEach(function (k) { m[k] = true; });
    return m;
  };
  return {
    books: toMap(props.getProperty('override_books')),
    music: toMap(props.getProperty('override_music'))
  };
}

function prependRows(sheet, rows) {
  sheet.insertRowsAfter(1, rows.length);
  sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.getRange(2, C.DATE, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm');
}

/** Liest die obersten n Datenzeilen (ohne Kopfzeile). */
function readRows(sheet, n) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var count = Math.min(n, last - 1);
  return sheet.getRange(2, 1, count, HEADERS.length).getValues();
}

function msToClock(ms) {
  if (!ms && ms !== 0) return '';
  var total = Math.round(ms / 1000);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  var pad = function (v) { return v < 10 ? '0' + v : String(v); };
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function percentOf(posMs, lengthClock) {
  var pos = Number(posMs);
  if (!pos || !lengthClock) return 0;
  var parts = String(lengthClock).split(':').map(Number).reverse();
  var lenMs = ((parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600) * 1000;
  return lenMs ? Math.min(100, Math.round(pos / lenMs * 100)) : 0;
}

function formatWhen(date) {
  if (!(date instanceof Date)) return '';
  var diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 2) return 'gerade eben';
  if (diffMin < 60) return 'vor ' + diffMin + ' Min.';
  if (diffMin < 24 * 60) return 'vor ' + Math.round(diffMin / 60) + ' Std.';
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(date, tz, 'dd.MM. HH:mm');
}


/* =========================================================================
 * Spotify-Zugriff
 * ========================================================================= */

function spotifyGet(path) { return spotifyRequest('get', path, null); }

function spotifyRequest(method, path, payload) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getService().getAccessToken() },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  var response = UrlFetchApp.fetch('https://api.spotify.com/v1' + path, options);
  var code = response.getResponseCode();
  var raw = response.getContentText();

  if (code === 429) Logger.log('Rate Limit – Retry-After: %s', response.getHeaders()['Retry-After']);
  if (code >= 400) Logger.log('Spotify %s %s → %s %s', method, path, code, raw.slice(0, 200));

  var body = null;
  if (raw && code < 300) { try { body = JSON.parse(raw); } catch (e) { body = null; } }
  return { code: code, body: body, raw: raw };
}

function getService() {
  var props = PropertiesService.getScriptProperties();
  var scopes = ['user-read-recently-played', 'user-read-playback-state'];
  if (CONFIG.ENABLE_PLAYBACK_CONTROL) scopes.push('user-modify-playback-state');

  return OAuth2.createService('Spotify')
    .setAuthorizationBaseUrl('https://accounts.spotify.com/authorize')
    .setTokenUrl('https://accounts.spotify.com/api/token')
    .setClientId(props.getProperty('CLIENT_ID'))
    .setClientSecret(props.getProperty('CLIENT_SECRET'))
    .setScope(scopes.join(' '))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties());
}

function authCallback(request) {
  var ok = getService().handleCallback(request);
  return HtmlService.createHtmlOutput(ok ? 'Verbunden. Tab kann geschlossen werden.' : 'Zugriff verweigert.');
}

function reset() { getService().reset(); }

function logRedirectUri() { Logger.log(OAuth2.getRedirectUri()); }
