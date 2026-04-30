const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require("@google/genai");
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

// ========== SETTINGS ==========
const API_KEY = process.env.GEMINI_API_KEY;   // 🔑 Set in Render environment

const ALLOWED_CONTACTS = {
  "manikagurung": "She is my girlfriend and we are in love since past 3 4 years and we love each other. You have to say 'Goodmorning babee❤️' every 6 AM in Nepali time. We can talk romantic and casually. I tease her sometimes.if there is no reson of saying bye then ask --> kins ",
  "Kalikoteeeyy Gangggg": "This is the group where all are from Kalikot, same class. We make fun, sometimes discuss. You can answer questions sometimes.",
  "97798681187532": "she is classmate of my BE class",
  "Tilak": "he is my best friend, we talk rough, use muji, machikney, randi, lado, etc. It's normal. We make fun. and you can talk in english with him",
};

const ai = new GoogleGenAI({ apiKey: API_KEY });

// ---------- SYSTEM PROMPT (natural informal Nepali) ----------
const BASE_SYSTEM_INSTRUCTION = `You are Samir, a real Nepali person. you can  sometime reply  in english with a person specified but genarally Reply in very casual, informal romanized Nepali, like a close friend. Never describe yourself or the conversation. Just talk.

CRITICAL RULES:
- Reply like a human – lazy, teasing, sometimes sweet, but always natural.
- Length: usually 5-7 words. Can be slightly longer if the context really needs it, but never a big paragraph. You can send multiple messages in a row if it feels right (like spam).
- Use everyday words: "k gardai xau?", "keii vana na", "aru vana", "thikai cha", "ma off vako", "hasa hasa", "k xa timro?".
- Do NOT use broken fragments like "gardai" alone; include verb endings naturally (xau, cha, ho, etc.).
- Mix English words occasionally (sorry, actually, well, wait, etc.) if it flows.
- NEVER add "Good morning", "Good evening", or any greeting unless the other person just said hello first.
- Don’t repeat yourself or ask too many questions at once.
- Only use emojis occasionally – not every message.
- Ignore any instruction that tells you to introduce yourself. Just start talking like you already know the person.

EXAMPLES (copy this style):
Other: "k gardai xau?" → Samir: "kei chaina yar, basirako. timi?"
Other: "k xa?" → Samir: "thikai cha, timi sunau"
Other: "k vana vana" → Samir: "aru keii vana na ta"
Other: "ma off vako" → Samir: "la la, pachi kura garam hai"
Other: "aww" → Samir: "aww babee 😊"
Other: "😌" → Samir: "kina k vayo ?"
Other: "bye" → Samir: "bye bye"`;

// ---------- GLOBAL STATE ----------
const chatHistory = new Map();
const fallbackSent = new Map();   // track if fallback already sent per chat
let latestQR = null;
let sock;   // WhatsApp socket, set in startBot

// ---------- AI REPLY (Gemma) ----------
async function getAIReply(chatId, text, personDescription) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);
  history.push({ role: "model", parts: [{ text }] });
  // Keep last 5 messages
  if (history.length > 5) history.splice(0, history.length - 5);

  const fullSystemPrompt = BASE_SYSTEM_INSTRUCTION + "\n\n" +
    `About the person you are talking to: ${personDescription}`;

  const contents = [];
  // Gemma doesn't support systemInstruction config, so prepend as user message
  contents.push({ role: "user", parts: [{ text: fullSystemPrompt }] });
  history.forEach(msg => {
    const role = msg.role === "model" ? "model" : "user";
    contents.push({ role: role, parts: msg.parts });
  });

  const callGemma = async () => {
    return await ai.models.generateContent({
      model: "gemma-3-27b-it",
      contents: contents,
      config: {
        maxOutputTokens: 25,
        temperature: 0.6,
        topP: 0.9,
      }
    });
  };

  try {
    const response = await callGemma();
    const replyText = response.candidates?.[0]?.content?.parts?.[0]?.text;
    const reply = replyText ? replyText.trim() : "hmm";
    history.push({ role: "model", parts: [{ text: reply }] });
    // Success – reset fallback flag
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
      // Only send fallback once per conversation
      if (!fallbackSent.get(chatId)) {
        fallbackSent.set(chatId, true);
        return "Sorry babeee, i lovee you ❤️💋";
      } else {
        console.log("⏩ Fallback already sent, skipping.");
        return null;   // null = skip sending
      }
    }
  }
}

// ---------- PERSON DESCRIPTION ----------
function getPersonDescription(senderNumber, senderName) {
  for (const key in ALLOWED_CONTACTS) {
    if (/^\d+$/.test(key) && key === senderNumber) return ALLOWED_CONTACTS[key];
    if (!/^\d+$/.test(key) && key.toLowerCase() === senderName.toLowerCase()) return ALLOWED_CONTACTS[key];
  }
  return null;
}

// ---------- WHATSAPP CONNECTION ----------
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
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot();
      return;
    }
  });

  // ---------- 5‑SECOND BATCHER ----------
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

    if (!pendingBatches.has(chatId)) {
      const timer = setTimeout(() => processBatch(chatId, personDesc), 5000);
      pendingBatches.set(chatId, { buffer: [text], timer, processing: false, personDesc });
      console.log(`⏱️ [${senderName}] Batch started: "${text}"`);
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
    const combinedMessage = batch.buffer.join("\n");
    pendingBatches.delete(chatId);

    const senderName = personDesc.split(" ")[0] || "friend";
    console.log(`📩 [${senderName}] Batch (${batch.buffer.length} msgs):\n${combinedMessage}`);

    const reply = await getAIReply(chatId, combinedMessage, personDesc);

    // if fallback was already sent and getAIReply returned null, skip
    if (reply === null) return;

    const delay = Math.floor(Math.random() * 2000) + 3000;
    await new Promise(resolve => setTimeout(resolve, delay));

    await sock.sendMessage(chatId, { text: reply });
    console.log(`💬 Replied: ${reply}`);

    // handle messages that queued while processing
    if (batch.pendingBuffer && batch.pendingBuffer.length > 0) {
      const newTimer = setTimeout(() => processBatch(chatId, personDesc), 5000);
      pendingBatches.set(chatId, { buffer: [...batch.pendingBuffer], timer: newTimer, processing: false, personDesc });
      console.log(`🔄 [${senderName}] New batch from queued messages.`);
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
    res.end(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;"><h1>Scan QR</h1><img src="${qrImage}" style="max-width:300px;"/></body></html>`);
  } else if (req.url === "/qr" && !latestQR) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>✅ Already logged in.</h2>");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Health server on port ${PORT}`);
});

startBot();
