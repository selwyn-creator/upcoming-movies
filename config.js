/**
 * Get a free API key at https://www.moviemeter.nl/site/registerclient
 * (free for non-commercial use, provided you link back to MovieMeter).
 * Paste it below to hydrate live title/plot/poster data on top of the
 * seed list in data.js. Leave empty to run entirely on the seed data.
 */
const MOVIEMETER_API_KEY = "";

// Also usable from refresh.js (Node) without duplicating the key.
if (typeof module !== "undefined") module.exports = { MOVIEMETER_API_KEY };
