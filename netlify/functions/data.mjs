import soap from "soap";

// Instellingen (aan te passen via Netlify > Site configuration > Environment variables)
const WSDL = process.env.TABT_WSDL || "http://api.vttl.be/0.7/?wsdl";
const CLUB_NAME = (process.env.CLUB_NAME || "pellenberg").toLowerCase();
const TEAMS = (process.env.TEAMS || "A,B,C").split(",").map((t) => t.trim());

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const call = async (client, method, args) => (await client[method + "Async"](args))[0];
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || "").slice(0, 10));
const person = (p) => ({
  id: String(p.UniqueIndex),
  name: `${p.FirstName || ""} ${p.LastName || ""}`.trim(),
  rank: p.Ranking || "?",
});

async function findClub(client, season) {
  if (process.env.CLUB_ID) return { id: process.env.CLUB_ID, name: process.env.CLUB_ID };
  const r = await call(client, "GetClubs", { Season: season });
  const hits = arr(r.ClubEntries).filter((c) => `${c.Name} ${c.LongName}`.toLowerCase().includes(CLUB_NAME));
  if (!hits.length) throw new Error(`Geen club gevonden met "${CLUB_NAME}". Stel CLUB_ID of CLUB_NAME in.`);
  const c = hits.find((h) => /vmc/i.test(`${h.Name} ${h.LongName}`)) || hits[0];
  return { id: c.UniqueIndex, name: c.LongName || c.Name };
}

function shape(e, clubId) {
  const home = String(e.HomeClub) === String(clubId);
  const score = /^\d+\s*-\s*\d+$/.test(e.Score || "") ? e.Score.split("-").map(Number) : [null, null];
  const out = {
    id: e.MatchId, week: e.WeekName, date: day(e.Date), time: String(e.Time || "").slice(0, 5),
    home: e.HomeTeam, away: e.AwayTeam, isHome: home,
    ours: home ? score[0] : score[1], theirs: home ? score[1] : score[0], games: [],
  };
  const d = e.MatchDetails;
  if (d && d.DetailsCreated !== false) {
    const idx = (side) => new Map(arr(side && side.Players).map((p) => [String(p.UniqueIndex), person(p)]));
    const H = idx(d.HomePlayers), A = idx(d.AwayPlayers);
    for (const r of arr(d.IndividualMatchResults)) {
      const hs = Number(r.HomeSetCount), as = Number(r.AwaySetCount);
      if (Number.isNaN(hs) || Number.isNaN(as)) continue;
      const hp = arr(r.HomePlayerUniqueIndex).map((i) => H.get(String(i))).filter(Boolean);
      const ap = arr(r.AwayPlayerUniqueIndex).map((i) => A.get(String(i))).filter(Boolean);
      out.games.push({
        ours: home ? hp : ap, theirs: home ? ap : hp,
        os: home ? hs : as, ts: home ? as : hs,
        forfeit: !!(r.IsHomeForfeited || r.IsAwayForfeited),
      });
    }
  }
  return out;
}

function stats(matches) {
  const s = new Map();
  for (const m of matches) for (const g of m.games) {
    if (g.forfeit || g.os === g.ts) continue;
    const won = g.os > g.ts, dbl = g.ours.length > 1;
    for (const p of g.ours) {
      const e = s.get(p.id) || { ...p, single: [0, 0], double: [0, 0], vs: {} };
      e[dbl ? "double" : "single"][won ? 0 : 1]++;
      if (!dbl) { const k = (g.theirs[0] && g.theirs[0].rank) || "?"; (e.vs[k] ||= [0, 0])[won ? 0 : 1]++; }
      s.set(p.id, e);
    }
  }
  return [...s.values()].sort((a, b) => b.single[0] - a.single[0] || a.single[1] - b.single[1]);
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export default async () => {
  try {
    const client = await soap.createClientAsync(WSDL);
    const season = (await call(client, "GetSeasons", {})).CurrentSeason;
    const club = await findClub(client, season);
    const teams = await Promise.all(TEAMS.map(async (team) => {
      const r = await call(client, "GetMatches", { Club: club.id, Team: team, Season: season, WithDetails: true });
      const matches = arr(r.TeamMatchEntries).map((e) => shape(e, club.id))
        .sort((a, b) => a.date.localeCompare(b.date));
      return { team, matches, players: stats(matches) };
    }));
    // Een uur gecachet op het Netlify-CDN: weinig functie-aanroepen, dus binnen het gratis plan.
    return json({ club: club.name, updated: new Date().toISOString(), teams }, 200, {
      "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
};

export const config = { path: "/api/data" };
