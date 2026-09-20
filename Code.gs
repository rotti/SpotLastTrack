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
 *    und die Index.html anlegen. Danach speichern und das Sheet-Tab einmal
 *    neu laden (F5) – erst dann erscheint das Menü aus Schritt 3.
 * 3) OAuth2-Bibliothek hinzufügen:
 *    Script-ID 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 * 4) Zurück im Google Sheet: Menü "Spotify" → "Einrichten (Zugangsdaten +
 *    Verbindung)". Fragt Client-ID und Client-Secret ab und erledigt danach
 *    automatisch: Sheet/Header anlegen, 1-Minuten-Trigger setzen und den
 *    Autorisierungs-Dialog öffnen (inkl. der Redirect-URI zum Eintragen bei
 *    Spotify, falls noch nicht geschehen).
 * 5) Im geöffneten Dialog den Link zu Spotify öffnen und den Zugriff
 *    erlauben. Das ist der einzige Schritt, der zwingend von Hand passiert –
 *    er ist Teil des OAuth-Protokolls und lässt sich nicht automatisieren.
 *    Danach läuft alles über den Trigger, ohne weitere Interaktion:
 *    Positions-Tracking, Lücken-Sync, Hörbuch-Erkennung, Token-Erneuerung.
 * 6) Bereitstellen → Neue Bereitstellung → Web-App
 *    ("Ausführen als: Ich", "Zugriff: Nur ich"). Die /exec-URL auf dem Handy
 *    zum Startbildschirm hinzufügen.
 *
 * "Status prüfen" im Menü zeigt jederzeit, ob Verbindung und Trigger aktiv
 * sind und wann zuletzt synchronisiert wurde – nur zur Kontrolle, für den
 * Betrieb nicht nötig.
 *
 * Hinweis zu Scopes: Für das Fortsetzen an exakter Position wird
 * user-modify-playback-state benötigt (Spotify Premium). Nach einer Änderung
 * der Scopes einmal im Menü "Verbindung zurücksetzen" wählen und über
 * "Einrichten" neu autorisieren.
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

  // Serien-Erkennung: Hörbücher erzeugen lange Ketten mit gleichem
  // Interpreten (dem Autor/Sprecher), Musik wechselt häufiger. Ergänzt die
  // Längen-/Namenserkennung in classify() um Fälle, in denen Hörbücher wie
  // normale, kurze Musik-Tracks geschnitten sind.
  STREAK_MIN_RUN: 4,          // ab so vielen Tracks am Stück vom selben Interpreten
  STREAK_MIN_RUN_SEQUENTIAL: 2, // ab so vielen, wenn Titel zusätzlich hochzählen
  STREAK_SCAN_ROWS: 600,        // wie weit die Ketten-Analyse beim Sync zurückschaut

  POLL_MINUTES: 1,                    // Trigger-Intervall = Positionsgenauigkeit
  DEDUPE_WINDOW_MIN: 45,              // Fenster gegen Doppeleinträge
  SCAN_ROWS: 400                      // wie viele Zeilen die App durchsucht
};

var HEADERS = ['Gehört am', 'Typ', 'Interpret', 'Album', 'Track',
               'Position', 'Länge', 'Link', 'Position (ms)', 'URI', 'Cover'];
var C = { DATE: 1, TYPE: 2, ARTIST: 3, ALBUM: 4, TRACK: 5,
          POS: 6, LEN: 7, LINK: 8, POS_MS: 9, URI: 10, IMAGE: 11 };

var PROP_CURSOR = 'lastPlayedAtMs';


/* =========================================================================
 * Einrichtung über Sheets-Menü
 * ========================================================================= */

