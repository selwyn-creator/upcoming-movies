/**
 * Thin client for the official MovieMeter REST API.
 *
 * The API only exposes three methods — none of them a "coming soon" list:
 *   GET /api/film/{moviemeter_id}?api_key=KEY
 *   GET /api/film/{imdb_code}?api_key=KEY
 *   GET /api/film/?q={search}&api_key=KEY
 * (https://wiki.moviemeter.nl/index.php/API)
 *
 * So the *selection* of which 10 films to show lives in data.js (SEED_MOVIES).
 * This module only hydrates each seeded film with live data from the API.
 *
 * The API sends no Access-Control-Allow-Origin header, so a plain browser
 * fetch() is blocked by CORS. It supports a `callback` param for exactly
 * this situation (JSONP), which is what we use here.
 *
 * NOTE: the exact response field names below (title/plot/date/poster) are
 * MovieMeter's documented convention but weren't verified against a live
 * key while building this. If your key is set and cards still fall back to
 * demo data, open devtools → Network on this page, inspect one response,
 * and adjust the field lookups in `normalize()` to match.
 */

const MovieMeterAPI = (() => {
  const BASE = "https://www.moviemeter.nl/api/film/";
  let callbackCounter = 0;

  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cbName = `__mm_cb_${Date.now()}_${callbackCounter++}`;
      const script = document.createElement("script");
      const cleanup = () => {
        delete window[cbName];
        script.remove();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("MovieMeter API timed out"));
      }, 6000);

      window[cbName] = (data) => {
        clearTimeout(timeout);
        cleanup();
        resolve(data);
      };

      script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${cbName}`;
      script.onerror = () => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error("MovieMeter API request failed"));
      };
      document.head.appendChild(script);
    });
  }

  function firstOf(obj, keys) {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
    }
    return undefined;
  }

  function normalize(raw, seed) {
    if (!raw || raw.message) return seed; // e.g. {"message":"invalid api key provided"}

    const plot = firstOf(raw, ["plot", "synopsis", "description"]);
    const title = firstOf(raw, ["title", "display_title", "original_title"]);
    const url = firstOf(raw, ["url"]);
    const dateRaw = firstOf(raw, ["date_cinema", "release_date", "date_cinema_nl"]);

    let poster = seed.poster;
    if (raw.images) {
      const posterObj = Array.isArray(raw.images) ? raw.images[0] : raw.images;
      const found = firstOf(posterObj, ["poster", "image", "large", "medium", "small", "thumb"]);
      if (typeof found === "string") poster = found;
    }

    return {
      ...seed,
      title: title || seed.title,
      plot: plot || seed.plot,
      url: url || seed.url,
      poster,
      releaseDateDisplay: dateRaw
        ? new Date(dateRaw).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })
        : seed.releaseDateDisplay,
    };
  }

  async function hydrate(seedMovies, apiKey) {
    if (!apiKey) return seedMovies;

    const results = await Promise.all(
      seedMovies.map(async (seed) => {
        try {
          const raw = await jsonp(`${BASE}${seed.id}?api_key=${encodeURIComponent(apiKey)}`);
          return normalize(raw, seed);
        } catch (err) {
          console.warn(`MovieMeter API: falling back to seed data for "${seed.title}"`, err);
          return seed;
        }
      })
    );
    return results;
  }

  return { hydrate };
})();
