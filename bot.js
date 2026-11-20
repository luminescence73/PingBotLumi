import { client } from "./src/runtime/client.js";
import "./src/guild/members.js";
import "./src/runtime/messages.js";
import "./src/runtime/interactions.js";
import "./src/runtime/ready.js";

for (const required of ["DISCORD_BOT", "GOOGLE_TRANSLATE_API_KEY", "DATABASE_URL"]) {
  if (!process.env[required]) {
    console.error(`❌ Missing Railway variable: ${required}`);
  }
}

client.login(process.env.DISCORD_BOT).catch(error => {
  console.error("❌ Discord login failed:", error);
  process.exitCode = 1;
});
