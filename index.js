const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pino = require('pino');
const http = require('http');

// ========== REPLACE THESE ==========
const API_KEY = 'AIzaSyAuOyzdGVuuPsppkG_tJV8SrJRyB7ezcdI';
const PHONE_NUMBER = '9766884391';   // no + sign
// ===================================

const genAI = new GoogleGenerativeAI(API_KEY);
const SYSTEM_PROMPT = `You are a Nepali person chatting with a close friend on WhatsApp.
Always reply in Romanized Nepali. Keep replies short and casual.
Use words like timi, malai, huncha, hai. Match the tone. Never mention AI.`;
const chatHistory = new Map();

let alreadyRequestedPairingCode = false;   // stop asking multiple times

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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ Bot connected! Will reply to all messages.');
            return;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                // Restart the socket without asking for a new pairing code
                startBot();
            }
            return;
        }
    });

    // Only request pairing code if we are not already logged in
    if (!state.creds || !state.creds.me) {
        // Wait for handshake, then request once
        setTimeout(async () => {
            if (alreadyRequestedPairingCode) return;
            alreadyRequestedPairingCode = true;
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER.trim());
                console.log('🔥 PAIRING CODE:', code);
                console.log('👉 Open WhatsApp → Settings → Linked Devices → Link a Device');
                console.log('👉 Choose "Link with phone number" and enter the code above');
            } catch (e) {
                console.log('Failed to get pairing code:', e.message);
            }
        }, 5000);
    }

    // Listen for new messages
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

// ---------- Simple HTTP server to keep Render happy ----------
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
});
server.listen(PORT, () => {
    console.log(`🌐 Health server running on port ${PORT}`);
});

// Start the bot
startBot();
