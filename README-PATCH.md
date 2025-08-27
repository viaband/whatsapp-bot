# Patch: WhatsApp OCR Bot (base64 to OCR.Space)

**Why this patch?** WhatsApp Cloud media URLs require Authorization. External services like OCR.Space cannot fetch those URLs directly.  
This patch downloads the media with your Bearer token and sends it to OCR.Space as **base64**.

## What changed
- Download media bytes with Authorization.
- Send to OCR.Space using `base64Image` (data URI).
- Keeps forwarding to your Google Sheet via Apps Script WebApp.

Just redeploy with this `server.js`.
