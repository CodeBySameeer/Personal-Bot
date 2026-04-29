const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pino = require("pino");

// ========== REPLACE THESE TWO VALUES ==========
const API_KEY = "AIzaSyAuOyzdGVuuPsppkG_tJV8SrJRyB7ezcdI"; // e.g., AIza...
const PHONE_NUMBER = "9779766884391"; // your number without + (e.g., 9779812345678)
// =============================================

const genAI = new GoogleGenerativeAI(API_KEY);

const SYSTEM_PROMPT = `You are a Nepali person chatting with a close friend on WhatsApp.
Always reply in Romanized Nepali (English letters, Nepali language).
Keep replies short and casual, like a real human.
Use words like 'timi', 'malai', 'huncha', 'hai', etc.
Match the tone. Never mention being an AI.`;

const chatHistory = new Map();

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
      contents: history.map((m) => ({
        role: m.role === "model" ? "model" : "user",
        parts: m.parts,
      })),
      generationConfig: { maxOutputTokens: 150, temperature: 0.9 },
    });
    const reply = result.response.text().trim();
    history.push({ role: "model", parts: [{ text: reply }] });
    return reply;
  } catch (e) {
    return "ekchin pachi kura garam hai, aile line busy cha 😅";
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("connection.update", (update) => {
    const { connection } = update;
    if (connection === "open") {
      console.log("✅ Bot connected! Will reply to all messages.");
      return;
    }
    if (connection === "close") {
      console.log("Connection closed, reconnecting...");
      startBot();
      return;
    }
  });

  // Request pairing code after handshake
  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER.trim());
      console.log("🔥 PAIRING CODE:", code);
      console.log(
        "👉 Open WhatsApp → Settings → Linked Devices → Link a Device"
      );
      console.log(
        '👉 Choose "Link with phone number" and enter the code above'
      );
    } catch (e) {
      console.log(
        "Failed to get pairing code. Check your phone number. Error:",
        e.message
      );
    }
  }, 5000);

  // Listen for new messages
  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m.message || msg.type !== "notify" || m.key.fromMe) return;
    const text = m.message.conversation || m.message.extendedTextMessage?.text;
    if (!text) return;

    console.log(`📩 ${text}`);
    const reply = await getAIReply(m.key.remoteJid, text);
    await sock.sendMessage(m.key.remoteJid, { text: reply });
    console.log(`💬 Replied: ${reply}`);
  });

  sock.ev.on("creds.update", saveCreds);
}

startBot();
