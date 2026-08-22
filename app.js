/**
 * Screensaver cycling engine — cycles through the movie list like a still
 * screensaver: background pan + staggered text reveal (title, then date,
 * then plot, each with a short gap — same cadence as the Figma prototype,
 * just started sooner), held until the next movie crossfades in.
 */

const CYCLE_MS = 9000;
const HIDE_MS = 260; // must match the fade-out transition duration in styles.css
const REVEAL = {
  title: { delay: 1200, dur: 650 },
  date: { delay: 1600, dur: 750 },
  plot: { delay: 2200, dur: 1050 },
};

(async function init() {
  let movies = SEED_MOVIES;
  try {
    movies = await MovieMeterAPI.hydrate(SEED_MOVIES, typeof MOVIEMETER_API_KEY !== "undefined" ? MOVIEMETER_API_KEY : "");
  } catch (err) {
    console.warn("Running on seed data:", err);
  }

  const els = {
    bg: [document.getElementById("bgA"), document.getElementById("bgB")],
    poster: [document.getElementById("posterA"), document.getElementById("posterB")],
    title: document.getElementById("title"),
    date: document.getElementById("date"),
    plot: document.getElementById("plot"),
    credit: document.getElementById("credit"),
    dots: document.getElementById("dots"),
    root: document.getElementById("screensaver"),
  };

  movies.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.className = "dot";
    dot.setAttribute("role", "tab");
    dot.setAttribute("aria-label", `Film ${i + 1} van ${movies.length}`);
    dot.addEventListener("click", () => jumpTo(i));
    els.dots.appendChild(dot);
  });

  let current = -1; // index currently shown in bg/poster layer `layer`
  let layer = 0; // which of the two crossfade layers is active
  let slideStart = 0;
  let pausedAt = null;
  let revealTimers = [];
  let rafId = null;

  function clearReveals() {
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
    [els.title, els.date, els.plot].forEach((el) => el.classList.remove("in"));
  }

  function scheduleReveals() {
    revealTimers.push(setTimeout(() => els.title.classList.add("in"), REVEAL.title.delay));
    revealTimers.push(setTimeout(() => els.date.classList.add("in"), REVEAL.date.delay));
    revealTimers.push(setTimeout(() => els.plot.classList.add("in"), REVEAL.plot.delay));
  }

  function showMovie(index) {
    const movie = movies[index];
    const nextLayer = 1 - layer;

    els.bg[nextLayer].style.backgroundImage = `url("${movie.poster}")`;
    els.bg[layer].classList.remove("active", "panning");
    // force reflow so the pan animation restarts cleanly on the new layer
    void els.bg[nextLayer].offsetWidth;
    els.bg[nextLayer].classList.add("active", "panning");

    els.poster[nextLayer].src = movie.poster;
    els.poster[nextLayer].alt = `${movie.title} poster`;
    els.poster[layer].classList.remove("active");
    els.poster[nextLayer].classList.add("active");

    layer = nextLayer;

    clearReveals(); // hides the outgoing copy first (fast fade, see .title/.date/.plot in styles.css)
    revealTimers.push(
      setTimeout(() => {
        els.title.textContent = movie.title;
        els.date.textContent = movie.releaseDateDisplay;
        els.plot.textContent = movie.plot;
        els.credit.href = movie.url;
        scheduleReveals();
      }, HIDE_MS)
    );

    [...els.dots.children].forEach((d, i) => d.classList.toggle("active", i === index));

    current = index;
    slideStart = performance.now();
  }

  function jumpTo(index) {
    slideStart = performance.now();
    showMovie(index);
  }

  function tick(now) {
    if (pausedAt === null && now - slideStart >= CYCLE_MS) {
      showMovie((current + 1) % movies.length);
    }
    rafId = requestAnimationFrame(tick);
  }

  els.root.addEventListener("mouseenter", () => {
    pausedAt = performance.now();
    els.root.querySelectorAll(".bg-layer.panning").forEach((el) => (el.style.animationPlayState = "paused"));
  });
  els.root.addEventListener("mouseleave", () => {
    if (pausedAt !== null) {
      slideStart += performance.now() - pausedAt;
      pausedAt = null;
      els.root.querySelectorAll(".bg-layer.panning").forEach((el) => (el.style.animationPlayState = "running"));
    }
  });

  showMovie(0);
  rafId = requestAnimationFrame(tick);
})();
