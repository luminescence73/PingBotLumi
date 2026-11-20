import { markEventSent, wasEventSent } from "../runtime/database.js";
import { SCHEDULED_EVENTS, chicagoParts, dateKey, eventApplies, eventTimeForDate } from "./schedule.js";
import {
  closeTournamentVote,
  getActiveTournamentState,
  startTournamentEvent,
  updateEventBoard
} from "./tournaments.js";
import { sendLocalizedRoleNotification } from "./notifications.js";
import {
  auditMissedScheduledPings,
  maybeSendStaffDailyPingSummary,
  recordStaffPingAudit,
  updateStaffPingDashboard
} from "./pingLog.js";

let schedulerRunning = false;

async function processScheduledEvent(event, parts) {
  const persistentKey = `${dateKey(parts)}:${event.key}`;
  if (await wasEventSent(persistentKey)) return;

  if (event.kind === "tournament_start") {
    await startTournamentEvent(
      event.tournament,
      event.text,
      event.label
    );
  } else {
    await sendLocalizedRoleNotification(
      event.role,
      event.text,
      event.label
    );
  }

  await markEventSent(persistentKey);
}

async function checkSchedule() {
  if (schedulerRunning) return;
  schedulerRunning = true;

  try {
    const now = chicagoParts();
    const currentMinutes = now.hour * 60 + now.minute;

    for (const event of SCHEDULED_EVENTS) {
      if (!eventApplies(event, now.year, now.month, now.day, now.weekday)) continue;
      const [hour, minute] = eventTimeForDate(event, now.year, now.month, now.day);
      const late = currentMinutes - (hour * 60 + minute);
      if (late < 0 || late > 3) continue;
      try {
        await processScheduledEvent(event, now);
      } catch (error) {
        console.error(`❌ Scheduled event error (${event.key}):`, error);
        await recordStaffPingAudit({kind:"failure",title:event.label,
          detail:"Scheduled event failed: "+error.message,
          eventKey:dateKey(now)+":"+event.key}).catch(console.error);
      }
    }

    const active = await getActiveTournamentState();
    if (active?.phase === "voting" && active.vote_ends_at && new Date(active.vote_ends_at).getTime() <= Date.now()) {
      await closeTournamentVote(active);
    }
  } finally {
    schedulerRunning = false;
  }
}

export function startScheduler() {
  console.log("✅ Persistent DST-aware scheduler active.");
  const tick = () => void checkSchedule().catch(error => console.error("❌ Scheduler tick:", error));
  tick();
  setInterval(tick, 20_000);
  setInterval(() => void updateEventBoard().catch(console.error), 60_000);
  setInterval(() => void updateStaffPingDashboard().catch(console.error), 60_000);
  setInterval(() => void auditMissedScheduledPings().catch(console.error), 60_000);
  setInterval(() => void maybeSendStaffDailyPingSummary().catch(console.error), 60_000);
  void auditMissedScheduledPings().catch(console.error);
  void maybeSendStaffDailyPingSummary().catch(console.error);
}
