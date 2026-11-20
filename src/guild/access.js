import { PLAYSTYLE, REMINDERS, SOCIAL, STAFF_ROLES, TOURNAMENTS } from "../../roleConfig.js";
import { CHANNELS, LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { client } from "../runtime/client.js";
import { ChannelType } from "discord.js";

export const ASHEN_WARRIORS = "1507567323161038899";

export const ONBOARDING_COMPLETE = "1540336639635628032";

export const PROTECTED_ROLES = new Set(Object.values(STAFF_ROLES));

export const LANGUAGES = Object.fromEntries(
  Object.entries(LANGUAGE_CHANNELS).map(([key, value]) => [key, {
    name: value.name,
    emoji: value.emoji,
    role: value.role
  }])
);

export const RESETTABLE_ROLES = new Set([
  ASHEN_WARRIORS,
  ONBOARDING_COMPLETE,
  ...Object.values(LANGUAGES).map(x => x.role),
  ...Object.values(PLAYSTYLE).map(x => x.role),
  ...Object.values(SOCIAL).map(x => x.role),
  ...Object.values(REMINDERS).map(x => x.role),
  ...Object.values(TOURNAMENTS).map(x => x.role)
]);

function isTempOwnerRole(role) {
  return !!role?.name && /^(?:temp|temporary)[\s_-]*owners?$/i.test(role.name.trim());
}

export function commandStaffRoleIds(guild) {
  const ids = new Set([
    STAFF_ROLES.ADMIN,
    STAFF_ROLES.LEADER,
    STAFF_ROLES.DEPUTY,
    STAFF_ROLES.OFFICERS
  ]);

  for (const role of guild?.roles?.cache?.values?.() || []) {
    if (isTempOwnerRole(role)) ids.add(role.id);
  }

  return [...ids];
}

export function isStaff(member) {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  return commandStaffRoleIds(member.guild).some(roleId => member.roles?.cache?.has(roleId));
}

export function getGuild() {
  const byKnownChannel =
    client.channels.cache.get(CHANNELS.START_HERE)?.guild ||
    client.channels.cache.get(WELCOME_CATEGORY_ID)?.guild;

  return byKnownChannel || client.guilds.cache.first() || null;
}

export async function resolveAshenGuild(guildOverride = null) {
  if (guildOverride?.id) return guildOverride;

  const cached =
    client.channels.cache.get(CHANNELS.START_HERE)?.guild ||
    client.channels.cache.get(WELCOME_CATEGORY_ID)?.guild;

  if (cached) return cached;

  const startHere = await client.channels
    .fetch(CHANNELS.START_HERE)
    .catch(() => null);

  if (startHere?.guild) return startHere.guild;

  const welcomeCategory = await client.channels
    .fetch(WELCOME_CATEGORY_ID)
    .catch(() => null);

  if (welcomeCategory?.guild) return welcomeCategory.guild;

  return client.guilds.cache.first() || null;
}

export async function refreshAshenSidebarReferences(guildOverride = null) {
  const guild = await resolveAshenGuild(guildOverride);
  if (!guild) return;
  await guild.channels.fetch();

  const key = value => String(value || "")
    .normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const category = names => guild.channels.cache.find(ch =>
    ch.type === ChannelType.GuildCategory &&
    names.some(name => key(ch.name).includes(key(name)))
  );

  const welcome = category(["ASHEN | WELCOME", "ASHEN | ENTRY", "WELCOME TO ASHEN"]);
  const command = category(["ASHEN | COMMAND", "ASHEN INFO"]);
  const commons = category(["ASHEN | COMMONS", "ASHEN SOCIAL"]);
  if (welcome) WELCOME_CATEGORY_ID = welcome.id;
  if (command) IMPORTANT_CATEGORY_ID = command.id;
  if (commons) SOCIAL_CATEGORY_ID = commons.id;

  // Diagnose duplicate names without changing any channels. Channel IDs
  // and message history must be reviewed by staff before safe removal.
  for (const logicalName of ["guild-pings", "staff-chat"]) {
    const matches = [...guild.channels.cache.values()].filter(ch =>
      ch.type === ChannelType.GuildText &&
      key(ch.name).endsWith(key(logicalName))
    );
    if (matches.length > 1) {
      console.warn(
        "⚠️ Duplicate sidebar channels detected for " + logicalName + ": " +
        matches.map(ch => ch.name + " (" + ch.id + ")").join(", ") +
        ". No channels were renamed or deleted."
      );
    }
  }
}

export let WELCOME_CATEGORY_ID = "1540332301962182686";
export let IMPORTANT_CATEGORY_ID = "1507566069362069564";
export let SOCIAL_CATEGORY_ID = "1542252166222315532";
