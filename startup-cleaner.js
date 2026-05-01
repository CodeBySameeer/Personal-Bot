// startup-cleaner.js
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_session');
const CREDS_FILE = path.join(AUTH_DIR, 'creds.json');

console.log('🧹 Checking if a fresh start is needed…');
if (fs.existsSync(CREDS_FILE)) {
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    // If the session is brand new (no 'me' object), wipe the folder for a clean QR scan
    if (!creds.me || !creds.me.id) {
        console.log('🧽 New credentials detected. Cleaning up for a fresh link…');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log('✅ Ready for a new QR scan.');
    } else {
        console.log('✅ Existing session is valid.');
    }
} else {
    console.log('📴 No previous session found. Waiting for QR scan.');
}
