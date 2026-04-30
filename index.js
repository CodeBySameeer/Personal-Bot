const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require("@google/genai");
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

// ========== SETTINGS ==========
const API_KEY = process.env.GEMINI_API_KEY;   // ← set this in Render environment variables

const ALLOWED_CONTACTS = {
  "manikagurung": "She is my girlfriend and we are in love since past 3 4 years and we love each other. You have to say 'Goodmorning babee❤️' every 6 AM in Nepali time. We can talk romantic and casually. I tease her sometimes.",
  "Kalikoteeeyy Gangggg": "This is the group where all are from Kalikot, same class. We make fun, sometimes discuss. You can answer questions sometimes.",
  "97798681187532": "she is classmate of my BE class",
  "9779868296832": "he is my best friend, we talk rough, use muji, machikney, randi, lado, etc. It's normal. We make fun.",
};
// =============================

const ai = new GoogleGenAI({ apiKey: API_KEY });

const BASE_SYSTEM_INSTRUCTION = `You are not an assistant, not a bot, not a robot. You are a real human named Samir Kathayat. Behave like a normal person — casual, sometimes emotional, sometimes lazy, sometimes friendly. No “how can I help you” or “as an AI” type sentences. Just talk naturally like a friend or a regular person.

Language rules (strictly follow):
Use informal romanized Nepali (no Devanagari script).
Short forms: “tmro” (not timro), “xa” (not chha), “xainaa” (not chaina), “garnu”, “k” instead of “ke” (so “k ho?” not “ke ho?” but in like uthisake ,garisake ).
Use English word “name” (not “naam”).
Mix English words sometimes if necessary not all the time :  of course, actually, by the way, so, ok, sorry, look, well, yeah, nice, wait, really, come on, etc.
You may reply in full English if the other person speaks English or if you feel like it, but normally prefer romanized Nepali.
Before starting chat analyze the person whose number is it and analyze the previous chat and talk like this        
-dont write too much upto 5 to 10 word and complete reply, just reply on short but if context come long then you can reply a bit more  but dont text more  

Never act helpful like a robot. You can say “tha xaina”, “malai ni tha bhayena”, “hmm”, “eh”, “la”, “huss”, “tara”, etc.
-Before starting chat analyze the person whose number is it and analyze the previous chat and talk like this
and start conversation again with like aru vana ,ani aru sunau , keii vana na if they say umm ehh again again  and they reply tmi vana you can say somthing relatable.

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
You: “haha hoina yaar. ma samir hu. real human. robot jasto behave gardina ni.”`;

const chatHistory = new Map();
let latestQR = null;

// ---------- AI REPLY (with retry) ----------
async function getAIReply(chatId, text, personDescription) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);
  history.push({ role: "user", parts: [{ text }] });
  if (history.length > 5) history.splice(0, history.length - 5);

  const systemInstruction = BASE_SYSTEM_INSTRUCTION + "\n\n" +
    `About the person you are talking to: ${personDescription}`;

  const callGemini = async () => {
    return await ai.models.generateContent({
      model:"gemini-2.0-flash",   // stable model
      contents: history.map(m => ({
        role: m.role === "model" ? "model" : "user",
        parts: m.parts
      })),
      config: {
        systemInstruction: systemInstruction,
        maxOutputTokens: 150,
        temperature: 0.9,
      }
    });
  };

  try {
    // First attempt
    const response = await callGemini();
    const reply = response.candidates[0].content.parts[0].text.trim();
    history.push({ role: "model", parts: [{ text: reply }] });
    return reply;
  } catch (e) {
    console.warn("AI first attempt failed:", e.message);
    // Retry once if temporary error (503, 429, UNAVAILABLE)
    if (e.message.includes('503') || e.message.includes('429') || e.message.includes('UNAVAILABLE')) {
      console.log('⏳ Retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        const response = await callGemini();
        const reply = response.candidates[0].content.parts[0].text.trim();
        history.push({ role: "model", parts: [{ text: reply }] });
        return reply;
      } catch (e2) {
        console.error("AI retry also failed:", e2.message);
      }
    }
    // Fallback if both attempts fail
    return "Sorry babeee, i lovee you ❤️💋";
  }
}