/**
 * Läuft automatisch beim Öffnen des Google Sheets und baut das Menü auf.
 * Ohne dieses Menü müsste jede Einrichtung über manuelles Ausführen von
 * Funktionen im Script-Editor erfolgen – das ist der Teil, der bisher
 * fehleranfällig war, gerade beim allerersten Mal nach einer Codeänderung.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Spotify')
    .addItem('Einrichten (Zugangsdaten + Verbindung)', 'promptForCredentials')
    .addSeparator()
    .addItem('Status prüfen', 'checkConnection')
    .addItem('Jetzt synchronisieren', 'runFromMenu')
    .addItem('Neu klassifizieren (ganzes Log)', 'reclassifyAllFromMenu')
    .addItem('Sheet reparieren (Zeit-Zellen)', 'repairTimeCellsFromMenu')
    .addSeparator()
    .addItem('Verbindung zurücksetzen', 'resetFromMenu')
    .addItem('Redirect-URI anzeigen', 'showRedirectUri')
    .addToUi();
}

/**
 * Der EINZIGE Schritt, der von Hand ausgeführt werden muss. Fragt
 * Client-ID und Secret ab und stößt danach automatisch alles Weitere an:
 * Sheet/Header anlegen, den 1-Minuten-Trigger setzen und den
 * Autorisierungs-Dialog öffnen. Ab dem Klick auf "Erlauben" bei Spotify
 * läuft alles über den Trigger, ohne weitere Interaktion.
 */
function promptForCredentials() {
  var ui = SpreadsheetApp.getUi();

  var idResp = ui.prompt('Spotify-Einrichtung (1/2)',
    'Client-ID aus dem Spotify-Dashboard einfügen:', ui.ButtonSet.OK_CANCEL);
  if (idResp.getSelectedButton() !== ui.Button.OK) return;
  var clientId = idResp.getResponseText().trim();
  if (!clientId) { ui.alert('Keine Client-ID eingegeben. Abgebrochen.'); return; }

  var secretResp = ui.prompt('Spotify-Einrichtung (2/2)',
    'Client-Secret einfügen:', ui.ButtonSet.OK_CANCEL);
  if (secretResp.getSelectedButton() !== ui.Button.OK) return;
  var clientSecret = secretResp.getResponseText().trim();
  if (!clientSecret) { ui.alert('Kein Client-Secret eingegeben. Abgebrochen.'); return; }

  setCredentials(clientId, clientSecret);
  ensureSetup();   // Sheet, Header, Trigger – ab jetzt automatisch

  if (getService().hasAccess()) {
    ui.alert('Zugangsdaten aktualisiert. Verbindung besteht bereits – der Trigger läuft.');
    return;
  }

  // Redirect-URI direkt mitliefern, damit der Weg zu Spotify ohne
  // Zwischenschritt "Redirect-URI anzeigen" funktioniert.
  showAuthorizationDialog();
}

/**
 * Speichert Client-ID/-Secret in den Script Properties.
 */
function setCredentials(clientId, clientSecret) {
  PropertiesService.getScriptProperties()
    .setProperties({ CLIENT_ID: clientId, CLIENT_SECRET: clientSecret });
}

function showRedirectUri() {
  var ui = SpreadsheetApp.getUi();
  var missing = missingCredentials();
  if (missing) { ui.alert(missing); return; }
  ui.alert('Redirect-URI für Spotify', OAuth2.getRedirectUri(), ui.ButtonSet.OK);
}

/**
 * Zeigt Redirect-URI (zum einmaligen Eintragen bei Spotify) und
 * Autorisierungs-Link in einem einzigen Dialog. Nach dem Klick auf
 * "Erlauben" im Spotify-Tab übernimmt authCallback() den Rest automatisch –
 * kein Rückweg ins Sheet nötig.
 */
function showAuthorizationDialog() {
  var ui = SpreadsheetApp.getUi();
  var service = getService();
  if (service.hasAccess()) {
    ui.alert('Schon verbunden. Bei Bedarf zuerst "Verbindung zurücksetzen" wählen.');
    return;
  }

  var redirect = OAuth2.getRedirectUri();
  var authUrl = service.getAuthorizationUrl();
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;padding:8px;line-height:1.5">' +
    '<p><b>Einmalig bei Spotify hinterlegen</b> (Dashboard → App → Settings → ' +
    'Redirect URIs), falls noch nicht geschehen:</p>' +
    '<p style="word-break:break-all;background:#f1f1f1;padding:6px;border-radius:4px">' +
      redirect + '</p>' +
    '<p><b>Danach diesen Link öffnen</b> und den Zugriff erlauben:</p>' +
    '<p><a href="' + authUrl + '" target="_blank">Bei Spotify verbinden</a></p>' +
    '<p>Das war’s – dieses Fenster kann danach geschlossen werden. Alles Weitere ' +
    'läuft automatisch über den Trigger.</p>' +
    '</div>').setWidth(480).setHeight(260);
  ui.showModalDialog(html, 'Mit Spotify verbinden');
}

