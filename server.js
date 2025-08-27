// server.js
// WhatsApp Cloud API bot + OCR (OCR.Space) + forward to Google Sheets (Apps Script WebApp)

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;              // ex: Pat2F9cr01
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;        // ex: 816790541507574
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;          // EAAP...
const OCR_API_KEY = process.env.OCR_API_KEY;                // OCR.Space key
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK || "";    // Apps Script WebApp URL (optional)

const WA_BASE = "https://graph.facebook.com/v21.0";

async function sendText(to, body) {
  return axios.post(
    `${WA_BASE}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// GET / (health)
app.get("/", (_req, res) => res.status(200).send("OK"));

// GET /webhook - verification
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

// helper: get temporary public URL for media
async function getMediaUrl(mediaId) {
  const r = await axios.get(`${WA_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    params: { fields: "url,mime_type,file_size,sha256" },
  });
  return r.data?.url;
}

// helper: OCR.Space
async function runOCRSpaceViaUrl(imageUrl) {
  try {
    const form = new URLSearchParams();
    form.append("url", imageUrl);
    form.append("language", "por");                 // Portuguese
    form.append("isOverlayRequired", "false");
    const resp = await axios.post("https://api.ocr.space/parse/image", form, {
      headers: {
        apikey: OCR_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 30000,
    });
    const parsed = resp.data?.ParsedResults?.[0]?.ParsedText || "";
    return parsed.trim();
  } catch (err) {
    console.error("OCR.Space error:", err?.response?.data || err.message);
    return "";
  }
}

// POST /webhook - receive events
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const name = value?.contacts?.[0]?.profile?.name || "";
    const type = msg.type;

    if (type === "text" && msg.text?.body) {
      const body = msg.text.body.trim();
      if (body === "/menu") {
        await sendText(
          from,
          "📋 *Menu*\n\n• Envie um *print* (imagem) que eu extraio o texto.\n• Envie */menu* para ver opções."
        );
      } else {
        await sendText(from, `Você disse: ${body}`);
      }
      return res.sendStatus(200);
    }

    if (type === "image" && msg.image?.id) {
      try {
        const mediaUrl = await getMediaUrl(msg.image.id);
        const text = await runOCRSpaceViaUrl(mediaUrl);

        const reply = text
          ? `🧾 *Texto reconhecido:*\n\n${text.slice(0, 3000)}`
          : "Não consegui identificar texto na imagem. Pode enviar um print mais nítido?";
        await sendText(from, reply);

        if (SHEETS_WEBHOOK) {
          const payload = { from, name, text, mediaUrl, mediaId: msg.image.id, ts: Date.now() };
          axios.post(SHEETS_WEBHOOK, payload).catch(err => {
            console.error("Erro ao salvar no Google Sheets:", err?.response?.data || err.message);
          });
        }
      } catch (e) {
        console.error("Erro no fluxo imagem/OCR:", e?.response?.data || e.message);
        await sendText(from, "Tentei ler o texto do seu print, mas algo deu errado. Pode reenviar a imagem?");
      }
      return res.sendStatus(200);
    }

    if (type === "document" && msg.document?.id && msg.document?.mime_type?.startsWith("image/")) {
      try {
        const mediaUrl = await getMediaUrl(msg.document.id);
        const text = await runOCRSpaceViaUrl(mediaUrl);
        const reply = text
          ? `🧾 *Texto reconhecido (doc):*\n\n${text.slice(0, 3000)}`
          : "Não consegui identificar texto nesse arquivo de imagem.";
        await sendText(from, reply);
        if (SHEETS_WEBHOOK) {
          const payload = { from, name, text, mediaUrl, mediaId: msg.document.id, ts: Date.now() };
          axios.post(SHEETS_WEBHOOK, payload).catch(err => {
            console.error("Erro ao salvar no Google Sheets:", err?.response?.data || err.message);
          });
        }
      } catch (e) {
        console.error("Erro no OCR de documento:", e?.response?.data || e.message);
      }
      return res.sendStatus(200);
    }

    await sendText(from, "Recebi sua mensagem! Envie um *print (imagem)* para extrair o texto.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`Webhook on ${PORT}`));
