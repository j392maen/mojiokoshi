/* mojiokoshi — page controller. Python pushes events through window.mojiokoshi.emit,
 * the page calls back through window.pywebview.api.                            */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ACTIVE = new Set(["decoding", "transcribing", "writing"]);
  const FINISHED = new Set(["done", "failed", "canceled"]);

  const S = {
    engine: { state: "idle" },
    jobs: new Map(),     // id → job dict (as sent by Python)
    segs: new Map(),     // id → [{index,start,end,text}]
    peaks: new Map(),    // id → number[]
    selected: null,
    follow: true,
    view: "idle",
    extensions: null,
  };

  let api = null;
  const call = (name, ...args) => {
    try { return Promise.resolve(api?.[name]?.(...args)); } catch { return Promise.resolve(); }
  };

  // --------------------------------------------------------------- formatting
  function tc(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  function humanDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}秒`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s ? `${m}分${s}秒` : `${m}分`;
    return `${Math.floor(m / 60)}時間${m % 60}分`;
  }
  const languageNames = (() => {
    try { return new Intl.DisplayNames(["ja"], { type: "language" }); } catch { return null; }
  })();
  const languageName = (code) => (code && languageNames?.of(code)) || (code || "").toUpperCase();
  const number = new Intl.NumberFormat("ja-JP");
  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function splitName(name) {
    const i = name.lastIndexOf(".");
    return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
  }

  // ------------------------------------------------------------------- views
  function setView(view) {
    if (S.view === view) return;
    S.view = view;
    body.dataset.view = view;
    if (view === "work") {
      requestAnimationFrame(() => {
        const r = $("wave").getBoundingClientRect();
        Field.collapse(r.top + r.height / 2 || innerHeight * 0.8);
        Wave.wake();
      });
    } else {
      Field.expand();
    }
  }

  function toast(text, ms = 3200) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("on");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("on"), ms);
  }

  // ------------------------------------------------------------------ engine
  function renderEngine() {
    const e = S.engine;
    const el = $("engine");
    el.dataset.state = e.state;
    const model = e.model || "large-v3-turbo";
    const text = {
      idle: "エンジンを準備しています",
      loading: "エンジンを起動しています",
      downloading: `モデルをダウンロード中 ${Math.floor((e.downloadProgress || 0) * 100)}% · 初回のみ`,
      ready: `${e.deviceLabel || ""} · ${model}`,
      error: "エンジンを起動できません",
    }[e.state];
    $("engine-text").textContent = text;
    el.title = e.state === "error" ? e.error || "" : "";
  }

  // ------------------------------------------------------------------- queue
  const order = () => [...S.jobs.keys()];

  function queueItem(job) {
    let li = document.querySelector(`.q[data-id="${job.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.className = "q";
      li.dataset.id = job.id;
      li.innerHTML = `
        <button class="q-main" type="button">
          <span class="q-idx"></span>
          <span class="q-name"></span>
          <span class="q-meta"></span>
        </button>
        <button class="q-x" type="button" aria-label="キャンセル">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8"/></svg>
        </button>
        <span class="q-bar" aria-hidden="true"></span>`;
      li.querySelector(".q-main").addEventListener("click", () => select(job.id, { user: true }));
      li.querySelector(".q-x").addEventListener("click", () => call("cancel", job.id));
      $("queue-list").append(li);
    }
    return li;
  }

  function renderQueueItem(job) {
    const li = queueItem(job);
    li.dataset.status = job.status;
    li.toggleAttribute("data-finished", FINISHED.has(job.status));
    li.setAttribute("aria-current", String(S.selected === job.id));
    li.querySelector(".q-idx").textContent = pad(order().indexOf(job.id) + 1);
    const name = li.querySelector(".q-name");
    name.textContent = job.name;
    name.title = job.source;
    li.querySelector(".q-meta").textContent = queueMeta(job);
    li.querySelector(".q-bar").style.setProperty("--p", job.status === "done" ? 1 : job.status === "transcribing" ? job.progress : 0);
  }

  function queueMeta(job) {
    const d = job.duration ? tc(job.duration) : "--:--";
    switch (job.status) {
      case "queued": return `${d} · 待機中`;
      case "decoding": return `${d} · 読み込み中`;
      case "transcribing": return `${d} · ${Math.floor(job.progress * 100)}%`;
      case "writing": return `${d} · 書き出し中`;
      case "done": return `→ ${job.outputName}`;
      case "failed": return job.error || "失敗しました";
      case "canceled": return "キャンセル済み";
    }
    return d;
  }

  function renderQueueHead() {
    $("queue-count").textContent = pad(S.jobs.size);
    $("clear").hidden = ![...S.jobs.values()].some((j) => FINISHED.has(j.status));
  }

  function select(id, { user = false } = {}) {
    if (!S.jobs.has(id)) return;
    if (user) S.follow = ACTIVE.has(S.jobs.get(id).status) || S.jobs.get(id).status === "queued";
    const changed = S.selected !== id;
    S.selected = id;
    document.querySelectorAll(".q").forEach((li) => li.setAttribute("aria-current", String(li.dataset.id === id)));
    if (changed) {
      Wave.load(id);
      Reel.load(id);
    }
    renderStage();
  }

  function clearFinished() {
    for (const [id, job] of S.jobs) {
      if (!FINISHED.has(job.status)) continue;
      S.jobs.delete(id);
      S.segs.delete(id);
      S.peaks.delete(id);
      document.querySelector(`.q[data-id="${id}"]`)?.remove();
    }
    S.jobs.forEach(renderQueueItem);
    renderQueueHead();
    if (!S.jobs.size) {
      S.selected = null;
      S.follow = true;
      setView("idle");
    } else if (!S.jobs.has(S.selected)) {
      select(order()[0]);
    }
  }

  // ------------------------------------------------------------------- stage
  const STATUS = {
    queued: "Waiting in queue",
    decoding: "Reading audio",
    transcribing: "Transcribing",
    writing: "Writing text",
    done: "Saved",
    failed: "Failed",
    canceled: "Canceled",
  };

  function renderStage() {
    const job = S.jobs.get(S.selected);
    if (!job) return;
    const stage = $("stage");
    const e = S.engine;
    // Decoded but the model is still downloading / loading: say so instead of "reading audio".
    const engineBusy = e.state !== "ready" && (job.status === "transcribing" || (job.status === "decoding" && S.peaks.has(job.id)));
    stage.dataset.status = job.status;

    $("stage-num").textContent = pad(order().indexOf(job.id) + 1);
    let label = STATUS[job.status];
    if (engineBusy) label = e.state === "downloading" ? "Downloading model" : "Starting engine";
    $("stage-status").textContent = `${label}${S.jobs.size > 1 ? ` — ${pad(order().indexOf(job.id) + 1)} / ${pad(S.jobs.size)}` : ""}`;

    const [stem, ext] = splitName(job.name);
    const title = $("stage-title");
    if (title.dataset.for !== job.id) {
      title.dataset.for = job.id;
      title.innerHTML = `${escapeHTML(stem)}<span class="ext">${escapeHTML(ext)}</span>`;
      title.title = job.source;
    }

    $("m-duration").textContent = job.duration ? tc(job.duration) : "—";
    const silent = job.status === "done" && !job.segmentCount;
    $("m-language").textContent = silent
      ? "—"
      : job.language
      ? `${languageName(job.language)} · ${(job.languageProbability * 100).toFixed(job.languageProbability > 0.995 ? 0 : 1)}%`
      : "自動判定";
    $("m-engine").textContent = e.state === "ready"
      ? `${e.deviceLabel} · ${e.computeType === "float16" ? "fp16" : e.computeType}`
      : "—";
    $("m-speed").textContent = speedOf(job);
    $("m-output").innerHTML = `<b>${escapeHTML(job.outputName)}</b>&ensp;${escapeHTML(job.directory)}`;
    $("m-output").title = job.output;

    $("tc-total").textContent = tc(job.duration);
    $("tc-mid").textContent = midline(job, engineBusy);
    renderEmpty(job, engineBusy);
    Wave.target = job.status === "done" ? 1 : job.status === "transcribing" || job.status === "writing" ? job.progress : Wave.target;
    if (job.status === "queued" || job.status === "decoding") Wave.target = 0;
  }

  function elapsedOf(job) {
    if (!job.startedAt) return 0;
    return (job.finishedAt || Date.now() / 1000) - job.startedAt;
  }

  function speedOf(job) {
    if (!["transcribing", "writing", "done"].includes(job.status)) return "—";
    const el = elapsedOf(job);
    if (!job.duration || el < 1) return "—";
    const covered = job.status === "done" ? job.duration : job.duration * job.progress;
    if (covered <= 0) return "—";
    return `${(covered / el).toFixed(1)}× realtime`;
  }

  function midline(job, engineBusy) {
    const e = S.engine;
    if (engineBusy) {
      return e.state === "downloading"
        ? `音声認識モデルを取得しています ${Math.floor(e.downloadProgress * 100)}%（初回のみ・約1.6GB）`
        : "音声認識エンジンを起動しています";
    }
    switch (job.status) {
      case "queued": return "順番を待っています";
      case "decoding": return `音声を読み込んでいます ${Math.floor((job.progress || 0) * 100)}%`;
      case "transcribing": {
        const el = (Date.now() / 1000) - (job._tStart || job.startedAt || Date.now() / 1000);
        if (job.progress < 0.03 || el < 3) return "残り時間を計算しています";
        return `残り 約${humanDuration((el * (1 - job.progress)) / job.progress)}`;
      }
      case "writing": return "テキストを書き出しています";
      case "done": {
        const segs = S.segs.get(job.id) || [];
        const lines = segs.length || job.segmentCount;
        if (!lines) return "発話は検出されませんでした · 空のテキストを書き出しました";
        return `${number.format(job.characters)}文字 · ${number.format(lines)}行 · ${humanDuration(elapsedOf(job))}で完了`;
      }
      case "failed":
      case "canceled": return "テキストは書き出されていません";
    }
    return "";
  }

  function renderEmpty(job, engineBusy) {
    const el = $("reel-empty");
    const hasSegs = (S.segs.get(job.id) || []).length > 0;
    let text = "";
    if (!hasSegs) {
      if (engineBusy) text = "エンジンを温めています";
      else if (job.status === "queued") text = "順番を待っています";
      else if (job.status === "decoding") text = "音声を読み込んでいます";
      else if (job.status === "transcribing") text = "耳を澄ませています";
      else if (job.status === "done") text = "発話が見つかりませんでした";
      else if (job.status === "failed") text = job.error || "処理に失敗しました";
      else if (job.status === "canceled") text = "キャンセルしました";
    }
    const animated = ["エンジンを温めています", "音声を読み込んでいます", "耳を澄ませています", "順番を待っています"].includes(text);
    const html = text ? `${escapeHTML(text)}${animated ? '<span class="dots"></span>' : ""}` : "";
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // -------------------------------------------------------------------- reel
  const Reel = {
    offset: 0,
    mode: "live",
    keep: 80,

    node(seg, enter) {
      const p = document.createElement("p");
      p.className = "seg" + (enter && !reduce.matches ? " enter" : "");
      p.dataset.index = seg.index;
      p.innerHTML = `<span class="seg-tc">${tc(seg.start)}</span><span class="seg-text">${escapeHTML(seg.text)}</span>`;
      return p;
    },

    load(id) {
      const inner = $("reel-inner");
      const job = S.jobs.get(id);
      const segs = S.segs.get(id) || [];
      inner.textContent = "";
      this.offset = 0;
      if (job?.status === "done") return this.read(id);
      this.mode = "live";
      $("reel").dataset.mode = "live";
      const frag = document.createDocumentFragment();
      segs.slice(-this.keep).forEach((s) => frag.append(this.node(s, false)));
      inner.append(frag);
      this.restyle();
    },

    push(seg) {
      if (this.mode !== "live") return;
      const inner = $("reel-inner");
      const p = this.node(seg, true);
      inner.append(p);
      this.offset += p.offsetHeight;
      while (inner.childElementCount > this.keep) inner.firstElementChild.remove();
      this.restyle();
    },

    restyle() {
      const items = $("reel-inner").children;
      const n = items.length;
      for (let i = Math.max(0, n - 6); i < n; i++) {
        items[i].classList.toggle("now", i === n - 1);
        items[i].classList.toggle("recent", i >= n - 4 && i < n - 1);
      }
    },

    read(id) {
      const reel = $("reel");
      const inner = $("reel-inner");
      const segs = S.segs.get(id) || [];
      this.mode = "read";
      this.offset = 0;
      inner.style.transform = "";
      reel.dataset.mode = "read";
      inner.textContent = "";
      const frag = document.createDocumentFragment();
      segs.forEach((s) => frag.append(this.node(s, false)));
      inner.append(frag);
      reel.scrollTop = reel.scrollHeight;
    },

    reveal(index) {
      if (this.mode !== "read") return;
      const p = $("reel-inner").querySelector(`[data-index="${index}"]`);
      if (!p) return;
      p.scrollIntoView({ block: "center", behavior: reduce.matches ? "auto" : "smooth" });
      p.classList.add("flash");
      setTimeout(() => p.classList.remove("flash"), 1600);
    },

    tick(dt) {
      if (this.mode !== "live") return;
      if (Math.abs(this.offset) < 0.25) this.offset = 0;
      else this.offset *= reduce.matches ? 0 : Math.exp(-dt * 9);
      $("reel-inner").style.transform = this.offset ? `translate3d(0, ${this.offset.toFixed(2)}px, 0)` : "";
    },
  };

  // -------------------------------------------------------------------- wave
  const Wave = {
    canvas: $("wave"),
    ctx: $("wave").getContext("2d"),
    id: null,
    peaks: null,
    shown: 0,
    target: 0,
    born: 0,
    hover: -1,
    doneAt: -1e9,
    running: false,
    last: 0,
    colors: {},

    readColors() {
      const css = getComputedStyle(document.documentElement);
      this.colors = {
        paper: css.getPropertyValue("--paper").trim(),
        paperRGB: css.getPropertyValue("--paper-rgb").trim(),
        shu: css.getPropertyValue("--shu").trim(),
      };
    },

    load(id) {
      this.id = id;
      this.peaks = S.peaks.get(id) || null;
      const job = S.jobs.get(id);
      this.shown = job?.status === "done" ? 1 : job?.status === "transcribing" ? job.progress : 0;
      this.target = this.shown;
      this.born = this.peaks ? -1e9 : 0;
      this.wake();
    },

    set(id, peaks) {
      S.peaks.set(id, peaks);
      if (id !== this.id) return;
      this.peaks = peaks;
      this.born = performance.now();
      this.wake();
    },

    wake() {
      if (this.running) return;
      this.running = true;
      this.last = 0;
      requestAnimationFrame((t) => this.frame(t));
    },

    frame(now) {
      const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
      this.last = now;
      Reel.tick(dt);
      const job = S.jobs.get(this.id);
      if (job?.status === "transcribing") $("tc-mid").textContent = midline(job, false);

      this.shown += (this.target - this.shown) * (reduce.matches ? 1 : 1 - Math.exp(-dt * 5));
      if (Math.abs(this.target - this.shown) < 0.0004) this.shown = this.target;
      this.draw(now);
      this.renderReadout(job);

      const settled =
        this.shown === this.target &&
        Reel.offset === 0 &&
        (!this.peaks || now - this.born > 2400) &&
        now - this.doneAt > 1600 &&
        !(job && ACTIVE.has(job.status));
      if (S.view !== "work" || settled) {
        this.running = false;
        return;
      }
      requestAnimationFrame((t) => this.frame(t));
    },

    renderReadout(job) {
      if (!job) return;
      const pct = Math.floor(this.shown * 100 + 1e-6);
      const el = $("pct");
      if (el.textContent !== String(pct)) el.textContent = pct;
      $("tc-now").textContent = tc(this.shown * (job.duration || 0));
    },

    draw(now) {
      const c = this.canvas, ctx = this.ctx;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = c.clientWidth, H = c.clientHeight;
      if (!W || !H) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const { paperRGB, shu, paper } = this.colors;
      const mid = Math.round(H / 2);
      const job = S.jobs.get(this.id);

      if (!this.peaks) {
        // Before the waveform exists: a single hairline, being read left to right.
        ctx.fillStyle = `rgb(${paperRGB} / 0.18)`;
        ctx.fillRect(0, mid - 0.5, W, 1);
        const p = job?.status === "decoding" ? job.progress || 0 : 0;
        if (p > 0) {
          ctx.fillStyle = paper;
          ctx.fillRect(0, mid - 0.5, W * p, 1);
        }
        if (job && (job.status === "decoding" || job.status === "queued")) {
          const x = ((now / 1600) % 1) * W;
          const g = ctx.createLinearGradient(x - 120, 0, x, 0);
          g.addColorStop(0, `rgb(${paperRGB} / 0)`);
          g.addColorStop(1, `rgb(${paperRGB} / 0.5)`);
          ctx.fillStyle = g;
          ctx.fillRect(x - 120, mid - 0.5, 120, 1);
        }
        return;
      }

      const bar = 2, gap = 2, stride = bar + gap;
      const n = Math.floor(W / stride);
      const peaks = this.peaks;
      const age = reduce.matches ? 1e9 : (now - this.born) / 1000;
      const playX = this.shown * W;
      const hoverX = this.hover;
      const offsetX = Math.floor((W - n * stride + gap) / 2);

      for (let k = 0; k < n; k++) {
        // Sample around the bar's centre rather than taking the max of its span:
        // at hour scale every span contains speech, and the max draws a flat wall.
        const c = ((k + 0.5) / n) * peaks.length;
        const j = Math.min(peaks.length - 1, Math.floor(c));
        const v = (peaks[j] * 2 + (peaks[j - 1] ?? peaks[j]) + (peaks[j + 1] ?? peaks[j])) / 4;
        // Bars grow out of the collapsed line, sweeping left to right.
        const grow = clamp((age - 0.25 - (k / n) * 0.7) / 0.7, 0, 1);
        const e = 1 - Math.pow(1 - grow, 4);
        const h = Math.max(1, Math.round(((v * (H - 4)) * e) / 2) * 2);
        const x = offsetX + k * stride;
        const played = x + bar / 2 <= playX;
        let alpha = played ? 1 : 0.22;
        if (hoverX >= 0) alpha = played ? 1 : Math.abs(x - hoverX) < 2 ? 0.9 : 0.22;
        ctx.fillStyle = played ? shu : `rgb(${paperRGB} / ${alpha})`;
        ctx.fillRect(x, mid - h / 2, bar, h); // h is even, so edges land on whole pixels
      }

      // On completion a band of light runs across the finished waveform.
      const sweep = (now - this.doneAt) / 1100;
      if (sweep > 0 && sweep < 1 && !reduce.matches) {
        const sx = -160 + sweep * (W + 320);
        const g = ctx.createLinearGradient(sx - 160, 0, sx + 160, 0);
        g.addColorStop(0, `rgb(${paperRGB} / 0)`);
        g.addColorStop(0.5, `rgb(${paperRGB} / 0.85)`);
        g.addColorStop(1, `rgb(${paperRGB} / 0)`);
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = g;
        ctx.fillRect(sx - 160, 0, 320, H);
        ctx.globalCompositeOperation = "source-over";
      }

      // Playhead
      if (this.shown > 0 && this.shown < 1) {
        ctx.fillStyle = paper;
        ctx.fillRect(Math.round(playX), 0, 1, H);
      }
      if (hoverX >= 0) {
        ctx.fillStyle = `rgb(${paperRGB} / 0.6)`;
        ctx.fillRect(Math.round(hoverX), 0, 1, H);
      }
    },
  };

  // Hover the waveform to hear what was said there — in words.
  function segmentAt(id, t) {
    const segs = S.segs.get(id) || [];
    let lo = 0, hi = segs.length - 1, found = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].start <= t) { found = segs[m]; lo = m + 1; } else hi = m - 1;
    }
    return found && t <= found.end + 4 ? found : null;
  }

  function onWaveMove(e) {
    const job = S.jobs.get(Wave.id);
    if (!job || !Wave.peaks || !job.duration) return;
    const r = Wave.canvas.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, r.width);
    const t = (x / r.width) * job.duration;
    Wave.hover = x;
    Wave.wake();
    const seg = x / r.width <= Wave.shown + 0.001 ? segmentAt(job.id, t) : null;
    const tip = $("tip");
    tip.querySelector(".tip-tc").textContent = tc(t);
    tip.querySelector(".tip-text").textContent = seg ? seg.text : "";
    const scopeR = $("scope").getBoundingClientRect();
    const half = Math.min(210, tip.offsetWidth / 2);
    tip.style.left = `${clamp(e.clientX - scopeR.left, half, scopeR.width - half)}px`;
    tip.classList.add("on");
  }

  function onWaveLeave() {
    Wave.hover = -1;
    Wave.wake();
    $("tip").classList.remove("on");
  }

  function onWaveClick(e) {
    const job = S.jobs.get(Wave.id);
    if (!job || !job.duration) return;
    const r = Wave.canvas.getBoundingClientRect();
    const seg = segmentAt(job.id, ((e.clientX - r.left) / r.width) * job.duration);
    if (seg) Reel.reveal(seg.index);
  }

  // ------------------------------------------------------------- python → UI
  function upsert(job) {
    const prev = S.jobs.get(job.id);
    if (prev?._tStart) job._tStart = prev._tStart;
    if (job.status === "transcribing" && !job._tStart) job._tStart = Date.now() / 1000;
    S.jobs.set(job.id, job);
    if (!S.segs.has(job.id)) S.segs.set(job.id, []);
    return prev;
  }

  const handlers = {
    "engine:state"(engine) {
      S.engine = engine;
      renderEngine();
      if (S.selected) renderStage();
    },

    "job:added"(job) {
      upsert(job);
      renderQueueItem(job);
      renderQueueHead();
      // A fresh drop always brings the new file into view unless something is still running.
      if (!S.selected || FINISHED.has(S.jobs.get(S.selected)?.status)) {
        S.follow = true;
        select(job.id);
      }
      setView("work");
    },

    "job:update"(job) {
      const prev = upsert(job);
      renderQueueItem(job);
      renderQueueHead();
      const started = job.status === "decoding" && prev?.status !== "decoding";
      if (started && S.follow) select(job.id);
      if (S.selected !== job.id) return;
      if (job.status === "done" && prev?.status !== "done") {
        Wave.target = 1;
        Wave.doneAt = performance.now() + 500;
        setTimeout(() => S.selected === job.id && Reel.read(job.id), reduce.matches ? 0 : 900);
      }
      renderStage();
      Wave.wake();
    },

    "job:waveform"({ id, duration, peaks }) {
      const job = S.jobs.get(id);
      if (job) {
        job.duration = duration;
        renderQueueItem(job);
      }
      Wave.set(id, peaks);
      if (S.selected === id) renderStage();
    },

    "job:segment"({ id, progress, segment }) {
      const job = S.jobs.get(id);
      if (!job) return;
      job.progress = progress;
      S.segs.get(id).push(segment);
      job.segmentCount = S.segs.get(id).length;
      renderQueueItemSoon(job);
      if (S.selected !== id) return;
      Reel.push(segment);
      Wave.target = progress;
      $("m-speed").textContent = speedOf(job);
      if (S.segs.get(id).length === 1) renderEmpty(job, false);
      Wave.wake();
    },

    "drop:rejected"({ names }) {
      const head = names.slice(0, 2).join("、");
      toast(`対応していない形式です：${head}${names.length > 2 ? ` ほか${names.length - 2}件` : ""}`);
    },

    "app:toast"({ text }) {
      toast(text, 5000);
    },

    "app:confirm-quit"() {
      const dlg = $("quit");
      if (!dlg.open) dlg.showModal();
    },
  };

  const renderQueueItemSoon = (() => {
    const pending = new Set();
    let raf = 0;
    return (job) => {
      pending.add(job.id);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Look jobs up at flush time: a newer job:update may have replaced the object.
        pending.forEach((id) => S.jobs.has(id) && renderQueueItem(S.jobs.get(id)));
        pending.clear();
      });
    };
  })();

  window.mojiokoshi = {
    emit(event, payload) {
      try { handlers[event]?.(payload); } catch (err) { console.error(event, err); }
    },
    /** Python coalesces bursts of events into one bridge call. */
    batch(events) {
      for (const [event, payload] of events) this.emit(event, payload);
    },
  };

  // ----------------------------------------------------------- drag and drop
  let dragDepth = 0;
  let dragWatchdog = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const setDrag = (on) => {
    body.dataset.drag = String(on);
    Field.setDrag(on && S.view === "idle");
  };
  const endDrag = () => {
    dragDepth = 0;
    clearTimeout(dragWatchdog);
    setDrag(false);
  };

  addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) setDrag(true);
  });
  addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // dragover fires continuously while a drag is over the window. If it stops
    // without a drop/dragleave reaching us, never leave the veil stuck on screen.
    clearTimeout(dragWatchdog);
    dragWatchdog = setTimeout(endDrag, 400);
    const tag = $("dragtag");
    const n = e.dataTransfer.items?.length || 0;
    const text = n > 1 ? `${n}件を文字起こし` : "文字起こしする";
    if (tag.lastChild.textContent !== text) tag.lastChild.textContent = text;
    tag.style.transform = `translate3d(${e.clientX + 18}px, ${e.clientY + 18}px, 0)`;
  });
  addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDrag(false);
  });
  // Capture phase: runs before pywebview's own document-level drop handler, which
  // is what forwards the files' full paths to Python.
  addEventListener("drop", (e) => {
    e.preventDefault();
    endDrag();
    if (S.view === "idle") Field.pulse();
    window.mojiokoshiDemo?.drop(e);
  }, true);
  addEventListener("dragend", endDrag);
  addEventListener("blur", endDrag);

  // ------------------------------------------------------------------ actions
  async function browse() {
    try {
      await api.browse();
    } catch (err) {
      toast("ファイル選択ダイアログを開けませんでした");
      console.error(err);
    }
  }
  $("browse").addEventListener("click", browse);
  $("clear").addEventListener("click", clearFinished);
  $("cancel").addEventListener("click", () => S.selected && call("cancel", S.selected));
  $("open-text").addEventListener("click", () => {
    const job = S.jobs.get(S.selected);
    if (job) call("open", job.output);
  });
  $("reveal").addEventListener("click", () => {
    const job = S.jobs.get(S.selected);
    if (job) call("reveal", job.output);
  });
  $("copy").addEventListener("click", async () => {
    const job = S.jobs.get(S.selected);
    if (!job) return;
    let text = (S.segs.get(job.id) || []).map((s) => s.text).join("\n");
    if (!text) text = (await call("read", job.output)) || "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(`${number.format(text.length)}文字をコピーしました`);
  });
  $("quit-stay").addEventListener("click", () => $("quit").close());
  $("quit-go").addEventListener("click", () => call("quit"));

  const wave = $("wave");
  wave.addEventListener("pointermove", onWaveMove);
  wave.addEventListener("pointerleave", onWaveLeave);
  wave.addEventListener("click", onWaveClick);

  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      browse();
    }
  });
  addEventListener("resize", () => Wave.wake());

  // ------------------------------------------------------------------- theme
  function syncTheme() {
    Wave.readColors();
    Wave.wake();
    call("theme", darkScheme.matches ? "dark" : "light");
  }
  darkScheme.addEventListener("change", syncTheme);

  // -------------------------------------------------------------------- boot
  async function connect() {
    api = window.pywebview?.api || null;
    if (!api) return;
    syncTheme();
    const hello = await call("hello");
    if (!hello) return;
    S.extensions = hello.extensions;
    const list = (xs) => xs.map((x) => x.toUpperCase()).join(" ");
    $("formats").innerHTML =
      `<span class="fmt-group">Video</span> ${list(hello.extensions.video)}&emsp;<span class="fmt-group">Audio</span> ${list(hello.extensions.audio)}`;
    handlers["engine:state"](hello.engine);
    hello.jobs.forEach((job) => handlers["job:added"](job));
  }

  async function boot() {
    Wave.readColors();
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 900))]);
    requestAnimationFrame(() => {
      body.classList.add("is-in");
      Field.start();
    });
    if (window.pywebview?.api) connect();
    else addEventListener("pywebviewready", connect, { once: true });
    if (new URLSearchParams(location.search).has("demo")) {
      const s = document.createElement("script");
      s.src = "demo.js";
      document.body.append(s);
    }
  }

  window.mojiokoshiInternals = { S, handlers, setView, select };
  boot();
})();
