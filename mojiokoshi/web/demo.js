/* Design harness: open index.html?demo=<scene> in any browser to stage the UI
 * without Python. Scenes: idle · drag · download · work · done · multi · error */
(() => {
  "use strict";
  const scene = new URLSearchParams(location.search).get("demo") || "work";
  const emit = (e, p) => window.mojiokoshi.emit(e, p);
  const { S } = window.mojiokoshiInternals;

  const LINES = [
    "半導体製造プロセスとその関連技術、第1回、半導体とは。",
    "昨今、半導体という言葉を聞かない日がないほどですが、その実態はわからないところが多いと思います。",
    "今回の講義では、まず、半導体とは何か、そしてシリコンウェハの作成について触れたいと思います。",
    "まずは、半導体とは何か、という問いかけから始めたいと思います。",
    "我々の身の回りにある物質を分類するとき、いろいろな分類の仕方があります。",
    "その一つが、電流の流れやすさです。",
    "電流の流れやすさを表すのが導電率であり、ジーメンス毎メートルで表されます。",
    "逆に、電流の流れにくさを表すのが電気抵抗率であり、通常、オームセンチメートルで表すことが多いです。",
    "半導体の重要な特徴の一つが、不純物を添加することで、電流の流れやすさを変化させることができるということです。",
    "一方、世間一般で言われている半導体は、半導体材料から作られる電子部品、すなわち半導体デバイス全般を示します。",
    "まずは、物理学的な意味での半導体を見ていきます。",
    "すなわち、長ければ長いほど大きくなり、断面積が大きくなるほど小さくなります。",
    "したがって、物質そのものが持っている電流の流れにくさを比較するのには適していないことになります。",
    "これには、金、銀、銅、鉄、アルミニウムなどの金属が含まれます。",
    "シリコンウェハーのサイズは、時代とともに拡大し、現在は12インチ、およそ300ミリが主流となっています。",
  ];

  function peaks(n = 960, seed = 7) {
    let s = seed;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = [];
    let phrase = 0, level = 0;
    for (let i = 0; i < n; i++) {
      if (phrase <= 0) { phrase = 6 + Math.floor(r() * 26); level = r() < 0.16 ? 0.05 : 0.45 + r() * 0.5; }
      phrase--;
      const v = level * (0.55 + 0.45 * r()) * (0.8 + 0.2 * Math.sin(i * 0.9));
      out.push(Math.min(1, Math.max(0.02, v)));
    }
    return out;
  }

  const base = (id, name, extra = {}) => ({
    id,
    name,
    source: `C:\\Users\\you\\Lectures\\${name}`,
    directory: "C:\\Users\\you\\Lectures",
    output: `C:\\Users\\you\\Lectures\\${name.replace(/\.[^.]+$/, ".txt")}`,
    outputName: name.replace(/\.[^.]+$/, ".txt"),
    size: 138251537,
    status: "queued",
    duration: 2762.1,
    progress: 0,
    language: null,
    languageProbability: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    characters: 0,
    segmentCount: 0,
    ...extra,
  });

  const ready = { model: "large-v3-turbo", state: "ready", device: "cuda", deviceLabel: "RTX 4060 Laptop GPU", computeType: "float16", downloadProgress: 1, error: null };

  window.pywebview = {
    api: {
      hello: async () => ({ version: "demo", engine: scene === "download" ? { ...ready, state: "downloading", downloadProgress: 0.43, deviceLabel: null } : ready, jobs: [], extensions: { video: ["avi", "m4v", "mkv", "mov", "mp4", "webm"], audio: ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"] } }),
      browse: () => run("work"),
      cancel: (id) => emit("job:update", { ...S.jobs.get(id), status: "canceled", finishedAt: Date.now() / 1000 }),
      open: () => {},
      reveal: () => {},
      read: async () => "",
      theme: () => {},
      quit: () => {},
    },
  };
  dispatchEvent(new Event("pywebviewready"));

  function stream(id, from, to, ms, done) {
    const job = S.jobs.get(id);
    const steps = Math.max(1, Math.round((to - from) * 260));
    let i = 0;
    const tick = () => {
      const p = from + ((to - from) * (i + 1)) / steps;
      const text = LINES[(i + Math.round(from * 260)) % LINES.length];
      emit("job:segment", { id, progress: p, segment: { index: S.segs.get(id).length, start: p * job.duration - 6, end: p * job.duration, text } });
      if (++i < steps) setTimeout(tick, ms / steps);
      else done?.();
    };
    tick();
  }

  function start(id, name, upto, then) {
    const t0 = Date.now() / 1000 - 40;
    emit("job:update", base(id, name, { status: "decoding", progress: 0.6, startedAt: t0 }));
    emit("job:waveform", { id, duration: 2762.1, peaks: peaks(960, id.length * 13) });
    emit("job:update", base(id, name, { status: "transcribing", language: "ja", languageProbability: 0.9995, startedAt: t0 }));
    stream(id, 0, upto, 1400, then);
  }

  function finish(id, name) {
    const t0 = Date.now() / 1000 - 100;
    emit("job:update", base(id, name, { status: "done", progress: 1, language: "ja", languageProbability: 0.9995, startedAt: t0, finishedAt: t0 + 100, characters: 31842, segmentCount: S.segs.get(id).length }));
  }

  function run(which) {
    switch (which) {
      case "idle":
        break;
      case "drag":
        document.body.dataset.drag = "true";
        document.getElementById("dragtag").style.transform = "translate3d(760px, 520px, 0)";
        Field.setDrag(true);
        break;
      case "download":
        emit("job:added", base("a1", "半導体01_1.mp4"));
        emit("job:update", base("a1", "半導体01_1.mp4", { status: "decoding", progress: 1, startedAt: Date.now() / 1000 - 5 }));
        emit("job:waveform", { id: "a1", duration: 2762.1, peaks: peaks() });
        break;
      case "work":
        emit("job:added", base("a1", "半導体01_1.mp4"));
        start("a1", "半導体01_1.mp4", 0.42);
        break;
      case "done":
        emit("job:added", base("a1", "半導体01_1.mp4"));
        start("a1", "半導体01_1.mp4", 1, () => finish("a1", "半導体01_1.mp4"));
        break;
      case "multi":
        ["半導体01_1.mp4", "半導体01_2.mp4", "interview-with-a-very-long-file-name-2026-10-04.wav"].forEach((n, i) => emit("job:added", base("m" + i, n)));
        start("m0", "半導体01_1.mp4", 1, () => {
          finish("m0", "半導体01_1.mp4");
          start("m1", "半導体01_2.mp4", 0.67);
        });
        break;
      case "error":
        emit("job:added", base("e1", "broken.mp4"));
        emit("job:update", base("e1", "broken.mp4", { status: "failed", error: "音声トラックが見つかりません", startedAt: Date.now() / 1000 - 1, finishedAt: Date.now() / 1000 }));
        emit("drop:rejected", { names: ["slides.pdf", "notes.docx"] });
        break;
    }
  }

  window.mojiokoshiDemo = {
    drop(e) {
      const names = [...(e.dataTransfer?.files || [])].map((f) => f.name);
      names.forEach((n, i) => emit("job:added", base("d" + Date.now() + i, n)));
    },
  };

  setTimeout(() => run(scene), 700);
})();
