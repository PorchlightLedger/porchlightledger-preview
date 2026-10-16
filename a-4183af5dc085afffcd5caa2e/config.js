/* Optional sign-in and sync. Leave syncUrl empty and the app works exactly as before:
   it makes no network requests and shows no account section. Set it only after a sync service exists,
   for example: window.PL_CONFIG = { syncUrl: "https://sync.example.com" }. */
window.PL_CONFIG = window.PL_CONFIG || { syncUrl: "" };
