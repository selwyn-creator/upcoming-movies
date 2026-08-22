/**
 * Regenerates data.js from the live moviemeter.nl/bioscoop/binnenkort page.
 *
 * Why a headless browser at all: the HTML pages on moviemeter.nl sit behind
 * Cloudflare bot-protection that blocks plain HTTP requests (curl/fetch get a
 * 403). Their poster CDN and their official JSON API are NOT behind that
 * wall — a plain request works fine for those — so this script only uses
 * Playwright (real Chromium) for the two things that need it: reading the
 * "Aansprekende films" list, and, if you have no API key, reading each
 * film's plot off its detail page.
 *
 * Usage:
 *   npm install        (one-time; also downloads a Chromium build)
 *   npm run refresh     -> rewrites data.js in place
 *
 * If config.js has a MOVIEMETER_API_KEY set, that's used to fetch canonical
 * title/plot/date for each film instead of scraping its detail page (see
 * README.md for why the API can't discover *which* films to use by itself).
 */

const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { MOVIEMETER_API_KEY } = require("./config.js");

const LISTING_URL = "https://www.moviemeter.nl/bioscoop/binnenkort";
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const TOP_N = limitArg ? Number(limitArg.split("=")[1]) : 10;
const OUT_FILE = path.join(__dirname, "data.js");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MONTHS_NL = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function fetchJson(url) {
  return fetchBuffer(url).then((buf) => JSON.parse(buf.toString("utf8")));
}

