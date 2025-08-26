import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import getRawBody from "raw-body";
import crypto from "crypto";

dotenv.config();
const app = express();
const { PORT=3000, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, APP_SECRET } = process.env;

// captura raw body para verificar assinatura
app.use(async (req, res, next) => {
  if (req.method === "POST") {
    req.rawBody = await getRawBody(req);
    try { req.body = JSON.parse(req.rawBody.toString("utf8") || "{}"); } catch { req.body = {}; }
  }
  next();
});

// rota de saúde
app.get("/", (_, res) => res.status(200).send("OK"));

// verificação do webhook (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// verifica a assinatura do Meta
function verifySignature(req) {
  if (!APP_SECRET) return true; // se não setar, não verifica
  const sig = req.header("x-hub-signature-256") || "";
  const hmac = crypto.createHmac("sha256", APP_SECRET);
  const digest = "sha256=" + hmac.update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

// recebe eventos (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(401);

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages && messages.length > 0) {
      const msg = messages[0];
      const from = msg.from;
      const text = msg.text?.body || "";
      const name = value?.contacts?.[0]?.profile?.name || "aí";

      // marca como lida
      await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: msg.id })
      });

      // responde
      const reply = text
        ? `Olá, ${name}! 👋 Recebi sua mensagem: “${text}”. Já retorno.`
        : `Olá, ${name}! 👋 Recebi sua mensagem. Já retorno.`;

      await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: reply }
        })
      });
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Webhook on ${PORT}`));
