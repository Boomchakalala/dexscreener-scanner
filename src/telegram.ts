import { config } from "./config.js";

const API_URL = `https://api.telegram.org/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LENGTH = 4000;

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
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

export async function sendTelegramMessage(text: string): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    await sendSingleMessage(chunk);
  }
}
