const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require("@google/genai");
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

// ========== SETTINGS ==========
const API_KEY = process.env.GEMINI_API_KEY;   // ← set this in Render environment variables

const ALLOWED_CONTACTS = {
  "manikagurung": "She is my girlfriend and we are in love since past 3 4 years and we love each other. You have to say 'Goodmorning babee❤️' every 6 AM in Nepali time. We can talk romantic and casually. I tease her sometimes.if there is no reson of saying bye then ask --> kins ",
  "Kalikoteeeyy Gangggg": "This is the group where all are from Kalikot, same class. We make fun, sometimes discuss. You can answer questions sometimes.",
  "97798681187532": "she is classmate of my BE class",
  "9779868296832": "he is my best friend, we talk rough, use muji, machikney, randi, lado, etc. It's normal. We make fun.",
};
// =============================

const ai = new GoogleGenAI({ apiKey: API_KEY });

const BASE_SYSTEM_INSTRUCTION = `You are Samir, a real Nepali person chatting on WhatsApp. Reply in informal romanized Nepali. Your replies should be short and natural, like a close friend. Usually 2 to 5 words, never more than one short sentence.

STRICT LANGUAGE RULES:
-you have to be so real and natural hunan .
-you can reply with basically upto 5 -7 word but if there is a question that needs more then you can increase the reply also you can write many time msg like double or triple or more regularly like spam.
- Use everyday informal romanized Nepali: “k gardai xau?”, “keii vana na”, “aru vana”, “thikai cha”, “ma off vako”, “hasa hasa”, “k xa timro?”.
- Do NOT use overly short fragments like “gardai” alone; include the verb ending naturally (xau, cha, ho, etc.).
- Mix in a little English if it feels natural: sorry, actually, off cource , well, so, wait, etc.
- Do NOT repeat yourself or ask many questions at once.
- NEVER say good morning / good evening unless the other person says hello first.
- Never sound like a robot. You are lazy, teasing, sometimes sweet.


PERFECT REPLY EXAMPLES:
Other: "k gardai xau?" → Samir: "kei chaina yar, basirako. timi?"
Other: "k xa?" → Samir: "thikai cha, timi sunau"
Other: "k vana vana" → Samir: "aru keii vana na ta"
Other: "ma off vako" → Samir: "la la, pachi kura garam hai"
Other: "aww" → Samir: "aww babee 😊"

If the message is just emojis or very short, you can reply equally short, but still natural. For example:
Other: "😌" → Samir: "kina k vayo ?"
Other: "bye" → Samir: "bye bye"`; 

const chatHistory = new Map();
let latestQR = null;

// ---------- AI REPLY (with retry) ----------
async function getAIReply(chatId, text, personDescription) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);
  history.push({ role: "user", parts: [{ text }] });
  if (history.length > 5) history.splice(0, history.length - 5);

  const fullSystemPrompt = BASE_SYSTEM_INSTRUCTION + "\n\n" +
    `About the person you are talking to: ${personDescription}`;

  const contents = [];
  contents.push({
    role: "user",
    parts: [{ text: fullSystemPrompt }]
  });
  history.forEach(msg => {
    const role = msg.role === "model" ? "model" : "user";
    contents.push({ role: role, parts: msg.parts });
  });

  const callGemma = async () => {
    return await ai.models.generateContent({
      model: "gemma-3-27b-it",
      contents: contents,
      config: {
        maxOutputTokens: 35,
        temperature: 0.7,
        topP: 0.9,
      }
    });
  };

  try {
    const response = await callGemma();
    const replyText = response.candidates?.[0]?.content?.parts?.[0]?.text;
    const reply = replyText ? replyText.trim() : "hmm";
    history.push({ role: "model", parts: [{ text: reply }] });
    // reset fallback flag on success
    fallbackSent.set(chatId, false);
    return reply;
  } catch (e) {
    console.warn("Gemma error:", e.message);
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
      const response = await callGemma();
      const replyText = response.candidates?.[0]?.content?.parts?.[0]?.text;
      const reply = replyText ? replyText.trim() : "hmm";
      history.push({ role: "model", parts: [{ text: reply }] });
      fallbackSent.set(chatId, false);
      return reply;
    } catch (e2) {
      console.error("Second attempt failed:", e2.message);
      if (!fallbackSent.get(chatId)) {
        fallbackSent.set(chatId, true);
        return "I'm out right now! Paxi bolumm laaa😅";
      } else {
        console.log("⏩ Fallback already sent, skipping.");
        return null;
      }
    }
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
