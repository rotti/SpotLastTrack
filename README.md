# SpotLastTrack
save last played track from spotify API via google script to a google spreadsheet. 


 https://github.com/gsuitedevs/apps-script-oauth2
 https://developers.google.com/apps-script/guides/sheets
 https://developer.spotify.com/documentation/web-api/quick-start/

** Steps needed:
 1) Register to Spotify API. Create a App. https://developer.spotify.com/dashboard/applications
 2) Create Google Sheet and create script within. https://docs.google.com/spreadsheets
 3) Get Script ID from script and put it inside Redirect URIs. https://script.google.com/macros/d/<SCRIPT_ID>/usercallback
 4) Get ClientID and ClientSecret and save to script. https://developer.spotify.com/dashboard/applications
 5) Register Oauth2 Lib inside script. "In the "Find a Library" text box, enter the script ID 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF and click the "Select" button."
 6) Run script first time. Look at your Log. Put the given URL inside your browser. Allow access. 
 7) Set trigger to script. For example every 30 minutes.

