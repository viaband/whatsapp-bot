
// server.js (atualizado)
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "15mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OCR_API_KEY = process.env.OCR_API_KEY;
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK;

const GRAPH = "https://graph.facebook.com/v21.0";

async function sendText(to, body) {
  try {
    const url = `${GRAPH}/${PHONE_NUMBER_ID}/messages`;
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.response?.data || err.message);
  }
}

async function getMediaMeta(mediaId) {
  const url = `${GRAPH}/${mediaId}`;
  const res = await axios.get(url, {
    params: { fields: "url,mime_type" },
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    timeout: 15000,
  });
  return res.data;
}

async function downloadMedia(meta) {
  const res = await axios.get(meta.url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    timeout: 25000,
  });
  const buf = Buffer.from(res.data);
  console.log(`[download] mime=${meta.mime_type} bytes=${buf.length.toLocaleString()}`);
  return buf;
}

async function runOCRSpaceFromBuffer(buffer, mime) {
  try {
    const base64 = `data:${mime};base64,${buffer.toString("base64")}`;
    const form = new FormData();
    form.append("base64Image", base64);
    form.append("language", "por");
    form.append("isTable", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");

    const res = await axios.post("https://api.ocr.space/parse/image", form, {
      headers: {
        apikey: OCR_API_KEY,
        ...form.getHeaders(),
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const data = res.data;
    if (data.IsErroredOnProcessing) {
      console.error("OCR.Space error:", data.ErrorMessage || data);
      return "";
    }
    const parsed = data?.ParsedResults?.[0]?.ParsedText || "";
    const txt = (parsed || "").trim();
    console.log(`[ocr] length=${txt.length}`);
    return txt;
  } catch (err) {
    console.error("Falha OCR:", err.response?.data || err.message);
    return "";
  }
}

async function forwardToSheet(payload) {
  if (!SHEETS_WEBHOOK) return;
  try {
    await axios.post(SHEETS_WEBHOOK, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
  } catch (err) {
    console.error("Erro ao enviar para Sheets:", err.response?.data || err.message);
  }
}

app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("[webhook] verificado");
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch (e) {
    console.error("Erro no GET /webhook:", e);
    return res.sendStatus(500);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    const statuses = value?.statuses?.[0];
    if (statuses) {
      console.log("[status]", statuses.status, statuses.id);
      return;
    }
    if (!message) return;
    const from = message.from;
    const name = value?.contacts?.[0]?.profile?.name || "Contato";
    console.log(`[msg] from=${from} type=${message.type}`);
    if (message.type === "text") {
      const body = message.text?.body || "";
      await sendText(from, `Olá, ${name}! 👋 Recebi sua mensagem: “${body}”.`);
      await forwardToSheet({ from, name, text: body, mediaUrl: "", mediaId: "", ts: Date.now() });
      return;
    }
    if (message.type === "image" || message.type === "document") {
      const mediaId = (message.image || message.document).id;
      let meta;
      try {
        meta = await getMediaMeta(mediaId);
      } catch (err) {
        console.error("Falha ao pegar meta:", err.response?.data || err.message);
        await sendText(from, "Não consegui baixar a imagem. Pode reenviar como *Foto/Imagem*?");
        return;
      }
      if (!meta?.mime_type?.startsWith("image/")) {
        await sendText(from, "Esse arquivo não parece ser uma imagem. Envie como *Foto/Imagem*.");
        return;
      }
      let bin;
      try {
        bin = await downloadMedia(meta);
      } catch (err) {
        console.error("Falha no download:", err.response?.data || err.message);
        await sendText(from, "Não consegui baixar a imagem. Tente enviar novamente.");
        return;
      }
      const text = await runOCRSpaceFromBuffer(bin, meta.mime_type);
      if (!text || !text.trim()) {
        await sendText(from, "Não consegui identificar texto. Pode enviar um print mais nítido?");
        return;
      }
      const preview = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
      await sendText(from, `🧾 *Texto reconhecido:*

${preview}`);
      await forwardToSheet({ from, name, text, mediaUrl: meta.url, mediaId, ts: Date.now() });
      return;
    }
    await sendText(from, "Tipo de mensagem não suportado. Envie uma *Foto/Imagem*.");
  } catch (e) {
    console.error("Erro no POST /webhook:", e);
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook online na porta ${PORT}`));
