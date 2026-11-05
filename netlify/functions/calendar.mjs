import { loadData } from "./data.mjs";

const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (l) => { const out = []; while (l.length > 70) { out.push(l.slice(0, 70)); l = " " + l.slice(70); } out.push(l); return out.join("\r\n"); };
const p2 = (n) => String(n).padStart(2, "0");
// Lokale (Belgische) tijd zonder zone-omrekening; de zone wordt apart meegegeven via TZID.
const stamp = (d, t, addH = 0) => {
  const [y, m, dd] = d.split("-").map(Number), [hh, mm] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd, hh + addH, mm));
  return `${x.getUTCFullYear()}${p2(x.getUTCMonth() + 1)}${p2(x.getUTCDate())}T${p2(x.getUTCHours())}${p2(x.getUTCMinutes())}00`;
};

const TZ = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Brussels",
  "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "END:VTIMEZONE",
];

function event(m, team, now) {
  const l = ["BEGIN:VEVENT", `UID:${m.id || m.date + "-" + m.home}-${team}@vms-pingpong`, `DTSTAMP:${now}`];
  if (m.time) l.push(`DTSTART;TZID=Europe/Brussels:${stamp(m.date, m.time)}`, `DTEND;TZID=Europe/Brussels:${stamp(m.date, m.time, 3)}`);
  else l.push(`DTSTART;VALUE=DATE:${m.date.replace(/-/g, "")}`);
  const score = m.ours != null ? ` (${m.ours}-${m.theirs})` : "";
  l.push(`SUMMARY:${esc(`${m.home} vs ${m.away}${score}`)}`);
  if (m.venue) l.push(`LOCATION:${esc([m.venue.name, m.venue.address].filter(Boolean).join(", "))}`);
  l.push(`DESCRIPTION:${esc(`Ploeg ${team}` + (m.week ? ` - speeldag ${m.week}` : ""))}`, "END:VEVENT");
  return l;
}

export default async (req, context) => {
  try {
    const key = String(context.params.file || "").replace(/\.ics$/i, "").toUpperCase();
    const data = await loadData();
    const teams = key === "ALLE" ? data.teams : data.teams.filter((t) => t.team === key);
    if (!teams.length) return new Response("Onbekende ploeg", { status: 404 });
    const now = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//VMS pingpong//NL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      `X-WR-CALNAME:${esc(key === "ALLE" ? data.club + " - alle ploegen" : `${data.club} ${key}`)}`, "X-WR-TIMEZONE:Europe/Brussels",
      "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H", ...TZ];
    for (const t of teams) for (const m of t.matches) if (m.date) lines.push(...event(m, t.team, now));
    lines.push("END:VCALENDAR");
    return new Response(lines.map(fold).join("\r\n") + "\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8", "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (e) {
    return new Response(String((e && e.message) || e), { status: 502 });
  }
};

export const config = { path: "/api/kalender/:file" };
