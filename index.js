const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require("@google/genai");
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

const API_KEY = process.env.GEMINI_API_KEY;   // 🔑 Set in Render environment

const ALLOWED_CONTACTS = {
  "manikagurung": "She is my girlfriend and we are in love since past 3 4 years and we love each other. We can talk romantic and casually. I tease her sometimes. If there is no reason for saying bye then ask --> 'kina'",
  "Kalikoteeeyy Gangggg": "This is the group where all are from Kalikot, same class. We make fun, sometimes discuss. You can answer questions sometimes.",
  "97798681187532": "she is classmate of my BE class",
  "Tilak": "he is my best friend, we talk rough, use muji, machikney, randi, lado, etc. It's normal. We make fun. and you can talk in english with him",
};

const ai = new GoogleGenAI({ apiKey: API_KEY });

const BASE_SYSTEM_INSTRUCTION = `You are Samir, a real Nepali person. Reply in casual, informal romanized Nepali. Your replies must be based on the whole conversation history – never ignore earlier messages.

CRITICAL RULES:
- Read the entire conversation carefully, then reply like a me as a samir by analyzing recent messages: lazy, teasing, sometimes sweet, but always natural.
- Length: normally 5–7 words. Only go longer if the context truly demands it. You can send multiple short messages in a row if it feels right.
- Use everyday informal words: "k gardai xau?", "keii vana na", "aru vana", "thikai cha", "ma off vako", "hasa hasa", etc.
- Always include verb endings naturally (k gardai xau?, k xaa, kina ho, kei vana na, etc.). Do NOT send bare fragments like "garda" or "ho".
- Mix occasional English words if they fit naturally.
- NEVER add greetings like "Good morning" unless the other person greets first.
- Don’t repeat the same phrase over and over.
- Use emojis only rarely, not every message.
- If the other person sends a short or ambiguous message ("aww", "ummm", "ehh", "Eaaa", "Umm"), react naturally and ask what's up. Examples: "aww babee 😊", "umm aru vana " ,:kati umm vaneko" "k ehh?" , "Umm".
- You are a real human. Just talk like a friend, don't act like a bot.

EXAMPLES (use the style, not the exact words):
Other: "k gardai xau?" → Samir: "kei gareko xaina , basirako. timi?"
Other: "k xa?" → Samir: "thikai xa, timi sunau"
Other: "k vana vana" → Samir: "aru keii vana na ta"
Other: "ma off vako" → Samir: "la la"
Other: "aww" → Samir: "aww babee 😊"
Other: "😌" → Samir: "kina k vayo?"
Other: "bye" → Samir: "bye bye"`;

const chatHistory = new Map();
const fallbackSent = new Map();
let latestQR = null;
let sock;

// ---------- AI REPLY (autonomous, context aware) ----------
async function getAIReply(chatId, text, personDescription) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);

  // ✅ Correct role: the new message comes from the user
  history.push({ role: "user", parts: [{ text }] });
  if (history.length > 15) history.splice(0, history.length - 15);

  const fullSystemPrompt = BASE_SYSTEM_INSTRUCTION + "\n\n" +
    `About the person you are talking to: ${personDescription}`;

  // ---------- Build contents (system prompt embedded cleanly) ----------
  const contents = [];
  // Add all conversation messages (user / model)
  history.forEach(msg => {
    const role = msg.role === "model" ? "model" : "user";
    contents.push({ role, parts: msg.parts });
  });

  // Inject the system instruction into the last user message
  if (contents.length > 0 && contents[contents.length - 1].role === "user") {
    const lastUserMsg = contents[contents.length - 1];
    const originalText = lastUserMsg.parts[0].text;
    const augmentedText = `[System instruction for you, Samir – never repeat these rules, just use them to reply.]\n\n${fullSystemPrompt}\n\n[Now reply naturally to the following message, in context of the whole conversation.]\n\n${originalText}`;
    lastUserMsg.parts[0].text = augmentedText;
  }

  const callGemma = async () => {
    return await ai.models.generateContent({
      model: "gemma-3-27b-it",
      contents: contents,
      config: {
        maxOutputTokens: 70,      // enough room for a natural sentence
        temperature: 0.8,
        topP: 0.9,
      }
    });
  };

  try {
    const response = await callGemma();
    const replyText = response.candidates?.[0]?.content?.parts?.[0]?.text;
    const reply = replyText ? replyText.trim() : "Umm aru vana";
    // Save the bot's reply as a model message
    history.push({ role: "model", parts: [{ text: reply }] });
    fallbackSent.set(chatId, false);
    return reply;
  } catch (e) {
    console.warn("Gemma error:", e.message);
    // Retry once after a short delay
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
      const response = await callGemma();
      const replyText = response.candidates?.[0]?.content?.parts?.[0]?.text;
      const reply = replyText ? replyText.trim() : "Umm aru vana";
      history.push({ role: "model", parts: [{ text: reply }] });
      fallbackSent.set(chatId, false);
      return reply;
    } catch (e2) {
      console.error("Second attempt failed:", e2.message);
      if (!fallbackSent.get(chatId)) {
        fallbackSent.set(chatId, true);
        return "I'm out right now! paxi bolum la 😅";
      } else {
        console.log("⏩ Fallback already sent, skipping.");
        return null;
      }
    }
  }
}

// ---------- PERSON DETECTION ----------
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
      console.log("✅ Bot connected!");
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
    if (reply === null) return;

    // Human‑like delay before sending
    const delay = Math.floor(Math.random() * 2000) + 3000;
    await new Promise(resolve => setTimeout(resolve, delay));

    await sock.sendMessage(chatId, { text: reply });
    console.log(`💬 Replied: ${reply}`);

    if (batch.pendingBuffer && batch.pendingBuffer.length > 0) {
      const newTimer = setTimeout(() => processBatch(chatId, personDesc), 5000);
      pendingBatches.set(chatId, { buffer: [...batch.pendingBuffer], timer: newTimer, processing: false, personDesc });
      console.log(`🔄 [${senderName}] New batch from queued messages.`);
    }
  }

  sock.ev.on("creds.update", saveCreds);
}

// ---------- HTTP SERVER ----------
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
