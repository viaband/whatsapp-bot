// server.js (patched)
// Fix: download WhatsApp media with Authorization and send to OCR.Space as base64 (not URL)
// WhatsApp media URLs require Bearer auth; external services can't fetch them directly.

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json({ limit: "15mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OCR_API_KEY = process.env.OCR_API_KEY;
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK || "";

const WA_BASE = "https://graph.facebook.com/v21.0";

async function sendText(to, body) {
  return axios.post(
    `${WA_BASE}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// Health
app.get("/", (_req, res) => res.status(200).send("OK"));

// Webhook verification
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

// Get media metadata (signed URL + mime)
async function getMediaMeta(mediaId) {
  const r = await axios.get(`${WA_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    params: { fields: "url,mime_type,file_size,sha256" },
  });
  return { url: r.data?.url, mime: r.data?.mime_type || "image/jpeg" };
}

// Download media bytes using Authorization
async function downloadMediaBuffer(url) {
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
  });
  return Buffer.from(r.data);
}

// OCR.Space with base64 payload
async function runOCRSpaceFromBuffer(buffer, mime) {
  try {
    const base64 = buffer.toString("base64");
    const dataUri = `data:${mime};base64,${base64}`;
    const form = new URLSearchParams();
    form.append("base64Image", dataUri);
    form.append("language", "por");
    form.append("isOverlayRequired", "false");

    const resp = await axios.post("https://api.ocr.space/parse/image", form, {
      headers: {
        apikey: OCR_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 45000,
    });

    const parsed = resp.data?.ParsedResults?.[0]?.ParsedText || "";
    return parsed.trim();
  } catch (err) {
    console.error("OCR.Space error:", err?.response?.data || err.message);
    return "";
  }
}

// Forward to Google Sheets (Apps Script)
async function forwardToSheet(payload) {
  if (!SHEETS_WEBHOOK) return;
  try {
    await axios.post(SHEETS_WEBHOOK, payload, { timeout: 15000 });
  } catch (err) {
    console.error("Erro ao salvar no Google Sheets:", err?.response?.data || err.message);
  }
}

// Webhook receiver
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
        await sendText(from, "📋 *Menu*\n\n• Envie um *print* (imagem) que eu extraio o texto.\n• Envie */menu* para ver opções.");
      } else {
        await sendText(from, `Você disse: ${body}`);
      }
      return res.sendStatus(200);
    }

    const handleImageLike = async (mediaId, label) => {
      try {
        const meta = await getMediaMeta(mediaId);         // url + mime
        const bin = await downloadMediaBuffer(meta.url);  // bytes via Bearer
        const text = await runOCRSpaceFromBuffer(bin, meta.mime);

        const reply = text
          ? `🧾 *Texto reconhecido (${label}):*\n\n${text.slice(0, 3000)}`
          : "Não consegui identificar texto. Pode enviar um print mais nítido?";

        await sendText(from, reply);

        await forwardToSheet({
          from,
          name,
          text,
          mediaUrl: meta.url,   // nota: esta URL expira; guardamos apenas referência
          mediaId,
          ts: Date.now(),
        });
      } catch (e) {
        console.error("Erro no fluxo OCR:", e?.response?.data || e.message);
        await sendText(from, "Tentei ler o texto do seu print, mas algo deu errado. Pode reenviar a imagem?");
      }
    };

    if (type === "image" && msg.image?.id) {
      await handleImageLike(msg.image.id, "imagem");
      return res.sendStatus(200);
    }

    if (type === "document" && msg.document?.id && msg.document?.mime_type?.startsWith("image/")) {
      await handleImageLike(msg.document.id, "documento");
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
