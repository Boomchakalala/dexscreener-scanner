import { config } from "./config.js";

const API_URL = `https://api.telegram.org/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LENGTH = 4000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converts the model's lightweight **bold** markers into Telegram HTML, escaping everything else. */
function markdownBoldToHtml(text: string): string {
  return text
    .split(/\*\*(.+?)\*\*/gs)
    .map((part, i) => (i % 2 === 1 ? `<b>${escapeHtml(part)}</b>` : escapeHtml(part)))
    .join("");
}

/** Re-opens/closes <b> across a chunk boundary so every chunk is independently valid HTML. */
function balanceBoldAcrossChunks(chunks: string[]): string[] {
  let openBold = false;
  return chunks.map((chunk) => {
    let piece = openBold ? `<b>${chunk}` : chunk;
    const opens = (piece.match(/<b>/g) || []).length;
    const closes = (piece.match(/<\/b>/g) || []).length;
    openBold = opens > closes;
    if (openBold) piece += "</b>";
    return piece;
  });
}

function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendSingleMessage(text: string): Promise<void> {
  const res = await fetch(`${API_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const html = markdownBoldToHtml(text);
  const chunks = balanceBoldAcrossChunks(chunkMessage(html));
  for (const chunk of chunks) {
    await sendSingleMessage(chunk);
  }
}
