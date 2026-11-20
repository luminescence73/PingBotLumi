import { REMINDERS, TOURNAMENTS } from "../../roleConfig.js";

const TZ = "America/Chicago";

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

export function isCentralDSTDate(year, month, day) {
  // U.S. DST: second Sunday in March through first Sunday in November.
  const marchSecondSunday = nthWeekdayOfMonth(year, 2, 0, 2);
  const novemberFirstSunday = nthWeekdayOfMonth(year, 10, 0, 1);
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  if (month === 3) return day >= marchSecondSunday;
  if (month === 11) return day < novemberFirstSunday;
  return false;
}

export function chicagoParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: weekdayMap[values.weekday],
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

export function dateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function isNexusSunday(year, month, day) {
  const anchor = Date.UTC(2026, 10, 8);
  const current = Date.UTC(year, month - 1, day);
  const days = Math.floor((current - anchor) / 86400000);
  return days >= 0 && days % 14 === 0;
}

export const SCHEDULED_EVENTS = [
  {
    key: "reset",
    label: "Reset",
    role: REMINDERS.reset.role,
    days: [0,1,2,3,4,5,6],
    winter: [7,0],
    summer: [8,0],
    text: "🔄 Reset reminder!"
  },
  {
    key: "morning",
    label: "Morning Conquest",
    role: REMINDERS.morning.role,
    days: [0,1,2,3,4,5,6],
    winter: [10,30],
    summer: [11,30],
    text: "🌅 Morning Conquest is starting now!"
  },
  {
    key: "night",
    label: "Night Conquest",
    role: REMINDERS.night.role,
    days: [0,1,2,3,4,5,6],
    winter: [18,30],
    summer: [20,30],
    text: "🌌 Night Conquest is starting now!"
  },
  {
    key: "opening",
    label: "Clash Opening Call",
    role: REMINDERS.opening.role,
    days: [1,3,5],
    winter: [9,0],
    summer: [10,0],
    text: "🔔 Clash Opening Call!"
  },
  {
    key: "battle",
    label: "Clash Battle Call",
    role: REMINDERS.battle.role,
    days: [1,3,5],
    winter: [15,0],
    summer: [16,0],
    text: "⚔️ Clash Battle Call!"
  },
  {
    key: "final",
    label: "Clash Final Call",
    role: REMINDERS.final.role,
    days: [1,3,5],
    winter: [20,30],
    summer: [21,30],
    text: "🚨 Clash Final Call!"
  },
  {
    key: "registration",
    label: "Guild Clash Registration",
    role: REMINDERS.registration.role,
    days: [0,2,4],
    winter: [8,30],
    summer: [9,30],
    text: "⏰ Guild Clash Registration is open!"
  },
  {
    key: "server_tournament_start",
    label: "Server Tournament",
    role: TOURNAMENTS.sever.role,
    days: [6],
    winter: [14,0],
    summer: [15,0],
    text: "⚔️ Server Tournament has started! The tournament battle is now underway. Keep an eye on the Live Event Board for voting rounds.",
    tournament: "sever",
    kind: "tournament_start"
  },
  {
    key: "nexus_tournament_start",
    label: "Nexus Tournament",
    role: TOURNAMENTS.nexus.role,
    days: [0],
    winter: [15,0],
    summer: [16,0],
    text: "🌀 Nexus Tournament has started! The tournament battle is now underway. Keep an eye on the Live Event Board for voting rounds.",
    tournament: "nexus",
    kind: "tournament_start",
    alternateSunday: true
  },
  {
    key: "chaos_tyrant_last_call",
    label: "Chaos Tyrant Last Call",
    role: REMINDERS.chaos_last_call.role,
    days: [0],
    winter: [20,0],
    summer: [21,0],
    text: "⏳ Chaos Tyrant: Last call! One hour remains before Chaos closes.",
    nonNexusSunday: true
  }
];

export function eventTimeForDate(event, y, m, d) {
  return isCentralDSTDate(y, m, d) ? event.summer : event.winter;
}

export function eventApplies(event, y, m, d, weekday) {
  if (!event.days.includes(weekday)) return false;
  if (event.alternateSunday && !isNexusSunday(y, m, d)) return false;
  if (event.nonNexusSunday && isNexusSunday(y, m, d)) return false;
  return true;
}

export function format12Hour(hour, minute) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function upcomingEvents(limit = 6) {
  const now = chicagoParts();
  const nowMinutes = now.hour * 60 + now.minute;
  const candidates = [];

  for (let offset = 0; offset <= 14; offset++) {
    const calendar = new Date(
      Date.UTC(now.year, now.month - 1, now.day + offset, 12)
    );

    const y = calendar.getUTCFullYear();
    const m = calendar.getUTCMonth() + 1;
    const d = calendar.getUTCDate();
    const weekday = calendar.getUTCDay();

    for (const event of SCHEDULED_EVENTS) {
      if (!eventApplies(event, y, m, d, weekday)) continue;

      const [hour, minute] = eventTimeForDate(event, y, m, d);
      const relativeMinutes =
        offset * 1440 +
        (hour * 60 + minute) -
        nowMinutes;

      if (relativeMinutes < 0) continue;

      candidates.push({
        ...event,
        y,
        m,
        d,
        weekday,
        hour,
        minute,
        offset,
        relativeMinutes
      });
    }
  }

  return candidates
    .sort((a, b) => a.relativeMinutes - b.relativeMinutes)
    .slice(0, limit);
}

export function eventDayLabel(event) {
  if (event.offset === 0) return "Today";
  if (event.offset === 1) return "Tomorrow";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(
    new Date(Date.UTC(event.y, event.m - 1, event.d, 12))
  );
}