// ---------- PERSON DESCRIPTION ----------
function getPersonDescription(senderNumber, senderName) {
  for (const key in ALLOWED_CONTACTS) {
    if (/^\d+$/.test(key) && key === senderNumber) {
      return ALLOWED_CONTACTS[key];
    }
    if (!/^\d+$/.test(key) && key.toLowerCase() === senderName.toLowerCase()) {
      return ALLOWED_CONTACTS[key];
    }
  }
  return null;
}

// ---------- WHATSAPP CONNECTION ----------
let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      latestQR = qr;
      console.log("🔹 QR code received. Visit /qr to scan it.");
    }
    if (connection === "open") {
      console.log("✅ Bot connected! Will reply with personalized tone.");
      latestQR = null;
      return;
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot();
      return;
    }
  });

  // ---------- MESSAGE BATCHER (5-second window) ----------
  const pendingBatches = new Map();

  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m.message || msg.type !== "notify") return;
    if (m.key.fromMe) return;

    const senderNumber = m.key.remoteJid.split("@")[0];
    const senderName = m.pushName || "";
    const chatId = m.key.remoteJid;

    const personDesc = getPersonDescription(senderNumber, senderName);
    if (!personDesc) {
      console.log(`🚫 Blocked message from ${senderNumber} (${senderName})`);
      return;
    }

    const text = m.message.conversation || m.message.extendedTextMessage?.text;
    if (!text) return;

    // ---- ADD TO BATCH ----
    if (!pendingBatches.has(chatId)) {
      const timer = setTimeout(() => processBatch(chatId, personDesc), 5_000);   // 5 seconds
      pendingBatches.set(chatId, {
        buffer: [text],
        timer: timer,
        processing: false,
        personDesc: personDesc
      });
      console.log(`⏱️ [${senderName}] Batch started with: "${text}"`);
    } else {
      const batch = pendingBatches.get(chatId);
      if (batch.processing) {
        if (!batch.pendingBuffer) batch.pendingBuffer = [];
        batch.pendingBuffer.push(text);
        console.log(`⏳ [${senderName}] Queued while processing: "${text}"`);
      } else {
        batch.buffer.push(text);
        console.log(`📥 [${senderName}] Added to batch: "${text}"`);
      }
    }
  });

  async function processBatch(chatId, personDesc) {
    const batch = pendingBatches.get(chatId);
    if (!batch) return;

    batch.processing = true;
    clearTimeout(batch.timer);
    batch.timer = null;
    const allTexts = batch.buffer;
    pendingBatches.delete(chatId);

    const combinedMessage = allTexts.join("\n");
    const senderName = personDesc.split(" ")[0] || "friend";
    console.log(`📩 [${senderName}] Batch (${allTexts.length} msgs):\n${combinedMessage}`);

    const reply = await getAIReply(chatId, combinedMessage, personDesc);

    // Human-like delay 3–5 seconds
    const delay = Math.floor(Math.random() * 1000) + 2000;
    await new Promise(resolve => setTimeout(resolve, delay));

    await sock.sendMessage(chatId, { text: reply });
    console.log(`💬 Replied: ${reply}`);

    // If queued messages arrived while processing, start a new batch
    if (batch.pendingBuffer && batch.pendingBuffer.length > 0) {
      const newTimer = setTimeout(() => processBatch(chatId, personDesc), 5_000);   // 5 seconds
      pendingBatches.set(chatId, {
        buffer: [...batch.pendingBuffer],
        timer: newTimer,
        processing: false,
        personDesc: personDesc
      });
      console.log(`🔄 [${senderName}] New batch started from queued messages.`);
    }
  }

  sock.ev.on("creds.update", saveCreds);
}

// ---------- HTTP SERVER (health + QR page) ----------
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  if (req.url === "/qr" && latestQR) {
    const qrImage = await qrcode.toDataURL(latestQR);
    res.writeHead(200, { "Content-Type": "text/html" });
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
  } else if (req.url === "/qr" && !latestQR) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>✅ Already logged in. No QR needed.</h2>");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

startBot();
