/**
 * Ingests heroes + costumes from the Marvel Rivals Fandom wiki.
 *
 * This is the primary ingest path: no API key, no rate-limit tier, and the
 * `{{Costume page}}` infobox carries hero, rarity, in-game id and icon as
 * structured fields. scripts/ingest.ts remains as an alternative source.
 *
 *   npm run ingest:wiki -- --dry     inspect, write nothing
 *   npm run ingest:wiki -- --limit 50
 *
 * Card ids are the in-game costume ids from the infobox, so re-running is
 * idempotent and cards keep their identity across ingests.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { normaliseRarity, slug } from "../src/lib/rarity.js";

const API = "https://marvelrivals.fandom.com/api.php";
const UA = "GachaMRBot/0.1 (Discord gacha bot; contact via repo)";
const DRY = process.argv.includes("--dry");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

async function mw(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, format: "json" });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?${qs}`, { headers: { "user-agent": UA } });
    if (res.ok) return res.json();
    // Fandom throttles bursts; back off rather than hammering it.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`MediaWiki ${res.status} ${res.statusText}`);
  }
  throw new Error("MediaWiki request failed after retries");
}

/** Walks Category:Costumes. Subpages like "Costumes/Select Intros" aren't cards. */
async function listCostumeTitles(): Promise<string[]> {
  const titles: string[] = [];
  let cont: string | undefined;
  do {
    const j = await mw({
      action: "query",
      list: "categorymembers",
      cmtitle: "Category:Costumes",
      cmlimit: "500",
      cmnamespace: "0",
      ...(cont ? { cmcontinue: cont } : {}),
    });
    for (const m of j.query?.categorymembers ?? []) {
      if (!m.title.includes("/")) titles.push(m.title);
    }
    cont = j.continue?.cmcontinue;
    process.stdout.write(`\r  discovered ${titles.length} costume pages…`);
  } while (cont && titles.length < LIMIT);
  process.stdout.write("\n");
  return titles.slice(0, LIMIT);
}

/**
 * Splits template parameters on top-level pipes only — infobox values contain
 * [[links]] and {{templates}} that carry their own pipes.
 */
function splitParams(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") {
      depth++;
      buf += two;
      i++;
      continue;
    }
    if (two === "}}" || two === "]]") {
      depth--;
      buf += two;
      i++;
      continue;
    }
    if (body[i] === "|" && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += body[i];
  }
  out.push(buf);
  return out;
}

function parseCostumeInfobox(wikitext: string): Record<string, string> | null {
  const start = wikitext.indexOf("{{Costume page");
  if (start === -1) return null;

  // Find the matching close brace for this template.
  let depth = 0;
  let end = -1;
  for (let i = start; i < wikitext.length; i++) {
    if (wikitext.slice(i, i + 2) === "{{") { depth++; i++; continue; }
    if (wikitext.slice(i, i + 2) === "}}") {
      depth--;
      i++;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;

  const body = wikitext.slice(start + 2, end - 2);
  const fields: Record<string, string> = {};
  for (const part of splitParams(body).slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return fields;
}

async function fetchWikitext(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const j = await mw({
      action: "query",
      titles: batch.join("|"),
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
    });
    for (const p of Object.values<any>(j.query?.pages ?? {})) {
      const content = p.revisions?.[0]?.slots?.main?.["*"];
      if (content) out.set(p.title, content);
    }
    process.stdout.write(`\r  fetched ${out.size}/${titles.length} pages…`);
  }
  process.stdout.write("\n");
  return out;
}

/** Resolves "Foo Icon.png" to a real CDN URL. */
async function resolveImages(files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(files.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50).map((f) => `File:${f}`);
    const j = await mw({
      action: "query",
      titles: batch.join("|"),
      prop: "imageinfo",
      iiprop: "url",
    });
    for (const p of Object.values<any>(j.query?.pages ?? {})) {
      const url = p.imageinfo?.[0]?.url;
      if (url) out.set(String(p.title).replace(/^File:/, ""), url);
    }
    process.stdout.write(`\r  resolved ${out.size}/${unique.length} images…`);
  }
  process.stdout.write("\n");
  return out;
}

/**
 * Role values sometimes carry an inline role icon, e.g.
 * `[[File:Strategist Icon.png|20px]]Strategist`. Strip file links and any
 * leftover size token so we store "Strategist", not "20pxStrategist".
 */
function cleanRole(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\[\[\s*File:[^\]]*\]\]/gi, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\[|\]\]/g, "")
    .split("|")
    .pop()!
    .replace(/^\s*\d+px\s*/i, "")
    // Deadpool is genuinely listed as all three roles; keep them all, readably.
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\s*\/\s*/g, " / ")
    .trim();
  return cleaned || null;
}

/**
 * Roles come from each hero page's {{Infobox Character}} `role` field rather
 * than the Vanguards/Duelists/Strategists categories — those categories
 * double-list some heroes (Deadpool sits in two), so they can't give one role.
 */
async function fetchHeroMeta(
  names: string[],
): Promise<Map<string, { role: string | null; icon: string | null }>> {
  const out = new Map<string, { role: string | null; icon: string | null }>();
  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    const j = await mw({
      action: "query",
      titles: batch.join("|"),
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
    });
    for (const p of Object.values<any>(j.query?.pages ?? {})) {
      const text: string | undefined = p.revisions?.[0]?.slots?.main?.["*"];
      if (!text) continue;
      const role = text.match(/^\|\s*role\s*=\s*(.+)$/im)?.[1];
      const icon = text.match(/^\|\s*image\s*=\s*(.+\.png)\s*$/im)?.[1];
      out.set(p.title, { role: cleanRole(role), icon: icon?.trim() ?? null });
    }
    process.stdout.write(`\r  fetched ${out.size}/${names.length} hero pages…`);
  }
  process.stdout.write("\n");
  return out;
}

