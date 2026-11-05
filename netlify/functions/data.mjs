import soap from "soap";

// Instellingen (aan te passen via Netlify > Site configuration > Environment variables)
const WSDL = process.env.TABT_WSDL || "http://api.vttl.be/0.7/?wsdl";
const CLUB_NAME = (process.env.CLUB_NAME || "pellenberg").toLowerCase();

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
  // Zonder filter en per provincie (1-5) zoeken, want de API filtert soms op ClubCategory.
  const lists = await Promise.all([undefined, 1, 2, 3, 4, 5].map((c) =>
    call(client, "GetClubs", c ? { Season: season, ClubCategory: c } : { Season: season })
      .then((r) => arr(r.ClubEntries), () => [])));
  const all = new Map();
  for (const c of lists.flat()) all.set(String(c.UniqueIndex), c);
  const norm = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hits = [...all.values()].filter((c) => norm(JSON.stringify(c)).includes(norm(CLUB_NAME)));
  if (!hits.length) {
    const sample = [...all.values()].slice(0, 5).map((c) => c.Name || JSON.stringify(c)).join(" | ");
    throw new Error(`Geen club gevonden met "${CLUB_NAME}" (${all.size} clubs opgehaald, bv. ${sample}). Stel CLUB_ID of CLUB_NAME in.`);
  }
  const c = hits.find((h) => /vmc/i.test(JSON.stringify(h))) || hits[0];
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

export default async (req) => {
  try {
    const debug = new URL(req.url).searchParams.has("debug");
    const client = await soap.createClientAsync(WSDL);
    const season = (await call(client, "GetSeasons", {})).CurrentSeason;
    const club = await findClub(client, season);
    const r = await call(client, "GetMatches", { Club: club.id, Season: season, WithDetails: true });
    const entries = arr(r.TeamMatchEntries);
    if (debug) {
      const t = await call(client, "GetClubTeams", { Club: club.id, Season: season });
      return json({ club, season, keys: Object.keys(r), count: entries.length, first: entries[0] || null, teamEntries: arr(t.TeamEntries) });
    }
    if (!entries.length) throw new Error(`Geen ontmoetingen gevonden voor club ${club.id} in seizoen ${season}. Open /api/data?debug=1 voor details.`);
    const byTeam = new Map();
    for (const e of entries) {
      const full = String(String(e.HomeClub) === String(club.id) ? e.HomeTeam : e.AwayTeam || "");
      const key = (full.match(/\s([A-Z])$/) || [])[1] || full;
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push(shape(e, club.id));
    }
    const teams = [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([team, list]) => {
      const matches = list.sort((a, b) => a.date.localeCompare(b.date));
      return { team, matches, players: stats(matches) };
    });
    // Een uur gecachet op het Netlify-CDN: weinig functie-aanroepen, dus binnen het gratis plan.
    return json({ club: club.name, updated: new Date().toISOString(), teams }, 200, {
      "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
};

export const config = { path: "/api/data" };