function checkConnection() {
  var ui = SpreadsheetApp.getUi();
  var missing = missingCredentials();
  if (missing) { ui.alert(missing); return; }

  var connected = getService().hasAccess();
  var triggerActive = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'run';
  });
  var lastRun = PropertiesService.getUserProperties().getProperty('lastRunAt');

  var lines = [
    connected ? '✅ Mit Spotify verbunden.' : '❌ Nicht verbunden – "Einrichten" wählen.',
    triggerActive ? '✅ Automatischer Trigger aktiv.' : '❌ Kein Trigger gefunden – "Einrichten" wählen.',
    lastRun ? 'Letzter Lauf: ' + lastRun : 'Noch kein automatischer Lauf erfolgt.'
  ];
  ui.alert(lines.join('\n'));
}

function resetFromMenu() {
  reset();
  SpreadsheetApp.getUi().alert('Verbindung zurückgesetzt. Über "Einrichten" neu verbinden.');
}

function runFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var missing = missingCredentials();
  if (missing) { ui.alert(missing); return; }
  if (!getService().hasAccess()) {
    ui.alert('Noch nicht verbunden. Zuerst "Einrichten" wählen.');
    return;
  }
  run();
  ui.alert('Synchronisiert.');
}

function missingCredentials() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CLIENT_ID') || !props.getProperty('CLIENT_SECRET')) {
    return 'Erst "Einrichten" wählen und Zugangsdaten eintragen.';
  }
  return null;
}

/**
 * Legt Sheet/Header an und sorgt dafür, dass genau ein Trigger für run()
 * existiert. Idempotent – beliebig oft aufrufbar, u. a. bei jeder
 * Änderung der Zugangsdaten, damit nach einem Redeploy nichts von Hand
 * nachgeholt werden muss.
 */
function ensureSetup() {
  var sheet = getLogSheet();
  ensureHeader(sheet);

  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'run';
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger('run').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create();
  }
}

