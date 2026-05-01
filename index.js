const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { GoogleGenAI } = require("@google/genai");
const Groq = require("groq-sdk");
const pino = require("pino");
const http = require("http");
const qrcode = require("qrcode");

// =====================
// ENV / CLIENTS
// =====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GEMINI_API_KEY) console.warn("Missing GEMINI_API_KEY");
if (!GROQ_API_KEY) console.warn("Missing GROQ_API_KEY");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const groq = new Groq({ apiKey: GROQ_API_KEY });

// =====================
// CONFIG
// =====================
const ALLOWED_CONTACTS = {
  manikagurung:
    "She is my girlfriend and we are in love since past 3 4 years and we love each other. We can talk romantic and casually. I tease her sometimes. If there is no reason for saying bye then ask --> 'kina'",
  "Kalikoteeeyy Gangggg":
    "This is the group where all are from Kalikot, same class. We make fun, sometimes discuss. You can answer questions sometimes.",
  "97798681187532": "she is classmate of my BE class",
  Tilak:
    "he is my best friend, we talk rough, use muji, machikney, randi, lado, etc. It's normal. We make fun. and you can talk in english with him",
};

const BASE_SYSTEM_INSTRUCTION = `
You are Samir, a casual Nepali guy.

Talk like a real friend in romanized Nepali.
Be natural, short, slightly teasing sometimes, sometimes sweet.

Do NOT sound like an assistant or mention rules.
Do not repeat the same phrase too often.
Use occasional English only when it fits naturally.
`;

const MAX_HISTORY_ITEMS = 16;
const BATCH_WINDOW_MS = 5000;

// =====================
// STATE
// =====================
const chatHistory = new Map();       // chatId -> [{ role: "user"|"assistant", text }]
const pendingBatches = new Map();    // chatId -> { buffer, queued, timer, processing, meta }
const fallbackSent = new Map();      // chatId -> bool
const groupSubjectCache = new Map(); // chatId -> subject

let latestQR = null;
let sock = null;

// =====================
// HELPERS
// =====================
function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function lower(text) {
  return normalizeText(text).toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function tempFlag(map, key, ttlMs) {
  map.set(key, true);
  const t = setTimeout(() => map.delete(key), ttlMs);
  if (typeof t.unref === "function") t.unref();
}

function getHistory(chatId) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  return chatHistory.get(chatId);
}

function pushHistory(chatId, role, text) {
  const history = getHistory(chatId);
  history.push({ role, text: normalizeText(text) });
  while (history.length > MAX_HISTORY_ITEMS) history.shift();
}

function historyToGeminiContents(history) {
  return history.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.text }],
  }));
}

function historyToGroqMessages(history, systemPrompt) {
  return [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.text,
    })),
  ];
}

function extractTextFromMessage(message) {
  const m = message?.ephemeralMessage?.message || message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.buttonsResponseMessage?.selectedButtonId ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    null
  );
}

async function getGroupSubject(chatId) {
  if (!chatId.endsWith("@g.us")) return null;
  if (groupSubjectCache.has(chatId)) return groupSubjectCache.get(chatId);

  try {
    const meta = await sock.groupMetadata(chatId);
    const subject = meta?.subject || null;
    if (subject) groupSubjectCache.set(chatId, subject);
    return subject;
  } catch {
    return null;
  }
}

function getPersonDescription(senderNumber, senderName, chatSubject) {
  const senderNameLower = lower(senderName);
  const chatSubjectLower = lower(chatSubject);

  for (const [key, desc] of Object.entries(ALLOWED_CONTACTS)) {
    if (/^\d+$/.test(key) && key === senderNumber) return desc;

    const keyLower = lower(key);
    if (keyLower === senderNameLower) return desc;
    if (chatSubjectLower && keyLower === chatSubjectLower) return desc;
  }

  return null;
}

function buildSystemPrompt(personDescription) {
  return [
    BASE_SYSTEM_INSTRUCTION.trim(),
    personDescription
      ? `About this person: ${personDescription}`
      : "About this person: normal friend.",
    "Reply to the latest message only unless context clearly needs more.",
    "Keep replies usually short and human.",
  ].join("\n\n");
}

function extractModelText(response) {
  return (
    normalizeText(response?.text) ||
    normalizeText(
      response?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join(" ")
    ) ||
    ""
  );
}

