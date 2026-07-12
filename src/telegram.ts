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
  const html = markdownToHtml(text);
  const chunks = balanceBoldAcrossChunks(chunkMessage(html));
  for (const chunk of chunks) {
    await sendSingleMessage(chunk);
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

/** Long-poll-free fetch of pending updates since `offset`. Does not mark them read on Telegram's side by itself. */
export async function getTelegramUpdates(offset?: number): Promise<TelegramUpdate[]> {
  const params = offset !== undefined ? `?offset=${offset}&timeout=0` : "?timeout=0";
  const res = await fetch(`${API_URL}/getUpdates${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram getUpdates failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { result: TelegramUpdate[] };
  return data.result;
}
