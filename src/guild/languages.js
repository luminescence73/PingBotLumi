import { LANGUAGE_CHANNELS } from "../../guildConfig.js";

export const LANGUAGE_KEYS = Object.keys(LANGUAGE_CHANNELS);

export function languageByChannel(channelId) {
  return Object.entries(LANGUAGE_CHANNELS).find(([, info]) => info.channel === channelId) || null;
}
