import { config } from "./config.js";

const API_URL = `https://api.telegram.org/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LENGTH = 4000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TOKEN_PATTERN = /\*\*(.+?)\*\*|\[READ\]\((\S+?)\)/gs;

/** Converts the model's lightweight **bold** and [READ](url) markers into Telegram HTML, escaping everything else. */
function markdownToHtml(text: string): string {
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const [full, boldText, linkUrl] = match;
    const index = match.index ?? 0;
    result += escapeHtml(text.slice(lastIndex, index));
    if (boldText !== undefined) {
      result += `<b>${escapeHtml(boldText)}</b>`;
    } else if (linkUrl !== undefined) {
      result += `<a href="${escapeHtml(linkUrl)}">Read</a>`;
    }
    lastIndex = index + full.length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptSend(text: string): Promise<void> {
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

// A single transient 429/5xx used to drop an ENTRY/EXIT notification silently — the
// per-position try/catch elsewhere stops one bad send from killing the whole ledger check,
// but the message itself was still just gone. One retry after a short delay is cheap
// insurance against exactly that.
const SEND_RETRY_DELAY_MS = 1500;

async function sendSingleMessage(text: string): Promise<void> {
  try {
    await attemptSend(text);
  } catch (err) {
    console.warn(`Telegram send failed, retrying once: ${(err as Error).message}`);
    await sleep(SEND_RETRY_DELAY_MS);
    await attemptSend(text);
  }
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const html = markdownToHtml(text);
  const chunks = balanceBoldAcrossChunks(chunkMessage(html));
  for (const chunk of chunks) {
    await sendSingleMessage(chunk);
  }
}

// (The old getUpdates polling helper lived here — removed once Telegram delivery moved to
// the webhook on telegram-scan-webhook; a bot can't poll getUpdates while a webhook is set.)