async function main() {
  console.log("Listing costume pages…");
  const titles = await listCostumeTitles();

  console.log("Fetching wikitext…");
  const pages = await fetchWikitext(titles);

  const parsed: {
    id: string; name: string; hero: string; rarity: string; icon: string;
  }[] = [];
  const skipped = { noInfobox: 0, noHero: 0, noId: 0, badRarity: new Map<string, number>() };

  for (const [title, text] of pages) {
    const f = parseCostumeInfobox(text);
    if (!f) { skipped.noInfobox++; continue; }

    const hero = f["hero"]?.replace(/\[\[|\]\]/g, "").split("|").pop()?.trim();
    if (!hero) { skipped.noHero++; continue; }

    const id = f["id"]?.match(/\d+/)?.[0];
    if (!id) { skipped.noId++; continue; }

    const r = normaliseRarity(f["rarity"]);
    if (!r) {
      const k = f["rarity"] ?? "<missing>";
      skipped.badRarity.set(k, (skipped.badRarity.get(k) ?? 0) + 1);
      continue;
    }

    parsed.push({
      id,
      name: (f["name"] || title).trim(),
      hero,
      rarity: r,
      icon: f["icon"] ?? "",
    });
  }

  console.log(`\nParsed ${parsed.length} costumes from ${pages.size} pages`);
  if (skipped.noInfobox) console.log(`  skipped ${skipped.noInfobox} without a Costume page infobox`);
  if (skipped.noHero) console.log(`  skipped ${skipped.noHero} without a hero field`);
  if (skipped.noId) console.log(`  skipped ${skipped.noId} without an id`);
  for (const [k, n] of skipped.badRarity) console.log(`  skipped rarity "${k}" ×${n}`);

  const heroMap = new Map<string, string>();
  for (const p of parsed) heroMap.set(slug(p.hero), p.hero);

  console.log("Fetching hero roles…");
  const heroMeta = await fetchHeroMeta([...heroMap.values()]);

  console.log("Resolving image URLs…");
  const images = await resolveImages([
    ...parsed.map((p) => p.icon),
    ...[...heroMeta.values()].map((m) => m.icon ?? ""),
  ]);

  const heroRows = [...heroMap].map(([id, name]) => {
    const meta = heroMeta.get(name);
    return {
      id,
      name,
      role: meta?.role ?? null,
      imageUrl: meta?.icon ? (images.get(meta.icon) ?? null) : null,
    };
  });

  const missingRole = heroRows.filter((h) => !h.role);
  if (missingRole.length) {
    console.log(
      `  ${missingRole.length} hero(es) without a role: ${missingRole.map((h) => h.name).join(", ")}`,
    );
  }

  /**
   * Card id is hero-scoped, not the bare costume id: the wiki reuses a single
   * id across heroes for cross-hero bundles (e.g. 1048501 is both Psylocke's
   * and Magik's Retro X-Uniform). Keying on the raw id drops those cards.
   */
  const seen = new Map<string, (typeof parsed)[number]>();
  let exactDupes = 0;
  for (const p of parsed) {
    const key = `${slug(p.hero)}:${p.id}`;
    if (seen.has(key)) { exactDupes++; continue; }
    seen.set(key, p);
  }
  if (exactDupes) console.log(`  collapsed ${exactDupes} duplicate page(s) for the same hero+costume`);

  const cardRows = [...seen].map(([id, p]) => ({
    id,
    heroId: slug(p.hero),
    name: p.name,
    rarity: p.rarity as any,
    imageUrl: images.get(p.icon) ?? null,
  }));

  // Base skins are deliberately NOT cards. The wiki has no articles for them,
  // so any Default tier would be invented rather than sourced — the pool is
  // exactly what the wiki documents: Rare, Epic and Legendary costumes.

  const byRarity = cardRows.reduce<Record<string, number>>((a, c) => {
    a[c.rarity] = (a[c.rarity] ?? 0) + 1;
    return a;
  }, {});
  console.log(`\n${heroRows.length} heroes, ${cardRows.length} cards`);
  console.log("pool by rarity:", byRarity);
  console.log(`cards with images: ${cardRows.filter((c) => c.imageUrl).length}/${cardRows.length}`);

  if (DRY) {
    console.log("\nSample:");
    console.dir(cardRows.slice(0, 3), { depth: null });
    console.log("\n--dry: nothing written.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    await tx.insert(schema.heroes).values(heroRows).onConflictDoUpdate({
      target: schema.heroes.id,
      set: {
        name: sql`excluded.name`,
        role: sql`excluded.role`,
        imageUrl: sql`excluded.image_url`,
      },
    });
    for (let i = 0; i < cardRows.length; i += 500) {
      await tx.insert(schema.cards).values(cardRows.slice(i, i + 500)).onConflictDoUpdate({
        target: schema.cards.id,
        set: {
          name: sql`excluded.name`,
          rarity: sql`excluded.rarity`,
          imageUrl: sql`excluded.image_url`,
          heroId: sql`excluded.hero_id`,
        },
      });
    }
  });

  console.log("\nDone. Cards are live.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
