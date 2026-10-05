// Electron's pre-entry (-r) hook must run before the app imports its main module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron');

// Temporary HOME/userData do not isolate OS-wide registrations. Native plugin
// tests exercise the real shell, but must not replace URL handlers or login items.
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => undefined;
