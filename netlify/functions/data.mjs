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
  if (process.env.CLUB_ID) return { id: process.env.CLUB_ID, name: process.env.CLUB_ID, clubs: new Map() };
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
  return { id: c.UniqueIndex, name: c.LongName || c.Name, clubs: all };
}

function venueOf(e, clubs) {
  let v = e.VenueEntry || (e.Venue && typeof e.Venue === "object" ? e.Venue : null);
  if (!v) {
    const c = clubs.get(String(e.HomeClub));
    const list = arr(c && (c.VenueEntries || c.Venues));
    v = list.find((x) => String(x.ClubVenue ?? x.Id) === String(e.Venue)) || list[0];
  }
  if (!v) return null;
  const address = [v.Street, v.Town].filter(Boolean).join(", ");
  return address ? { name: v.Name || "", address } : null;
}

function shape(e, clubId, clubs) {
  const home = String(e.HomeClub) === String(clubId);
  const score = /^\d+\s*-\s*\d+$/.test(e.Score || "") ? e.Score.split("-").map(Number) : [null, null];
  const out = {
    id: e.MatchId, week: e.WeekName, date: day(e.Date), time: String(e.Time || "").slice(0, 5),
    home: e.HomeTeam, away: e.AwayTeam, isHome: home,
    ours: home ? score[0] : score[1], theirs: home ? score[1] : score[0], games: [],
  };
  out.venue = venueOf(e, clubs);
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

const num = (v) => (v == null || v === "" ? null : Number(v));
function rankRow(x) {
  const t = x.Team;
  return {
    pos: num(x.Position), team: t && typeof t === "object" ? String(t.Name || t.Team || "") : String(t || ""),
    played: num(x.GamesPlayed), won: num(x.GamesWon), lost: num(x.GamesLost), draw: num(x.GamesDraw),
    mw: num(x.IndividualMatchesWon), ml: num(x.IndividualMatchesLost),
    sw: num(x.IndividualSetsWon), sl: num(x.IndividualSetsLost), points: num(x.Points),
  };
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export async function loadData(debug = false) {
  const client = await soap.createClientAsync(WSDL);
  const season = Number((await call(client, "GetSeasons", {})).CurrentSeason);
  const club = await findClub(client, season);
  const [r, mem, prev, ct] = await Promise.all([
    call(client, "GetMatches", { Club: club.id, Season: season, WithDetails: true }),
    call(client, "GetMembers", { Club: club.id, Season: season }).catch((e) => ({ error: String(e.message || e) })),
    call(client, "GetMatches", { Club: club.id, Season: season - 1 }).catch(() => ({})),
    call(client, "GetClubTeams", { Club: club.id, Season: season }).catch(() => ({})),
  ]);
  const entries = arr(r.TeamMatchesEntries || r.TeamMatchEntries);
  const members = arr(mem.MemberEntries || mem.MembersEntries).map((m) => person(m));
  const te = arr(ct.TeamEntries);
  if (debug) {
    const f = te.find((x) => x.Team);
    const rr = f ? await call(client, "GetDivisionRanking", { DivisionId: f.DivisionId, Season: season }).catch((e) => ({ error: String(e.message || e) })) : {};
    return { rankingKeys: Object.keys(rr), rankingFirst: arr(rr.RankingEntries)[0] || null, rankingError: rr.error,
      club: { id: club.id, name: club.name }, season, count: entries.length, first: entries[0] || null, teamEntries: te,
      prevCount: arr(prev.TeamMatchesEntries || prev.TeamMatchEntries).length,
      membersKeys: Object.keys(mem), membersCount: members.length, membersSample: members.slice(0, 3), membersError: mem.error };
  }
  if (!entries.length) throw new Error(`Geen ontmoetingen gevonden voor club ${club.id} in seizoen ${season}. Open /api/data?debug=1 voor details.`);
  const mine = (e) => String(e.HomeClub) === String(club.id);
  const byTeam = new Map();
  for (const e of entries) {
    const opp = String(mine(e) ? e.AwayTeam : e.HomeTeam || "");
    if (/^vrij\b/i.test(opp.trim())) continue; // vrije speeldag, geen echte ontmoeting
    const full = String(mine(e) ? e.HomeTeam : e.AwayTeam || "");
    const key = (full.match(/\s([A-Z])$/) || [])[1];
    if (!key) continue; // bekerploeg (zonder letter) overslaan
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(shape(e, club.id, club.clubs));
  }
  const teams = [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([team, list]) => ({ team, matches: list.sort((a, b) => a.date.localeCompare(b.date)) }));
  await Promise.all(teams.map(async (t) => {
    const e = te.find((x) => x.Team === t.team);
    if (!e) return;
    t.division = e.DivisionName;
    try {
      const rr = await call(client, "GetDivisionRanking", { DivisionId: e.DivisionId, Season: season });
      t.ranking = arr(rr.RankingEntries).map(rankRow).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
      if (!t.ranking.length) t.rankingError = `Geen rangschikking ontvangen (velden: ${Object.keys(rr).join(", ")})`;
    } catch (err) { t.rankingError = String((err && err.message) || err); }
  }));
  // Uitslagen van vorig seizoen, voor "eerder tegen deze tegenstander"
  const history = [];
  for (const e of arr(prev.TeamMatchesEntries || prev.TeamMatchEntries)) {
    const opp = String(mine(e) ? e.AwayTeam : e.HomeTeam || "").trim();
    const sc = /^\d+\s*-\s*\d+$/.test(e.Score || "") ? e.Score.split("-").map(Number) : null;
    if (!sc || /^vrij\b/i.test(opp)) continue;
    history.push({ date: day(e.Date), opp, isHome: mine(e), ours: mine(e) ? sc[0] : sc[1], theirs: mine(e) ? sc[1] : sc[0] });
  }
  return { club: club.name, season, updated: new Date().toISOString(), teams, members, history };
}

export default async (req) => {
  try {
    const debug = new URL(req.url).searchParams.has("debug");
    const body = await loadData(debug);
    // Een uur gecachet op het Netlify-CDN: weinig functie-aanroepen, dus binnen het gratis plan.
    return json(body, 200, debug ? {} : { "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
};

export const config = { path: "/api/data" };