function isoFromDutchDate(display) {
  if (!display) return "";
  const m = display.match(/(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/);
  if (!m) return "";
  const month = MONTHS_NL[m[2].toLowerCase()];
  if (!month) return "";
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function esc(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function getTopFilmIds(page) {
  await page.goto(LISTING_URL, { waitUntil: "domcontentloaded" });

  const extract = (selector) =>
    page.$$eval(selector, (as) => {
      const seen = new Set();
      const out = [];
      for (const a of as) {
        const m = a.getAttribute("href").match(/^\/film\/(\d+)$/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push(m[1]);
      }
      return out;
    });

  let ids = await extract('a.slMovie[href^="/film/"]');
  if (ids.length === 0) {
    console.warn('  (fallback: a.slMovie not found, using every /film/ link on the page)');
    ids = await extract('a[href^="/film/"]');
  }
  return ids.slice(0, TOP_N);
}

async function scrapeFilmDetail(page, id) {
  await page.goto(`https://www.moviemeter.nl/film/${id}`, { waitUntil: "networkidle" });
  return page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const title = h1 ? h1.textContent.trim() : document.title.replace(/\s*\(Film.*$/, "");

    const dateMatch = document.body.innerText.match(/Releasedatum:\s*([^\n]+)/);
    const releaseDateDisplay = dateMatch ? dateMatch[1].trim() : "";

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4"));
    const heading = headings.find((e) => /^plot\s/i.test(e.textContent.trim()));
    let plot = "";
    if (heading) {
      const container = (heading.closest(".blog-bar.long-desc") || heading.parentElement).cloneNode(true);
      container.querySelectorAll("script,style,h2,h3,h4").forEach((n) => n.remove());
      let text = container.innerText || container.textContent;
      const markers = ["Zoek naar deze film", "Externe links", "IMDb (", ".listTags", "Trailer (YouTube"];
      let cutIdx = text.length;
      for (const marker of markers) {
        const i = text.indexOf(marker);
        if (i > -1) cutIdx = Math.min(cutIdx, i);
      }
      text = text.slice(0, cutIdx);
      text = text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((l) => !/^\d+e in /i.test(l))
        .join(" ");
      plot = text.replace(/\s+/g, " ").trim();
    }
    return { title, releaseDateDisplay, plot };
  });
}

async function scrapeFilmDetailWithRetry(page, id, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const detail = await scrapeFilmDetail(page, id);
    if (!/you have been blocked|attention required|checking your browser/i.test(detail.title)) {
      return detail;
    }
    const wait = 4000 * attempt;
    console.warn(`\n  [${id}] rate-limited by Cloudflare, waiting ${wait}ms and retrying (${attempt}/${attempts})...`);
    await sleep(wait);
  }
  throw new Error(`Cloudflare kept blocking film ${id} after ${attempts} attempts — try again later, or set MOVIEMETER_API_KEY in config.js to skip scraping detail pages entirely.`);
}

function formatApiDate(raw) {
  const dateRaw = raw && (raw.date_cinema || raw.release_date || raw.date_cinema_nl);
  if (!dateRaw) return "";
  const d = new Date(dateRaw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
}

async function hydrateFromApi(id) {
  if (!MOVIEMETER_API_KEY) return null;
  try {
    const raw = await fetchJson(
      `https://www.moviemeter.nl/api/film/${id}?api_key=${encodeURIComponent(MOVIEMETER_API_KEY)}`
    );
    if (!raw || raw.message) return null; // e.g. {"message":"invalid api key provided"}
    return raw;
  } catch {
    return null;
  }
}

async function fetchPosterDataUri(id) {
  const prefix = Math.floor(id / 1000) * 1000;
  const candidates = [
    `https://www.moviemeter.nl/images/cover/${prefix}/${id}.jpg`,
    `https://www.moviemeter.nl/images/cover/${prefix}/${id}.300.jpg`,
    `https://www.moviemeter.nl/images/cover/${prefix}/${id}.200.jpg`,
  ];
  for (const url of candidates) {
    try {
      const buf = await fetchBuffer(url);
      if (buf.length > 500) return `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch {
      // try the next size
    }
  }
  throw new Error(`No poster image found for film ${id}`);
}

function writeDataJs(movies) {
  const lines = [
    "/**",
    " * Seed data: top 10 upcoming cinema releases from moviemeter.nl/bioscoop/binnenkort,",
    " * ordered by nearest release date.",
    " *",
    " * Generated by refresh.js — do not hand-edit the poster data URIs or this whole",
    " * file gets overwritten anyway next time someone runs `npm run refresh`.",
    " *",
    ` * Last refreshed: ${new Date().toISOString().slice(0, 10)}`,
    " */",
    "const SEED_MOVIES = [",
  ];
  for (const m of movies) {
    lines.push("  {");
    lines.push(`    id: ${m.id},`);
    lines.push(`    title: "${esc(m.title)}",`);
    lines.push(`    releaseDate: "${esc(m.releaseDate)}",`);
    lines.push(`    releaseDateDisplay: "${esc(m.releaseDateDisplay)}",`);
    lines.push(`    poster: "${m.poster}",`);
    lines.push(`    plot: "${esc(m.plot)}",`);
    lines.push(`    url: "${esc(m.url)}"`);
    lines.push("  },");
  }
  lines.push("];");
  fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Using ${MOVIEMETER_API_KEY ? "the MovieMeter API" : "scraped detail pages"} for title/plot/date.`);
  console.log("Launching headless browser...");
  // moviemeter.nl sits behind Cloudflare bot-detection, which flags the default
  // headless fingerprint (navigator.webdriver, missing plugins, etc.) and rapid-fire
  // page loads. --disable-blink-features plus a real UA/locale/viewport and a short
  // delay between page loads (below) keeps this looking like a normal visitor.
  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  const page = await browser.newPage({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam",
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  console.log(`Reading ${LISTING_URL} ...`);
  const ids = await getTopFilmIds(page);
  if (ids.length === 0) {
    throw new Error("Found zero films — moviemeter.nl's markup probably changed; open the page and check the a.slMovie selector in getTopFilmIds().");
  }
  console.log(`Found ${ids.length} films: ${ids.join(", ")}`);

  const movies = [];
  for (const [index, id] of ids.entries()) {
    process.stdout.write(`  [${id}] `);

    // The API (unlike the HTML pages) isn't behind Cloudflare's bot-wall, so if it
    // gives us everything we need, skip the fragile detail-page scrape entirely —
    // that's both faster and a lot less likely to get rate-limited.
    const apiData = await hydrateFromApi(id);
    const poster = await fetchPosterDataUri(Number(id));
    const apiDateDisplay = formatApiDate(apiData);
    let detail = { title: "", releaseDateDisplay: "", plot: "" };
    if (!apiData || !apiData.title || !apiData.plot || !apiDateDisplay) {
      if (index > 0) await sleep(2500 + Math.random() * 2000); // stay well under Cloudflare's rate radar
      detail = await scrapeFilmDetailWithRetry(page, id);
    }

    const title = (apiData && apiData.title) || detail.title;
    const plot = (apiData && apiData.plot) || detail.plot;
    const url = (apiData && apiData.url) || `https://www.moviemeter.nl/film/${id}`;
    const releaseDateDisplay = apiDateDisplay || detail.releaseDateDisplay;

    movies.push({
      id: Number(id),
      title,
      releaseDate: isoFromDutchDate(releaseDateDisplay),
      releaseDateDisplay,
      poster,
      plot,
      url,
    });
    console.log(title);
  }

  await browser.close();

  movies.sort((a, b) => (a.releaseDate || "9999").localeCompare(b.releaseDate || "9999"));
  writeDataJs(movies);
  console.log(`\nWrote ${movies.length} films to data.js`);
}

main().catch((err) => {
  console.error("\nRefresh failed:", err.message);
  process.exit(1);
});
