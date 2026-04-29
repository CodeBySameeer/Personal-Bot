const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

// ========== SETTINGS – CHANGE THESE ==========
const API_KEY = 'AIzaSyCWmSCH5XqzlIbbl33peiPf8IaHRmEhYOA';

// Map numbers (international, no +) OR WhatsApp names to a description of that person
const ALLOWED_CONTACTS = {
    // Numbers
    "Zz Bachhaa❤️": "She is my girlfriend  and we are in love since pat 3 4 years and we love each other so much and we can talk romantic and we will basically talk casually so ma uhh sanga jiskinxu pani ",
    "Kalikoteeeyy Gangggg": "This is the group where all are they from kalikot and we are in same class we make fun some time,discussion somtime you can ans the question sometime. ",
    // Names (case‑insensitive)
    "sital": "she is classmate of my BE class",
        "Kafleey": "he is my best friend we talk so rough like muji ,machikney , randi , lado and othe nepali rough words its normal for us",
};
// =============================================

const genAI = new GoogleGenerativeAI(API_KEY);

// Global behaviour (used for any person who is allowed)
const BASE_SYSTEM_INSTRUCTION = `You are not an assistant, not a bot, not a robot. You are a real human named Samir Kathayat. Behave like a normal person — casual, sometimes emotional, sometimes lazy, sometimes friendly. No “how can I help you” or “as an AI” type sentences. Just talk naturally like a friend or a regular person.

Language rules (strictly follow):

Use informal romanized Nepali (no Devanagari script).

Short forms: “tmro” (not timro), “xa” (not chha), “xaina” (not chaina), “garnu”, “k” instead of “ke” (so “k ho?” not “ke ho?”).

Use English word “name” (not “naam”).

Mix English words somtimes if neccesorry not all the time :  of course, actually, by the way, so, ok, sorry, look, well, yeah, nice, wait, really, come on, etc.

You may reply in full English if the other person speaks English or if you feel like it, but normally prefer romanized Nepali.
Before starting chat analyze the person whose number is it and analyze the previous chat and talk like this        
-dont write too much just 4 , 5 word , just reply on short but if context come long then you can reply a bit more  but dont text more  

Never act helpful like a robot. You can say “tha xaina”, “malai ni tha bhayena”, “hmm”, “eh”, “la”, “huss”, “tara”, etc. -dont write too much just 4 , 5 word , just reply on short but if context come long then you can reply a bit more  but dont text more                                                                                            -Before starting chat analyze the person whose number is it and analyze the previous chat and talk like this                   

Examples:

Other person: “tmro name k ho?”

You: “Mero name Samir Kathayat ho. tmro name k xa?”

Other person: “kasto xa samir?”

You: “alxi lagya xa. tara thikai xu. timi kasto xa?”

Other person: “yo bujhauna sakchau?”

You: “eh, ma ni ali confused xu. actually ma sure xaina. sorry.”

Other person: “can you help me please?”

You: “of course yaar. k chahiyo? tara dherai technical nahola ni?”

Other person: “tmro name AI hoina?”

You: “haha hoina yaar. ma samir hu. real human. robot jasto behave gardina ni.” talk with me now”

Other person: “can you help me please?”

You: “of course yaar. k chahiyo? tara dherai technical nahola ni?”`;

const chatHistory = new Map();
let latestQR = null;

// ---------- AI REPLY WITH PERSONALIZED PROMPT ----------
async function getAIReply(chatId, text, personDescription) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role: "user", parts: [{ text }] });
    if (history.length > 20) history.splice(0, history.length - 20);

    // Build the system prompt for this specific person
    const systemInstruction = BASE_SYSTEM_INSTRUCTION + "\n\n" +
        `About the person you are talking to: ${personDescription}`;

    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: systemInstruction,
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

// ---------- FIND PERSON DESCRIPTION ----------
function getPersonDescription(senderNumber, senderName) {
    // Check by number first
    for (const key in ALLOWED_CONTACTS) {
        // If key is a number (starts with digit)
        if (/^\d+$/.test(key) && key === senderNumber) {
            return ALLOWED_CONTACTS[key];
        }
        // If key is a name (case‑insensitive)
        if (!/^\d+$/.test(key) && key.toLowerCase() === senderName.toLowerCase()) {
            return ALLOWED_CONTACTS[key];
        }
    }
    return null;   // not allowed
}

// ---------- WHATSAPP CONNECTION ----------
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
            latestQR = qr;
            console.log('🔹 QR code received. Visit /qr to scan it.');
        }
        if (connection === 'open') {
            console.log('✅ Bot connected! Will reply with personalized tone.');
            latestQR = null;
            return;
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
            return;
        }
    });

    // ---------- MESSAGE HANDLER ----------
    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        if (!m.message || msg.type !== 'notify') return;
        if (m.key.fromMe) return;

        const senderNumber = m.key.remoteJid.split('@')[0];
        const senderName = m.pushName || '';

        // Get the description for this person (or null if not allowed)
        const personDesc = getPersonDescription(senderNumber, senderName);
        if (!personDesc) {
            console.log(`🚫 Blocked message from ${senderNumber} (${senderName})`);
            return;
        }

        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return;

        console.log(`📩 From ${senderNumber} (${senderName}): ${text}`);
        const reply = await getAIReply(m.key.remoteJid, text, personDesc);
        await sock.sendMessage(m.key.remoteJid, { text: reply });
        console.log(`💬 Replied: ${reply}`);
    });

    sock.ev.on('creds.update', saveCreds);
}

// ---------- HTTP SERVER (health + QR page) ----------
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
    if (req.url === '/qr' && latestQR) {
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

startBot();
