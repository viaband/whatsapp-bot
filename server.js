// server.js
// WhatsApp Cloud API bot + OCR (OCR.Space) + forward para Google Sheets (Apps Script WebApp)

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;              // ex: Pat2F9cr01
const APP_SECRET = process.env.APP_SECRET || "";            // opcional (verificação de assinatura)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;        // ex: 816790541507574
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;          // EAAP...
const OCRSPACE_API_KEY = process.env.OCRSPACE_API_KEY;      // sua chave OCR.Space
const OCR_FORWARD_URL = process.env.OCR_FORWARD_URL || "";  // URL do WebApp do Apps Script (opcional)

// ---------- Helpers ----------
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

// pega URL assinada de uma mídia do WhatsApp
async function getMediaUrl(mediaId) {
  const r = await axios.get(`${WA_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    params: { fields: "url,mime_type,sha256,file_size" },
  });
  return r.data?.url;
}

// OCR via OCR.Space (usando URL pública da imagem do WhatsApp)
async function runOCRSpace(imageUrl) {
  try {
    const form = new URLSearchParams();
    form.append("url", imageUrl);
    form.append("language", "por");             // português (pode usar "por+eng")
    form.append("isOverlayRequired", "false");

    const resp = await axios.post("https://api.ocr.space/parse/image", form, {
      headers: {
        apikey: OCRSPACE_API_KEY,
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

// encaminha resultado para seu Apps Script (Google Sheets)
async function forwardToSheet(payload) {
  if (!OCR_FORWARD_URL) return;
  try {
    await axios.post(OCR_FORWARD_URL, payload, { timeout: 15000 });
  } catch (err) {
    console.error("Erro ao salvar no Google Sheets:", err?.response?.data || err.message);
  }
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.send("OK"));

// verificação do webhook (Meta → GET)
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

// recepção de eventos (Meta → POST)
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from; // telefone do usuário (E.164)
    const name = value?.contacts?.[0]?.profile?.name || "";
    const type = msg.type;

    // ---- Texto ----
    if (type === "text" && msg.text?.body) {
      const body = msg.text.body.trim();

      // exemplo simples de resposta:
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

    // ---- Imagem (print) ----
    if (type === "image" && msg.image?.id) {
      try {
        // 1) URL pública da imagem
        const mediaUrl = await getMediaUrl(msg.image.id);

        // 2) OCR
        const text = await runOCRSpace(mediaUrl);

        // 3) Resposta no WhatsApp
        const reply = text
          ? `🧾 *Texto reconhecido:*\n\n${text.slice(0, 3000)}`
          : "Não consegui identificar texto na imagem. Pode enviar um print mais nítido?";
        await sendText(from, reply);

        // 4) Encaminhar para a planilha (Apps Script WebApp)
        await forwardToSheet({
          from,
          name,
          text,
          mediaUrl,
          mediaId: msg.image.id,
          ts: Date.now(),
        });
      } catch (e) {
        console.error("Erro no fluxo de imagem/OCR:", e?.response?.data || e.message);
        await sendText(
          from,
          "Tentei ler o texto do seu print, mas algo deu errado. Pode reenviar a imagem?"
        );
      }
      return res.sendStatus(200);
    }

    // ---- Documento do tipo imagem (opcional) ----
    if (type === "document" && msg.document?.id && msg.document?.mime_type?.startsWith("image/")) {
      try {
        const mediaUrl = await getMediaUrl(msg.document.id);
        const text = await runOCRSpace(mediaUrl);

        const reply = text
          ? `🧾 *Texto reconhecido:*\n\n${text.slice(0, 3000)}`
          : "Não consegui identificar texto no arquivo de imagem. Pode enviar um print mais nítido?";
        await sendText(from, reply);

        await forwardToSheet({
          from,
          name,
          text,
          mediaUrl,
          mediaId: msg.document.id,
          ts: Date.now(),
        });
      } catch (e) {
        console.error("Erro no OCR de documento:", e?.response?.data || e.message);
      }
      return res.sendStatus(200);
    }

    // outros tipos (áudio, sticker, etc.) – resposta padrão
    await sendText(from, "Recebi sua mensagem! Envie um *print (imagem)* para extrair o texto.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`Webhook on port ${PORT}`));
