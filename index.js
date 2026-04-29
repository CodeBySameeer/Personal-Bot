const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');   // for generating QR as an image

// ========== REPLACE THIS ==========
const API_KEY = 'AIzaSyAuOyzdGVuuPsppkG_tJV8SrJRyB7ezcdI';
// ===================================

const genAI = new GoogleGenerativeAI(API_KEY);
const SYSTEM_PROMPT = `You are a Nepali person chatting with a close friend on WhatsApp.
Always reply in Romanized Nepali. Keep replies short and casual.
Use words like timi, malai, huncha, hai. Match the tone. Never mention AI.`;
const chatHistory = new Map();

// Store the latest QR string (null when logged in)
let latestQR = null;

async function getAIReply(chatId, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role: "user", parts: [{ text }] });
    if (history.length > 20) history.splice(0, history.length - 20);

    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: SYSTEM_PROMPT,
    });
    try {
        const result = await model.generateContent({
            contents: history.map(m => ({
                role: m.role === "model" ? "model" : "user",
                parts: m.parts
            })),
            generationConfig: { maxOutputTokens: 150, temperature: 0.9 }
        });
        const reply = result.response.text().trim();
        history.push({ role: "model", parts: [{ text: reply }] });
        return reply;
    } catch (e) {
        return "ekchin pachi kura garam hai, aile line busy cha 😅";
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('connection.update', (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            // Save the QR string to display on the web page
            latestQR = qr;
            console.log('🔹 QR code received. Visit /qr to scan it.');
        }

        if (connection === 'open') {
            console.log('✅ Bot connected! Will reply to all messages.');
            latestQR = null;   // no longer needed
            return;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startBot();   // reconnect
            }
            return;
        }
    });

    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        if (!m.message || msg.type !== 'notify' || m.key.fromMe) return;
        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return;

        console.log(`📩 ${text}`);
        const reply = await getAIReply(m.key.remoteJid, text);
        await sock.sendMessage(m.key.remoteJid, { text: reply });
        console.log(`💬 Replied: ${reply}`);
    });

    sock.ev.on('creds.update', saveCreds);
}

// ---------- HTTP server for health & QR ----------
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
    if (req.url === '/qr' && latestQR) {
        // Generate a QR code image and display it
        const qrImage = await qrcode.toDataURL(latestQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
            <head><title>Scan QR to connect</title></head>
            <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif;">
                <h1>Scan this QR code with WhatsApp</h1>
                <img src="${qrImage}" alt="QR Code" style="max-width:300px;"/>
                <p>Open WhatsApp → Settings → Linked Devices → Link a Device → Scan QR</p>
            </body>
            </html>
        `);
    } else if (req.url === '/qr' && !latestQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>✅ Already logged in. No QR needed.</h2>');
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot is running');
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Health server running on port ${PORT}`);
});

// Start the bot
startBot();
