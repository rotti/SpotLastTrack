/**
* https://github.com/gsuitedevs/apps-script-oauth2
* https://developers.google.com/apps-script/guides/sheets
* https://developer.spotify.com/documentation/web-api/quick-start/

* Steps needed:
* 1) Register to Spotify API. Create a App. https://developer.spotify.com/dashboard/applications
* 2) Create Google Sheet and create script within. https://docs.google.com/spreadsheets
* 3) Get Script ID from script and put it inside Redirect URIs. https://script.google.com/macros/d/<SCRIPT_ID>/usercallback
* 4) Get ClientID and ClientSecret and save to script. https://developer.spotify.com/dashboard/applications
* 5) Register Oauth2 Lib inside script. "In the "Find a Library" text box, enter the script ID 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF and click the "Select" button."
* 6) Run script first time. Look at your Log. Put the given URL inside your browser. Allow access. 
* 7) Set trigger to script. For example every 30 minutes.
*/

var CLIENT_ID = '...';
var CLIENT_SECRET = '...';

/**
* Authorizes and makes a request to the Spotify API.
*/
function run() {
  var service = getService();
  if (service.hasAccess()) {
    var url = 'https://api.spotify.com/v1/me/player/recently-played';
    var response = UrlFetchApp.fetch(url, {
      headers: {'Authorization': 'Bearer ' + service.getAccessToken()}
    });
    var result = JSON.parse(response.getContentText());

    //Logger.log("Response ", result);
    
    var myAlbum = result.items[0].track.album.name;
    var myTrack = result.items[0].track.name;
    var myExtUrl = result.items[0].track.external_urls.spotify;
    
    //Logger.log("Last Played: ", myAlbum, myTrack, myExtUrl);  

    var lastExtUrl = readSheet(); 

    //note that API needs 3 minutes of listening to store last track
    if (lastExtUrl == myExtUrl) {
      Logger.log("You haven't listened to something new. Last track from sheet was:", lastExtUrl + " Last Track from API: " + myTrack);
    } else {
      writeSheet(myAlbum, myTrack, myExtUrl); 
    }  
    
  } else {
    var authorizationUrl = service.getAuthorizationUrl();
    Logger.log('Open the following URL and re-run the script: %s',
               authorizationUrl);
  }
}

/**
* Reset the authorization state, so that it can be re-tested.
*/
function reset() {
  getService().reset();
}

/**
* Configures the service.
*/
function getService() {
  return OAuth2.createService('Spotify')
  // Set the endpoint URLs.
  .setAuthorizationBaseUrl('https://accounts.spotify.com/authorize')
  .setTokenUrl('https://accounts.spotify.com/api/token')

  // Set the client ID and secret.
  .setClientId(CLIENT_ID)
  .setClientSecret(CLIENT_SECRET)
  
  .setScope('user-read-recently-played')

  // Set the name of the callback function that should be invoked to complete
  // the OAuth flow.
  .setCallbackFunction('authCallback')

  // Set the property store where authorized tokens should be persisted.
  .setPropertyStore(PropertiesService.getUserProperties());
}

/**
* Handles the OAuth callback.
*/
function authCallback(request) {
  var service = getService();
  var authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('Success!');
  } else {
    return HtmlService.createHtmlOutput('Denied.');
  }
}

/**
 * Logs the redict URI to register.
 */
function logRedirectUri() {
  Logger.log(OAuth2.getRedirectUri());
  
}

function writeSheet(myAlbum, myTrack, myExtUrl) {
  var sheet = SpreadsheetApp.getActiveSheet();
  sheet.appendRow([myAlbum, myTrack, myExtUrl]);
}

function readSheet() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var data = sheet.getDataRange().getValues();
  var last_extUrl = "";
  
  for (var i = 0; i < data.length; i++) {
    last_extUrl = data[i][2];
  }
  return last_extUrl;
}
