import { config } from "./config.js";
import { runDeepScan, runFlashScan } from "./scanners.js";
import { getLastTelegramUpdateId, setLastTelegramUpdateId } from "./state.js";
import { getTelegramUpdates } from "./telegram.js";

function matchesCommand(text: string, command: string): boolean {
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return firstWord === command || firstWord.startsWith(`${command}@`);
}

async function main() {
  const lastUpdateId = await getLastTelegramUpdateId();
  const updates = await getTelegramUpdates(lastUpdateId !== undefined ? lastUpdateId + 1 : undefined);

  if (updates.length === 0) {
    console.log("No new Telegram messages.");
    return;
  }

  let highestUpdateId = lastUpdateId ?? 0;

  for (const update of updates) {
    highestUpdateId = Math.max(highestUpdateId, update.update_id);

    const text = update.message?.text;
    const chatId = update.message?.chat.id;
    if (!text || chatId === undefined) continue;
    if (String(chatId) !== config.telegramChatId) {
      console.log(`Ignoring message from unauthorized chat ${chatId}`);
      continue;
    }

    if (matchesCommand(text, "/scan")) {
      console.log("Manual /scan received — running deep scan.");
      await runDeepScan(true);
    } else if (matchesCommand(text, "/flash")) {
      console.log("Manual /flash received — running flash check.");
      await runFlashScan(true);
    }
  }

  await setLastTelegramUpdateId(highestUpdateId);
}

main().catch((err) => {
  console.error("Telegram listener failed:", err);
  process.exitCode = 1;
});