/** Beibehalten für manuelles Auslösen im Editor; ruft dieselbe Logik auf. */
function setup() { ensureSetup(); }

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
  var service;
  try {
    service = getService();
  } catch (e) {
    Logger.log(e.message);
    return;
  }
  if (!service.hasAccess()) {
    Logger.log('Nicht autorisiert. Diese URL öffnen:\n%s', service.getAuthorizationUrl());
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // verhindert Doppelläufe

  try {
    var sheet = getLogSheet();
    ensureHeader(sheet);
    pollPlayback(sheet);           // liefert die Position – der wichtige Teil
    syncRecentlyPlayed(sheet);     // schließt Lücken zwischen zwei Läufen
    reclassifyStreaks(sheet, CONFIG.STREAK_SCAN_ROWS);  // erkennt Hörbücher an Ketten
    PropertiesService.getUserProperties().setProperty(
      'lastRunAt', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM. HH:mm:ss'));
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
    // Gleiches Format-vor-Wert-Prinzip wie in prependRows.
    sheet.getRange(2, C.DATE).setValue(entry.date);
    sheet.getRange(2, C.POS).setNumberFormat('@').setValue(msToClock(entry.positionMs));
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
 * Serien-Erkennung (Ketten gleichen Interpreten)
 * ========================================================================= */

/**
 * Zweite Erkennungsstufe zusätzlich zu classify(): Hörbücher, die als
 * normale, kurze Musik-Tracks vorliegen, erzeugen typischerweise lange
 * Ketten mit demselben Interpreten (dem Autor/Sprecher) und oft
 * hochzählenden Titeln ("Kapitel 3", "Kapitel 4", ...). Musikhören wechselt
 * den Interpreten deutlich häufiger. Erkannte Ketten werden von "Musik" auf
 * "Hörbuch" hochgestuft – nie umgekehrt, und nie bei Alben, die per
 * markAsMusic() ausdrücklich als Musik markiert wurden.
 *
 * Läuft nach jedem Sync automatisch über die letzten STREAK_SCAN_ROWS
 * Zeilen. Für die komplette Historie gibt es den Menüpunkt
 * "Neu klassifizieren (ganzes Log)".
 */
function reclassifyStreaks(sheet, limitRows) {
  var last = sheet.getLastRow();
  if (last < 3) return 0;   // mindestens 2 Datenzeilen nötig für eine Kette

  var count = Math.min(limitRows || CONFIG.STREAK_SCAN_ROWS, last - 1);
  var range = sheet.getRange(2, 1, count, HEADERS.length);
  var rows = range.getValues();
  var musicOverrides = getOverrides().music;

  // Zur chronologischen Analyse (älteste zuerst) mit Original-Zeilenindex.
  var items = rows.map(function (r, i) {
    return {
      i: i,
      date: r[C.DATE - 1],
      type: r[C.TYPE - 1],
      artist: String(r[C.ARTIST - 1] || '').trim().toLowerCase(),
      album: String(r[C.ALBUM - 1] || '').trim().toLowerCase(),
      track: r[C.TRACK - 1]
    };
  }).filter(function (it) { return it.date instanceof Date; })
    .sort(function (a, b) { return a.date - b.date; });

  var upgrades = [];   // Original-Zeilenindizes, die auf "Hörbuch" gehen
  var run = [];

  function flushRun() {
    if (run.length === 0) return;
    var qualifies = run.length >= CONFIG.STREAK_MIN_RUN ||
      (run.length >= CONFIG.STREAK_MIN_RUN_SEQUENTIAL &&
       looksSequential(run.map(function (it) { return it.track; })));

    if (qualifies) {
      run.forEach(function (it) {
        if (it.type !== 'Hörbuch' && !musicOverrides[it.album]) upgrades.push(it.i);
      });
    }
    run = [];
  }

  items.forEach(function (it, idx) {
    var prev = items[idx - 1];
    var sameChain = prev && prev.artist === it.artist && it.artist !== '';
    if (!sameChain) flushRun();
    run.push(it);
  });
  flushRun();

  if (upgrades.length) {
    upgrades.forEach(function (rowIdx) { rows[rowIdx][C.TYPE - 1] = 'Hörbuch'; });
    range.setValues(rows);
  }
  return upgrades.length;
}

/**
 * True, wenn die im Titel enthaltenen Zahlen über die Kette hinweg
 * größtenteils ansteigen – Indiz für hochzählende Kapitel/Teile.
 */
function looksSequential(tracks) {
  var nums = tracks.map(extractTrailingNumber).filter(function (n) { return n !== null; });
  if (nums.length < Math.max(2, Math.ceil(tracks.length * 0.6))) return false;

  var increasing = 0;
  for (var i = 1; i < nums.length; i++) if (nums[i] > nums[i - 1]) increasing++;
  return increasing >= (nums.length - 1) * 0.7;
}

function extractTrailingNumber(title) {
  var m = String(title || '').match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Behebt bereits im Sheet vorhandene Zellen, die Google Sheets fälschlich
 * als Uhrzeit statt als Text interpretiert hat (betrifft v. a. "Länge" und
 * "Position", z. B. "3:03"). Schreibt sie als Klartext zurück und setzt das
 * Zellformat auf Text, damit das nicht erneut passiert. Nötig für Zeilen,
 * die vor der prependRows()/pollPlayback()-Korrektur entstanden sind.
 */
function repairTimeCells() {
  var sheet = getLogSheet();
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var count = last - 1;
  [C.POS, C.LEN].forEach(function (col) {
    var range = sheet.getRange(2, col, count, 1);
    var values = range.getValues();
    var fixed = values.map(function (row) { return [timeCellToString(row[0])]; });
    range.setNumberFormat('@').setValues(fixed);
  });
  return count;
}

function repairTimeCellsFromMenu() {
  var n = repairTimeCells();
  SpreadsheetApp.getUi().alert(n
    ? n + ' Zeile(n) geprüft und bei Bedarf repariert.'
    : 'Sheet ist leer, nichts zu tun.');
}

/** Klassifiziert die komplette Sheet-Historie neu (Menüpunkt). */
function reclassifyAllFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getLogSheet();
  var n = reclassifyStreaks(sheet, sheet.getLastRow() - 1);
  ui.alert(n
    ? n + ' Zeile(n) als Hörbuch neu erkannt.'
    : 'Keine neuen Ketten gefunden.');
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

    // Google Sheets interpretiert Werte wie "3:03" ohne explizites
    // Text-Format oft als Uhrzeit und liefert dann ein Date-Objekt statt
    // eines Strings zurück. Ein Date-Objekt im Antwortobjekt bringt die
    // Übertragung zum Client zum Scheitern (Client erhält null), ohne dass
    // der Server das als Fehler meldet. Deshalb hier hart auf String
    // normalisieren.
    var position = timeCellToString(r[C.POS - 1]);
    var length = timeCellToString(r[C.LEN - 1]);

    out.push({
      album: album,
      artist: r[C.ARTIST - 1],
      track: r[C.TRACK - 1],
      type: r[C.TYPE - 1],
      when: formatWhen(r[C.DATE - 1]),
      position: position,
      positionMs: Number(r[C.POS_MS - 1]) || 0,
      length: length,
      percent: percentOf(r[C.POS_MS - 1], length),
      link: r[C.LINK - 1],
      uri: r[C.URI - 1],
      image: r[C.IMAGE - 1]
    });
  });

  // Diagnose – im Ausführungsprotokoll sichtbar, um Anzeigefehler von
  // Datenfehlern zu unterscheiden. Kann später entfernt werden.
  Logger.log('getResumeItems(showAll=%s): rows=%s, items=%s, albums=%s',
    showAll, rows.length, out.length, JSON.stringify(out.map(function (o) { return o.album; })));

  return {
    items: out.slice(0, 25),
    playbackControl: CONFIG.ENABLE_PLAYBACK_CONTROL,
    rewind: CONFIG.REWIND_SECONDS,
    totalLoggedRows: rows.length   // ungefiltert – unterscheidet "leer" von "alles rausgefiltert"
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
  // Text-Format MUSS vor setValues gesetzt werden – sonst interpretiert
  // Sheets "3:03" bereits beim Schreiben als Uhrzeit, und die Formatierung
  // danach ändert nur noch die Anzeige, nicht den zugrundeliegenden Typ.
  sheet.getRange(2, C.POS, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, C.LEN, rows.length, 1).setNumberFormat('@');
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

/**
 * Wandelt einen Sheet-Zellwert, den Google Sheets fälschlich als Uhrzeit
 * interpretiert hat, zurück in einen "M:SS"/"H:MM:SS"-String. Ein
 * unverändertes Date-Objekt im Rückgabewert einer serverseitigen Funktion
 * lässt die Übertragung an den Client scheitern (Client erhält null).
 */
function timeCellToString(value) {
  if (value instanceof Date) {
    var pad = function (v) { return v < 10 ? '0' + v : String(v); };
    var h = value.getHours(), m = value.getMinutes(), s = value.getSeconds();
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  return value || '';
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
  var clientId = props.getProperty('CLIENT_ID');
  var clientSecret = props.getProperty('CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('Keine Spotify-Zugangsdaten hinterlegt. Menü "Spotify" → "Zugangsdaten eintragen".');
  }

  var scopes = ['user-read-recently-played', 'user-read-playback-state'];
  if (CONFIG.ENABLE_PLAYBACK_CONTROL) scopes.push('user-modify-playback-state');

  return OAuth2.createService('Spotify')
    .setAuthorizationBaseUrl('https://accounts.spotify.com/authorize')
    .setTokenUrl('https://accounts.spotify.com/api/token')
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .setScope(scopes.join(' '))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties());
}

function authCallback(request) {
  var ok = getService().handleCallback(request);
  if (ok) {
    ensureSetup();   // falls die Autorisierung vor "Einrichten" abgeschlossen wurde
    try { run(); } catch (e) { Logger.log('Erster Lauf nach Autorisierung fehlgeschlagen: %s', e.message); }
  }
  return HtmlService.createHtmlOutput(ok
    ? 'Verbunden. Ab jetzt läuft alles automatisch über den Trigger – dieser Tab kann geschlossen werden.'
    : 'Zugriff verweigert.');
}

function reset() { getService().reset(); }

function logRedirectUri() { Logger.log(OAuth2.getRedirectUri()); }