function cleanReply(text) {
  return normalizeText(text)
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeReply(text) {
  let reply = cleanReply(text);
  if (!reply) return null;

  reply = reply
    .replace(/\btapaai\b/gi, "timi")
    .replace(/\bhuncha\b/gi, "hunxa")
    .replace(/\bchha\b/gi, "xa")
    .replace(/\bcha\b/gi, "xa");

  if (reply.split(/\s+/).length > 22) {
    reply = reply.split(/\s+/).slice(0, 22).join(" ");
  }

  if (Math.random() < 0.18) {
    reply += pick([" 😏", " 😂", " 😅", ""]);
  }

  return normalizeText(reply);
}

function quickReply(text) {
  const m = lower(text).replace(/[.?!]+$/g, "");

  if (["aww", "umm", "ummm", "ehh", "eaaa", "uhh", "hmm", "hmmm"].includes(m)) {
    return pick(["k bhayo?", "aru vana na", "kati umm vaneko 😄"]);
  }

  if (m === "bye" || m === "bye bye" || m === "cya") {
    return pick(["bye bye", "paxi bolam la", "la la bye"]);
  }

  if (m === "k xa" || m === "k xa?") {
    return pick(["thikai xa, timi sunau", "kei xaina, timi?", "sab thikai xa, timi k gardai xau?"]);
  }

  if (m.includes("k gardai")) {
    return pick(["kei xaina, basiraxu", "mobile chalairaxu", "timro msg heriraxu"]);
  }

  if (m.includes("aru vana")) {
    return pick(["aru keii vana na ta", "la vana na", "keii sundaixa"]);
  }

  if (m.includes("khana")) {
    return pick(["umm khaisake, timi?", "khaye, timi le?", "khane bela bhayo jasto xa"]);
  }

  if (m.length <= 3) {
    return pick(["k?", "ehh?", "kina?"]);
  }

  return null;
}

function shouldUseGemini(text) {
  const m = lower(text);

  if (
    m.includes("why") ||
    m.includes("how") ||
    m.includes("explain") ||
    m.includes("compare") ||
    m.includes("summar") ||
    m.includes("what is") ||
    m.includes("calculate") ||
    text.length > 140
  ) {
    return true;
  }

  return false;
}

function splitForSending(text) {
  const t = cleanReply(text);
  if (!t) return [];

  const byNewline = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byNewline.length > 1) return byNewline.slice(0, 2);

  const sentenceParts = t.match(/[^.!?]+[.!?]*/g);
  if (sentenceParts && sentenceParts.length > 1 && t.length > 80) {
    return sentenceParts.map((s) => s.trim()).filter(Boolean).slice(0, 2);
  }

  return [t];
}

async function sendHumanLike(chatId, text) {
  const parts = splitForSending(text);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const pause = 700 + Math.floor(Math.random() * 1100);
      await sleep(pause);
    }
    await sock.sendMessage(chatId, { text: parts[i] });
  }
}

// =====================
// AI CALLS
// =====================
async function callGemini(history, personDescription) {
  const systemPrompt = buildSystemPrompt(personDescription);

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: historyToGeminiContents(history),
    config: {
      systemInstruction: systemPrompt,
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: 90,
    },
  });

  return extractModelText(response);
}

async function callGroq(history, personDescription) {
  const systemPrompt = buildSystemPrompt(personDescription);
  const messages = historyToGroqMessages(history, systemPrompt);

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    temperature: 1.0,
    top_p: 0.95,
    max_completion_tokens: 90,
  });

  return normalizeText(completion?.choices?.[0]?.message?.content || "");
}

async function getAIReply(chatId, userText, personDescription) {
  const history = getHistory(chatId);

  const primary = shouldUseGemini(userText) ? "gemini" : "groq";
  const route = primary === "gemini" ? ["gemini", "groq"] : ["groq", "gemini"];

  for (const model of route) {
    try {
      let reply = "";

      if (model === "gemini") {
        reply = await callGemini(history, personDescription);
      } else {
        reply = await callGroq(history, personDescription);
      }

      reply = humanizeReply(reply);
      if (reply) return reply;
    } catch (err) {
      console.warn(`${model} failed for ${chatId}:`, err.message);
    }
  }

  return null;
}

