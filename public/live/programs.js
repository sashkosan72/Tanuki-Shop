/* Launch-day sample schedule, separate from real playout/server status.
   Uses full timestamps with Kyiv UTC offset. Never infer a live broadcast from the schedule. */
(() => {
  const cfgUrl = "/live/programs.json";
  const type = document.body.dataset.channel;
  const overview = document.getElementById("overview-programs");
  const full = document.getElementById("program-guide");
  const summary = document.getElementById("schedule");

  function node(tag, text, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function stamp(config, hhmm) {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return NaN;
    return Date.parse(config.broadcastDate + "T" + hhmm + ":00" + config.utcOffset);
  }

  function decorate(items, data, now) {
    return items.map((item, index) => {
      const start = stamp(data, item.start);
      const end = stamp(data, item.end);
      return { ...item, startMs:start, endMs:end, index };
    }).filter(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs);
  }

  function paint(container, channel, data, limit, now) {
    const items = decorate(data[channel] || [], data, now);
    container.replaceChildren();
    if (!items.length) {
      container.append(node("p","Програму передач ще не сформовано.","guide-empty"));
      return { current:null,next:null,items:[] };
    }
    const current = items.find(x => x.startMs <= now && now < x.endMs) || null;
    const next = items.find(x => x.startMs > now) || null;
    const list = node("ol", null, "guide-list");
    for (const item of items.slice(0,limit)) {
      const li = node("li", null, "guide-item");
      const time = node("time", item.start + "–" + item.end,"guide-time");
      time.dateTime = data.broadcastDate + "T" + item.start + ":00" + data.utcOffset;
      const text = node("div",null,"guide-description");
      text.append(node("strong",item.title,"guide-title"));
      text.append(node("small",item.type || "", "guide-category"));
      li.append(time,text);
      if (item === current) {
        li.classList.add("guide-current");
        li.append(node("span","Зараз за планом","guide-state"));
      } else if (item === next) {
        li.append(node("span","Далі","guide-state guide-next"));
      }
      list.append(li);
    }
    container.append(list);
    return { current, next, items };
  }

  async function init() {
    if (!overview && !full) return;
    try {
      const res = await fetch(cfgUrl, {cache:"no-store"});
      if (!res.ok) throw new Error("HTTP "+res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.radio) || !Array.isArray(data.tv) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.broadcastDate) || !/^[+-][0-9]{2}:[0-9]{2}$/.test(data.utcOffset)) throw new Error("Invalid schedule");
      const dateLabel = new Intl.DateTimeFormat("uk-UA",{ timeZone:"Europe/Kyiv", day:"numeric",month:"long",year:"numeric" })
        .format(new Date(stamp(data,"16:00")));
      document.querySelectorAll(".guide-date").forEach(el => {
        el.textContent = dateLabel + " · за Києвом";
      });
      document.querySelectorAll(".guide-notice").forEach(el => { el.textContent = data.notice; });
      const render = () => {
        const now = Date.now();
        if (overview) {
          for (const channel of ["radio","tv"]) {
            const holder = document.getElementById(channel+"-programs");
            if (holder) paint(holder,channel,data,3,now);
          }
        }
        if (full && (type==="radio" || type==="tv")) {
          const result = paint(full,type,data,50,now);
          if (summary) {
            const active = result.current;
            const following = result.next;
            if (active) summary.textContent = "За розкладом зараз: " + active.title + (following ? ". Далі о "+following.start+": "+following.title+"." : ".");
            else if (following) summary.textContent = "Наступна за планом о "+following.start+": "+following.title+".";
            else summary.textContent = "Заплановані передачі на "+dateLabel+" завершилися. Оновлений розклад ще не опубліковано.";
            summary.dataset.programGuideReady = "true";
          }
        }
      };
      render();
      setInterval(render,30000);
    } catch (_) {
      document.querySelectorAll(".guide-notice").forEach(el => el.textContent = "Не вдалося завантажити програму передач. Спробуйте оновити сторінку.");
    }
  }
  init();
})();
