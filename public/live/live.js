/* Tanuki live pages. The stream is never considered live merely because a URL exists. */
(() => {
  const type = document.body.dataset.channel;
  if (type !== "radio" && type !== "tv") return;
  const $ = (id) => document.getElementById(id);
  const status = $("stream-status");
  const zone = $("player-zone");
  const now = $("now-playing");
  const schedule = $("schedule");

  function validStream(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
      return url.href;
    } catch { return null; }
  }

  function validStatusPath(value) {
    // Keep status requests on our own site; no passwords or third-party credentials in the browser.
    if (typeof value !== "string" || !value.startsWith("/api/") || value.startsWith("//")) return null;
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin ? url.href : null;
    } catch { return null; }
  }

  function setStatus(label, live) {
    status.textContent = label;
    status.classList.toggle("is-live", live === true);
  }

  async function loadStatus(url) {
    if (!url) return;
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error("status unavailable");
      const data = await res.json();
      // An authoritative server endpoint must explicitly confirm live=true.
      if (data && data.live === true) setStatus("● У прямому ефірі", true);
      else if (data && data.live === false) setStatus("Ефір зараз не ведеться", false);
      else setStatus("Стан ефіру невідомий", false);
      if (data && typeof data.nowPlaying === "string" && data.nowPlaying.trim())
        now.textContent = data.nowPlaying.slice(0, 180);
      if (data && typeof data.schedule === "string" && data.schedule.trim())
        schedule.textContent = data.schedule.slice(0, 500);
    } catch {
      setStatus("Немає зв’язку зі статусом ефіру", false);
    }
  }

  async function init() {
    let config;
    try {
      const res = await fetch("/live/config.json", { cache: "no-store" });
      if (!res.ok) throw new Error("config unavailable");
      config = (await res.json())[type] || {};
    } catch {
      setStatus("Ефір ще не підключено", false);
      zone.querySelector("p").textContent = "Налаштування трансляції поки недоступне.";
      return;
    }
    const src = validStream(config.streamUrl);
    const statusUrl = validStatusPath(config.statusUrl);
    if (!src) {
      setStatus("Ефір ще не підключено", false);
      zone.querySelector("p").textContent = "Сервер трансляції поки не підключений.";
      return;
    }

    zone.textContent = "";
    zone.classList.remove("empty-player", "tv-player");
    if (type === "radio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.src = src;
      audio.setAttribute("aria-label", "Прямий ефір Tanuki Radio");
      zone.append(audio);
    } else {
      const video = document.createElement("video");
      video.controls = true;
      video.playsInline = true;
      video.preload = "none";
      video.setAttribute("aria-label", "Прямий ефір Tanuki TV");
      zone.append(video);
      if (/\.m3u8(?:\?|$)/i.test(src) && !video.canPlayType("application/vnd.apple.mpegurl")) {
        const link = document.createElement("a");
        link.href = src;
        link.textContent = "Відкрити відеопотік у сумісному плеєрі";
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        zone.append(link);
      } else {
        video.src = src;
      }
    }
    setStatus("Плеєр налаштовано · стан ефіру невідомий", false);
    if (statusUrl) {
      await loadStatus(statusUrl);
      setInterval(() => loadStatus(statusUrl), 15000);
    }
  }
  init();
})();