// =====================
// MESSAGE BATCHING
// =====================
function ensureBatch(chatId, meta, text) {
  if (!pendingBatches.has(chatId)) {
    const timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
    pendingBatches.set(chatId, {
      buffer: [text],
      queued: [],
      timer,
      processing: false,
      meta,
    });
    return;
  }

  const batch = pendingBatches.get(chatId);
  batch.meta = meta;

  if (batch.processing) {
    batch.queued.push(text);
    return;
  }

  batch.buffer.push(text);
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
}

async function processBatch(chatId) {
  const batch = pendingBatches.get(chatId);
  if (!batch || batch.processing) return;

  batch.processing = true;
  clearTimeout(batch.timer);
  batch.timer = null;

  const combinedMessage = batch.buffer.map(normalizeText).filter(Boolean).join("\n");
  batch.buffer = [];

  const personDesc = batch.meta?.personDesc || null;
  const senderName = batch.meta?.senderName || "friend";

  console.log(`📩 [${senderName}] ${combinedMessage}`);

  try {
    if (!combinedMessage) {
      batch.processing = false;
      if (batch.queued.length > 0) {
        batch.buffer = batch.queued.splice(0);
        batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
      } else {
        pendingBatches.delete(chatId);
      }
      return;
    }

    pushHistory(chatId, "user", combinedMessage);

    const quick = quickReply(combinedMessage);
    let reply = quick || (await getAIReply(chatId, combinedMessage, personDesc));

    if (!reply) {
      if (!fallbackSent.get(chatId)) {
        tempFlag(fallbackSent, chatId, 120000);
        reply = pick([
          "I'm out right now! paxi bolum la 😅",
          "ali busy xu, paxi bolam",
          "ekxin paxi gara na",
        ]);
      } else {
        reply = null;
      }
    }

    if (!reply) {
      batch.processing = false;
      if (batch.queued.length > 0) {
        batch.buffer = batch.queued.splice(0);
        batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
      } else {
        pendingBatches.delete(chatId);
      }
      return;
    }

    const finalReply = humanizeReply(reply);
    if (!finalReply) {
      batch.processing = false;
      if (batch.queued.length > 0) {
        batch.buffer = batch.queued.splice(0);
        batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
      } else {
        pendingBatches.delete(chatId);
      }
      return;
    }

    const delay = 1200 + Math.floor(Math.random() * 2400);
    await sleep(delay);
    await sendHumanLike(chatId, finalReply);

    pushHistory(chatId, "assistant", finalReply);
    fallbackSent.delete(chatId);

    console.log(`💬 Replied to ${chatId}: ${finalReply}`);
  } catch (err) {
    console.error("Batch processing error:", err);
  } finally {
    batch.processing = false;

    if (batch.queued.length > 0) {
      batch.buffer = batch.queued.splice(0);
      batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
    } else if (batch.buffer.length === 0) {
      pendingBatches.delete(chatId);
    } else {
      batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
    }
  }
}

// =====================
// BOT STARTUP
// =====================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      latestQR = qr;
      console.log("🔹 QR received. Visit /qr");
    }

    if (connection === "open") {
      latestQR = null;
      console.log("✅ Bot connected");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("Connection closed. Reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async (msg) => {
    if (msg.type !== "notify") return;

    for (const m of msg.messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        if (m.key.remoteJid?.endsWith("@broadcast")) continue;

        const chatId = m.key.remoteJid;
        const text = extractTextFromMessage(m.message);
        if (!text) continue;

        const senderJid = m.key.participant || chatId;
        const senderNumber = senderJid?.split("@")[0] || "";
        const senderName = m.pushName || "";
        const chatSubject = await getGroupSubject(chatId);

        const personDesc = getPersonDescription(senderNumber, senderName, chatSubject);
        if (!personDesc) {
          console.log(`🚫 Blocked: ${senderNumber} (${senderName}) in ${chatId}`);
          continue;
        }

        ensureBatch(
          chatId,
          {
            personDesc,
            senderName,
            senderNumber,
            chatSubject,
          },
          text
        );
      } catch (err) {
        console.error("Message handler error:", err);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// =====================
// HEALTH / QR SERVER
// =====================
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.url === "/qr" && latestQR) {
    const qrImage = await qrcode.toDataURL(latestQR);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h1>Scan QR</h1>
          <img src="${qrImage}" style="max-width:300px;" />
        </body>
      </html>
    `);
    return;
  }

  if (req.url === "/qr" && !latestQR) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>✅ Already logged in.</h2>");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running");
});

server.listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

startBot().catch((err) => {
  console.error("Failed to start bot:", err);
});
