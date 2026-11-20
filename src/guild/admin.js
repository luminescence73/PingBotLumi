import { MessageFlags } from "discord.js";
import { isStaff } from "./access.js";
import { migrateLegacyIntroductions } from "./memberCards.js";

export async function adminApplyTheme(interaction) {
  return interaction.reply({
    content: "Automatic name changes are disabled. Ashen staff control channel names manually.",
    flags: MessageFlags.Ephemeral
  });
}

export async function adminSyncIntroductions(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: "❌ Only Ashen staff can run the introductions sync.",
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await migrateLegacyIntroductions(true);

  if (result?.reason === "introductions_channel_unavailable") {
    return interaction.editReply(
      "❌ Vestra cannot access the configured #introductions channel."
    );
  }

  if (!result) {
    return interaction.editReply(
      "⚠️ The introductions sync ran but did not return a result. Check #bot-logs / Railway logs."
    );
  }

  return interaction.editReply([
    result.succeeded ? "✅ **Introductions sync complete.**" : "⚠️ **Introductions sync finished with errors.**",
    `Found: **${result.scannedIntroMessages ?? 0}** old Vestra intro/guide messages`,
    `Deleted: **${result.removed ?? 0}**`,
    `Delete failures: **${result.deleteFailures ?? 0}**`,
    `Unique member cards rebuilt: **${result.rebuilt ?? 0}**`,
    `Rebuild failures: **${result.rebuildFailures ?? 0}**`
  ].join("\n"));
}
