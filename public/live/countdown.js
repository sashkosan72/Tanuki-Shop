(() => {
  const start = Date.parse("2026-10-27T16:00:00+02:00");
  const nodes = document.querySelectorAll(".launch-countdown");
  if (!nodes.length) return;
  const plural = (n, forms) => forms[(n % 10 === 1 && n % 100 !== 11) ? 0 : ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) ? 1 : 2];
  function draw() {
    const remaining = Math.max(0, Math.ceil((start - Date.now()) / 1000));
    let message;
    if (remaining <= 0) {
      message = "Час запланованого старту настав";
    } else {
      const days = Math.floor(remaining / 86400);
      const hh = String(Math.floor((remaining % 86400) / 3600)).padStart(2,"0");
      const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2,"0");
      const ss = String(remaining % 60).padStart(2,"0");
      message = days > 0 ? `До старту: ${days} ${plural(days, ["день","дні","днів"])} ${hh}:${mm}:${ss}` : `До старту: ${hh}:${mm}:${ss}`;
    }
    nodes.forEach(node => { node.textContent = message; });
  }
  draw();
  setInterval(draw,1000);
})();
