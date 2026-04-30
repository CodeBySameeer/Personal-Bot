// startup-cleaner.js – Force a fresh session
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_session');

console.log('🧹 Forcing a fresh session... good-bye Bad MAC errors.');
if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('✅ Old session deleted. A new QR code will be shown.');
} else {
    console.log('📴 No existing session found.');
}
