const SAMPLE_DOCUMENT = `Artificial Intelligence is the field of computer science focused on building systems that perform tasks normally requiring human intelligence, such as understanding language, recognizing images, and making decisions. Modern AI is dominated by machine learning, where models learn patterns from large amounts of data instead of following hand-written rules.

Large Language Models, or LLMs, are neural networks trained on enormous collections of text. They predict the next word in a sequence, and from that simple objective they learn grammar, facts, and reasoning patterns. However, an LLM only knows what was in its training data. It cannot see your private documents, and its knowledge stops at a training cutoff date.

LLMs sometimes produce confident answers that are simply wrong. These fabricated statements are called hallucinations. They happen because the model generates plausible-sounding text rather than looking facts up in a trusted source.

Retrieval Augmented Generation, usually shortened to RAG, is a technique that fixes this by giving the model relevant information at the moment a question is asked. Instead of relying only on memory, a RAG system first searches a knowledge base, retrieves the most relevant passages, and places them in the prompt. The language model then writes an answer grounded in that retrieved context.

A RAG pipeline starts by splitting documents into smaller pieces called chunks. Chunking matters because a single embedding of a long document blurs many topics together, while small focused chunks let the system return only the paragraph that actually answers the question. A little overlap between neighbouring chunks keeps sentences from being cut in half.

Each chunk is then converted into an embedding, a list of numbers that captures its meaning. Embedding models such as BGE are trained so that texts with similar meaning produce vectors that point in similar directions, even when they use different words.

The embeddings are stored in a vector database. PostgreSQL with the pgvector extension can store vectors next to the original text and search them efficiently. When a user asks a question, the question is embedded with the same model, and the database returns the chunks whose vectors are closest to the query vector, usually measured with cosine similarity.

Finally, the retrieved chunks are passed to a language model together with the question. Because the answer is based on real source material, RAG reduces hallucinations, allows answers to cite their sources, and lets organisations use private or frequently updated knowledge without retraining the model.`;

const SUGGESTIONS = [
  "What is Retrieval Augmented Generation?",
  "Why do we split documents into chunks?",
  "How are similar texts found in a database?",
  "Why do language models make things up?",
];

const MAX_CHARS = 60000;
const STATUS_TEXT = { waiting: "Waiting", processing: "Processing", completed: "Completed", error: "Failed" };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  document: null,
  chunks: [],
  selected: null,
  projection: null,
  lastSearch: null,
  model: null,
  busy: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const wait = (ms) => (reduceMotion ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const chunkColor = (id) => `var(--c${id % 8})`;
const fmt = (n) => Number(n).toLocaleString();
const fmtVec = (values, count) => `[${values.slice(0, count).map((v) => v.toFixed(4)).join(", ")}, …]`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch {
    throw new Error("Cannot reach the backend. Is the container running?");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail;
    const message = Array.isArray(detail)
      ? detail.map((d) => String(d.msg || d).replace(/^Value error, /, "")).join(" ")
      : detail || `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function toast(title, message, kind = "ok") {
  const node = el("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, [
    el("strong", { text: title }),
    el("span", { text: message }),
  ]);
  $("#toasts").append(node);
  setTimeout(() => node.remove(), kind === "error" ? 7000 : 4500);
}

function setStage(name, status) {
  const stage = $(`.stage[data-stage="${name}"]`);
  stage.dataset.status = status;
  $(".stage-status", stage).textContent = STATUS_TEXT[status];
  const panel = document.getElementById(name);
  if (panel) panel.classList.toggle("active", status === "processing");
}

function setStages(map) {
  for (const [name, status] of Object.entries(map)) setStage(name, status);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle("loading", busy);
}

function metric(label, value, extra = "") {
  return el("div", { class: "metric" }, [
    el("div", { class: "metric-label", text: label }),
    el("div", { class: `metric-value ${extra}`, text: value }),
  ]);
}

function updateCharCount() {
  const length = $("#doc-input").value.length;
  const counter = $("#char-count");
  counter.textContent = `${fmt(length)} characters`;
  counter.classList.toggle("over", length > MAX_CHARS);
}

function syncSliders() {
  const size = Number($("#chunk-size").value);
  const overlapInput = $("#chunk-overlap");
  overlapInput.max = Math.min(200, Math.floor(size / 2));
  if (Number(overlapInput.value) > Number(overlapInput.max)) overlapInput.value = overlapInput.max;
  $("#size-out").textContent = `${size} chars`;
  $("#overlap-out").textContent = `${overlapInput.value} chars`;
}

async function refreshHealth() {
  try {
    const health = await api("/api/health");
    state.model = health.model;
    const modelPill = $("#model-pill");
    modelPill.dataset.state = health.model_loaded ? "ok" : "error";
    $("#model-status").textContent = health.model_loaded
      ? `${health.model.name.split("/").pop()} ready`
      : "not loaded";
  } catch {
    $("#model-pill").dataset.state = "error";
    $("#model-status").textContent = "unreachable";
  }
}

async function refreshStats() {
  let stats;
  try {
    stats = await api("/api/stats");
  } catch {
    stats = { connected: false, total_chunks: 0, total_vectors: 0, dimensions: 0 };
  }
  $("#db-pill").dataset.state = stats.connected ? "ok" : "error";
  $("#db-status").textContent = stats.connected
    ? `connected, pgvector ${stats.pgvector_version || ""}`.trim()
    : "disconnected";
  renderDbMetrics(stats);
  return stats;
}

function renderDbMetrics(stats) {
  $("#db-metrics").replaceChildren(
    metric("Stored chunks", fmt(stats.total_chunks)),
    metric("Total vectors", fmt(stats.total_vectors)),
    metric("Vector dimensions", stats.dimensions || "—"),
    metric("Connection", stats.connected ? "Connected" : "Disconnected", stats.connected ? "ok" : "err"),
    metric("Table size", stats.table_size || "—", "small"),
  );
}

function renderChunkMetrics(data) {
  const chunks = data.chunks;
  const avg = chunks.length ? Math.round(chunks.reduce((s, c) => s + c.char_count, 0) / chunks.length) : 0;
  const items = [
    metric("Chunks created", fmt(chunks.length)),
    metric("Average chunk size", `${avg} chars`),
  ];
  if (data.document_chars) items.unshift(metric("Document length", `${fmt(data.document_chars)} chars`));
  if (data.config) items.push(metric("Size and overlap", `${data.config.chunk_size} / ${data.config.chunk_overlap}`));
  if (data.timings_ms) items.push(metric("Chunking time", `${data.timings_ms.chunking} ms`));
  $("#chunk-metrics").replaceChildren(...items);
}

function renderSource(text, chunks) {
  const view = $("#source-view");
  if (!text) {
    view.replaceChildren(el("span", { class: "muted", text: "These chunks were loaded from PostgreSQL. The original document is not kept in the database, so process it again to see where each chunk came from." }));
    return;
  }
  const points = new Set([0, text.length]);
  for (const c of chunks) {
    points.add(c.start);
    points.add(c.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === b) continue;
    const covering = chunks.filter((c) => c.start <= a && c.end >= b);
    const piece = text.slice(a, b);
    if (!covering.length) {
      fragment.append(el("span", { class: "seg gap", text: piece }));
      continue;
    }
    const ids = covering.map((c) => c.chunk_id);
    const seg = el("span", {
      class: covering.length > 1 ? "seg overlap" : "seg",
      "data-chunks": ids.join(" "),
      style: `--chunk: ${chunkColor(ids[ids.length - 1])}`,
      title: covering.length > 1 ? `Overlap: chunks ${ids.join(" and ")}` : `Chunk ${ids[0]}`,
      text: piece,
    });
    seg.addEventListener("click", () => select(ids[ids.length - 1], "source"));
    fragment.append(seg);
  }
  view.replaceChildren(fragment);
}

function renderChunkCards(chunks, status) {
  const list = $("#chunk-list");
  const stagger = Math.min(40, 900 / Math.max(chunks.length, 1));
  list.replaceChildren(
    ...chunks.map((c, i) =>
      el(
        "article",
        {
          class: "chunk",
          tabindex: "0",
          "data-id": c.chunk_id,
          style: `--chunk: ${chunkColor(c.chunk_id)}; animation-delay: ${reduceMotion ? 0 : i * stagger}ms`,
          onclick: () => select(c.chunk_id, "chunks"),
          onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), select(c.chunk_id, "chunks")),
        },
        [
          el("div", { class: "chunk-top" }, [
            el("span", { class: "chunk-id", text: `chunk ${c.chunk_id}` }),
            el("span", { text: `${c.char_count} chars` }),
            el("span", { class: "badge", "data-s": status, text: status }),
          ]),
          el("p", { class: "chunk-text", text: c.text }),
        ],
      ),
    ),
  );
  $("#chunk-legend").textContent = `${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`;
}

function setBadges(status, ids = null) {
  for (const badge of $$("#chunk-list .badge")) {
    const id = Number(badge.closest(".chunk").dataset.id);
    if (ids && !ids.has(id)) continue;
    badge.dataset.s = status;
    badge.textContent = status;
  }
}

async function animateBadges(chunks, status, totalMs) {
  const batch = Math.max(1, Math.ceil(chunks.length / 12));
  const delay = totalMs / Math.ceil(chunks.length / batch);
  for (let i = 0; i < chunks.length; i += batch) {
    setBadges(status, new Set(chunks.slice(i, i + batch).map((c) => c.chunk_id)));
    await wait(delay);
  }
}

let vectorColors = null;
function hexToRgb(color) {
  const value = color.trim();
  if (value.startsWith("rgb")) {
    const nums = value.match(/\d+(\.\d+)?/g);
    return nums ? nums.slice(0, 3).map((n) => Math.round(Number(n))) : [15, 15, 15];
  }
  const hex = value.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function getVectorColors() {
  if (!vectorColors) {
    const styles = getComputedStyle(document.documentElement);
    vectorColors = {
      bg: hexToRgb(styles.getPropertyValue("--bg")),
      pos: hexToRgb(styles.getPropertyValue("--accent")),
      neg: hexToRgb(styles.getPropertyValue("--neg")),
    };
  }
  return vectorColors;
}

function drawStrip(canvas, vector) {
  const { bg, pos, neg } = getVectorColors();
  canvas.width = vector.length;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(vector.length, 1);
  vector.forEach((v, i) => {
    const t = Math.min(1, Math.abs(v) / 0.12);
    const target = v >= 0 ? pos : neg;
    image.data[i * 4] = bg[0] + (target[0] - bg[0]) * t;
    image.data[i * 4 + 1] = bg[1] + (target[1] - bg[1]) * t;
    image.data[i * 4 + 2] = bg[2] + (target[2] - bg[2]) * t;
    image.data[i * 4 + 3] = 255;
  });
  ctx.putImageData(image, 0, 0);
}

function fullVector(vector) {
  return el(
    "div",
    { class: "vfull", onclick: (e) => e.stopPropagation() },
    vector.map((v, i) => el("span", { class: v < 0 ? "n" : "" }, [el("i", { text: i }), v.toFixed(4)])),
  );
}

function renderEmbeddings(data) {
  const chunks = data.chunks;
  const model = data.model || state.model;
  const items = [
    metric("Model", model ? model.name : "—", "small"),
    metric("Dimensions", model ? model.dimensions : chunks[0]?.embedding?.length || "—"),
    metric("Embeddings generated", fmt(chunks.length)),
  ];
  if (data.timings_ms) {
    items.push(metric("Embedding time", data.duplicate ? "reused from DB" : `${fmt(data.timings_ms.embedding)} ms`, data.duplicate ? "small" : ""));
  }
  $("#embed-metrics").replaceChildren(...items);
  $("#flow-model").textContent = model ? model.name : "BAAI/bge-small-en-v1.5";

  const stagger = Math.min(35, 900 / Math.max(chunks.length, 1));
  $("#vector-list").replaceChildren(
    ...chunks.map((c, i) => {
      const canvas = el("canvas", { class: "vstrip", "aria-hidden": "true" });
      drawStrip(canvas, c.embedding);
      const row = el(
        "div",
        {
          class: "vrow",
          tabindex: "0",
          "data-id": c.chunk_id,
          style: `--chunk: ${chunkColor(c.chunk_id)}; animation-delay: ${reduceMotion ? 0 : i * stagger}ms`,
          onclick: () => select(c.chunk_id, "vectors"),
          onkeydown: (e) => e.target === row && e.key === "Enter" && select(c.chunk_id, "vectors"),
        },
        [
          el("span", { class: "chunk-id", text: `chunk ${c.chunk_id}` }),
          el("span", { class: "vpreview", text: fmtVec(c.embedding, 6) }),
          canvas,
        ],
      );
      const toggle = el("button", {
        class: "btn ghost small",
        type: "button",
        "aria-expanded": "false",
        text: `Show all ${c.embedding.length}`,
        onclick: (e) => {
          e.stopPropagation();
          const open = row.querySelector(".vfull");
          if (open) {
            open.remove();
            toggle.textContent = `Show all ${c.embedding.length}`;
            toggle.setAttribute("aria-expanded", "false");
          } else {
            row.append(fullVector(c.embedding));
            toggle.textContent = "Hide";
            toggle.setAttribute("aria-expanded", "true");
          }
        },
      });
      row.append(toggle);
      return row;
    }),
  );
}

function updateFlow() {
  const chunk = state.chunks.find((c) => c.chunk_id === state.selected) || state.chunks[0];
  if (!chunk) return;
  $("#flow-text").replaceChildren(
    el("span", { class: "chunk-id", style: `--chunk: ${chunkColor(chunk.chunk_id)}`, text: `chunk ${chunk.chunk_id}` }),
    el("span", { text: chunk.text }),
  );
  $("#flow-vector").replaceChildren(
    el("span", { text: fmtVec(chunk.embedding, 8) }),
    el("span", { class: "muted", text: `${chunk.embedding.length - 8} more numbers` }),
  );
}

function renderTable(chunks, fresh = false) {
  const body = $("#db-rows");
  if (!chunks.length) {
    body.replaceChildren(el("tr", { class: "empty-row" }, [el("td", { colspan: "4", text: "The chunks table is empty." })]));
    return;
  }
  body.replaceChildren(
    ...chunks.map((c, i) => {
      const row = el(
        "tr",
        {
          class: fresh ? "fresh" : "",
          tabindex: "0",
          "data-id": c.chunk_id,
          style: `--chunk: ${chunkColor(c.chunk_id)}; animation-delay: ${reduceMotion ? 0 : i * 30}ms`,
          onclick: () => select(c.chunk_id, "table"),
          onkeydown: (e) => e.key === "Enter" && select(c.chunk_id, "table"),
        },
        [
          el("td", { class: "num", text: c.id }),
          el("td", { class: "cid", text: c.chunk_id }),
          el("td", { class: "text" }, [el("span", { text: c.text })]),
          el("td", { class: "vec", text: c.embedding ? fmtVec(c.embedding, 3) : "vector(384)" }),
        ],
      );
      return row;
    }),
  );
}

function scrollWithin(container, item) {
  if (!container || !item) return;
  const top = item.offsetTop - container.offsetTop;
  if (top < container.scrollTop || top + item.offsetHeight > container.scrollTop + container.clientHeight) {
    container.scrollTo({ top: top - 8, behavior: reduceMotion ? "auto" : "smooth" });
  }
}

function select(id, origin) {
  state.selected = id;
  for (const node of $$("#chunk-list .chunk, #vector-list .vrow, #db-rows tr, #result-list .result, #map .pt")) {
    node.classList.toggle("selected", Number(node.dataset.id) === id);
  }
  for (const seg of $$("#source-view .seg[data-chunks]")) {
    const ids = seg.dataset.chunks.split(" ").map(Number);
    const hit = ids.includes(id);
    seg.classList.toggle("hl", hit);
    if (hit) seg.style.setProperty("--chunk", chunkColor(id));
  }
  if (origin !== "chunks") scrollWithin($("#chunk-list"), $(`#chunk-list .chunk[data-id="${id}"]`));
  if (origin !== "vectors") scrollWithin($("#vector-list"), $(`#vector-list .vrow[data-id="${id}"]`));
  if (origin !== "source") {
    const seg = $$("#source-view .seg[data-chunks]").find((s) => s.dataset.chunks.split(" ").map(Number).includes(id));
    scrollWithin($("#source-view"), seg);
  }
  updateFlow();
}

function renderMap() {
  const svg = $("#map");
  const empty = $("#map-empty");
  const note = $("#map-note");
  const projection = state.projection;
  hideTooltip();

  if (!projection || !projection.available) {
    svg.hidden = true;
    empty.hidden = false;
    empty.textContent = projection ? projection.reason : "The map appears after a document is processed.";
    note.textContent = "";
    return;
  }
  svg.hidden = false;
  empty.hidden = true;

  const W = 800, H = 440, pad = 46;
  const points = projection.points;
  const query = state.lastSearch ? projection.query_point : null;
  const all = query ? [...points, query] : points;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const sx = (x) => pad + ((x - minX) / spanX) * (W - pad * 2);
  const sy = (y) => H - pad - ((y - minY) / spanY) * (H - pad * 2);

  svg.replaceChildren();
  for (let i = 1; i < 8; i++) svg.append(svgEl("line", { class: "grid-line", x1: (W / 8) * i, x2: (W / 8) * i, y1: 0, y2: H, opacity: 0.5 }));
  for (let i = 1; i < 5; i++) svg.append(svgEl("line", { class: "grid-line", x1: 0, x2: W, y1: (H / 5) * i, y2: (H / 5) * i, opacity: 0.5 }));
  const [ev1, ev2] = projection.explained_variance.map((v) => Math.round(v * 100));
  const xLabel = svgEl("text", { class: "axis-label", x: W - 14, y: H - 14, "text-anchor": "end" });
  xLabel.textContent = `PC1, ${ev1}% of variance`;
  const yLabel = svgEl("text", { class: "axis-label", x: 14, y: 22 });
  yLabel.textContent = `PC2, ${ev2}% of variance`;
  svg.append(xLabel, yLabel);

  const matches = new Set(state.lastSearch ? state.lastSearch.results.map((r) => r.chunk_id) : []);
  if (query) {
    svg.classList.add("has-query");
    for (const r of state.lastSearch.results) {
      const index = state.chunks.findIndex((c) => c.chunk_id === r.chunk_id);
      if (index < 0) continue;
      svg.append(svgEl("line", { class: "link", x1: sx(query[0]), y1: sy(query[1]), x2: sx(points[index][0]), y2: sy(points[index][1]) }));
    }
  } else {
    svg.classList.remove("has-query");
  }

  points.forEach((p, index) => {
    const chunk = state.chunks[index];
    if (!chunk) return;
    const g = svgEl("g", {
      class: `pt${matches.has(chunk.chunk_id) ? " match" : ""}${chunk.chunk_id === state.selected ? " selected" : ""}`,
      "data-id": chunk.chunk_id,
      tabindex: "0",
      role: "button",
      "aria-label": `Chunk ${chunk.chunk_id}`,
    });
    g.append(svgEl("circle", { cx: sx(p[0]), cy: sy(p[1]), r: 7, fill: chunkColor(chunk.chunk_id) }));
    const label = svgEl("text", { x: sx(p[0]) + 11, y: sy(p[1]) + 4 });
    label.textContent = chunk.chunk_id;
    g.append(label);
    g.addEventListener("click", () => select(chunk.chunk_id, "map"));
    g.addEventListener("keydown", (e) => e.key === "Enter" && select(chunk.chunk_id, "map"));
    g.addEventListener("mouseenter", (e) => showTooltip(e, `chunk ${chunk.chunk_id}`, chunk.text));
    g.addEventListener("mousemove", moveTooltip);
    g.addEventListener("mouseleave", hideTooltip);
    svg.append(g);
  });

  if (query) {
    const qx = sx(query[0]);
    const qy = sy(query[1]);
    const g = svgEl("g", { class: "query-pt" });
    const star = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 12 : 5;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      star.push(`${qx + r * Math.cos(a)},${qy + r * Math.sin(a)}`);
    }
    g.append(svgEl("path", { d: `M${star.join("L")}Z` }));
    const label = svgEl("text", { x: qx + 16, y: qy - 10 });
    label.textContent = "your question";
    g.append(label);
    g.addEventListener("mouseenter", (e) => showTooltip(e, "query", state.lastSearch.query));
    g.addEventListener("mousemove", moveTooltip);
    g.addEventListener("mouseleave", hideTooltip);
    svg.append(g);
  }

  note.textContent = `These two axes keep only ${ev1 + ev2}% of the variation in the 384-dimensional vectors, so distances here are approximate.${query ? " Dashed lines connect your question to the chunks pgvector actually returned." : ""}`;
}

function showTooltip(event, title, text) {
  const tip = $("#tooltip");
  tip.replaceChildren(el("strong", { text: title }), el("span", { text: text.length > 160 ? `${text.slice(0, 160)}…` : text }));
  tip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const tip = $("#tooltip");
  const box = $(".map-wrap").getBoundingClientRect();
  let x = event.clientX - box.left + 14;
  const y = event.clientY - box.top + 14;
  if (x + tip.offsetWidth > box.width) x = event.clientX - box.left - tip.offsetWidth - 14;
  tip.style.transform = `translate(${x}px, ${y}px)`;
  tip.style.left = "0";
  tip.style.top = "0";
}

function hideTooltip() {
  $("#tooltip").hidden = true;
}

function showChunkSections(visible) {
  $("#chunk-empty").hidden = visible;
  $("#chunk-view").hidden = !visible;
  $("#embed-empty").hidden = visible;
  $("#embed-view").hidden = !visible;
}

function resetSearchUI() {
  state.lastSearch = null;
  for (const li of $$("#search-flow li")) delete li.dataset.state;
  $("#sf-question").textContent = "Waiting for a question";
  $("#sf-embed").textContent = "Not generated yet";
  $("#sf-search").textContent = "pgvector cosine distance";
  $("#sf-matched").textContent = "None yet";
  $("#result-list").replaceChildren(el("div", { class: "empty", text: "Search results appear here, ranked by similarity." }));
  setStages({ retrieval: "waiting", results: "waiting" });
}

async function processDocument() {
  if (state.busy) return;
  const text = $("#doc-input").value;
  if (!text.trim()) {
    toast("Nothing to process", "Paste some text or load the sample document first.", "error");
    $("#doc-input").focus();
    return;
  }
  if (text.length > MAX_CHARS) {
    toast("Document too long", `This demo accepts up to ${fmt(MAX_CHARS)} characters.`, "error");
    return;
  }

  const button = $("#process-btn");
  state.busy = true;
  setBusy(button, true);
  $("#search-btn").disabled = true;
  resetSearchUI();
  setStages({ document: "completed", chunking: "processing", embeddings: "waiting", storage: "waiting" });
  $("#process-note").textContent = "Splitting text, running BGE on the CPU and writing rows to PostgreSQL.";

  let data;
  try {
    data = await api("/api/process", {
      method: "POST",
      body: JSON.stringify({
        text,
        chunk_size: Number($("#chunk-size").value),
        chunk_overlap: Number($("#chunk-overlap").value),
      }),
    });
  } catch (error) {
    setStages({ chunking: "error" });
    $("#process-note").textContent = "Processing replaces whatever is currently stored in the database.";
    toast("Processing failed", error.message, "error");
    state.busy = false;
    setBusy(button, false);
    $("#search-btn").disabled = false;
    return;
  }

  state.document = data.document;
  state.chunks = data.chunks;
  state.projection = data.projection;
  state.selected = data.chunks[0]?.chunk_id ?? null;

  showChunkSections(true);
  renderChunkMetrics(data);
  renderSource(data.document, data.chunks);
  renderChunkCards(data.chunks, "chunked");
  $("#chunking").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  await wait(450);
  setStage("chunking", "completed");

  setStage("embeddings", "processing");
  renderEmbeddings(data);
  select(state.selected, "process");
  await animateBadges(data.chunks, "embedding", 250);
  await animateBadges(data.chunks, "embedded", 500);
  setStage("embeddings", "completed");

  setStage("storage", "processing");
  try {
    const stored = await api("/api/chunks");
    renderTable(stored.chunks, true);
    await refreshStats();
    await animateBadges(data.chunks, "stored", 400);
    setStage("storage", "completed");
  } catch (error) {
    setStage("storage", "error");
    toast("Could not read the database", error.message, "error");
  }

  renderMap();
  select(state.selected, "process");

  const note = data.duplicate
    ? "This exact document and chunk settings were already stored, so the existing rows were reused instead of embedding again."
    : `${data.chunks.length} chunks embedded in ${fmt(data.timings_ms.embedding)} ms and stored in ${fmt(data.timings_ms.storage)} ms.${data.replaced_rows ? ` Replaced ${data.replaced_rows} previous rows.` : ""}`;
  $("#process-note").textContent = note;
  toast(data.duplicate ? "Already processed" : "Document processed", data.duplicate ? "Loaded the existing vectors from PostgreSQL." : `${data.chunks.length} vectors are now searchable.`);

  state.busy = false;
  setBusy(button, false);
  $("#search-btn").disabled = false;
}

async function runSearch(event) {
  event?.preventDefault();
  if (state.busy) return;
  const query = $("#query-input").value.trim();
  if (!query) {
    toast("Ask something", "Type a question or pick one of the suggestions.", "error");
    $("#query-input").focus();
    return;
  }
  if (!state.chunks.length) {
    toast("Nothing to search", "Process a document first so the database has vectors to compare against.", "error");
    return;
  }

  const button = $("#search-btn");
  const topK = Number($("#top-k").value);
  state.busy = true;
  setBusy(button, true);
  const steps = Object.fromEntries($$("#search-flow li").map((li) => [li.dataset.step, li]));
  for (const li of Object.values(steps)) delete li.dataset.state;
  setStages({ retrieval: "processing", results: "waiting" });

  steps.question.dataset.state = "done";
  $("#sf-question").textContent = `“${query}”`;
  steps.embed.dataset.state = "processing";
  $("#sf-embed").textContent = "Running BGE on the question…";

  let data;
  try {
    data = await api("/api/search", { method: "POST", body: JSON.stringify({ query, top_k: topK }) });
  } catch (error) {
    setStage("retrieval", "error");
    steps.embed.dataset.state = "";
    $("#sf-embed").textContent = "Not generated yet";
    toast("Search failed", error.message, "error");
    state.busy = false;
    setBusy(button, false);
    return;
  }

  steps.embed.dataset.state = "done";
  $("#sf-embed").textContent = `${fmtVec(data.query_embedding, 4)} ${data.query_embedding.length} dims in ${data.timings_ms.query_embedding} ms`;
  await wait(250);
  steps.search.dataset.state = "processing";
  $("#sf-search").textContent = `Comparing with ${data.searched_rows} stored vectors…`;
  await wait(300);
  steps.search.dataset.state = "done";
  $("#sf-search").textContent = `Compared against ${data.searched_rows} vectors in PostgreSQL in ${data.timings_ms.vector_search} ms`;
  steps.matched.dataset.state = "done";
  const best = data.results[0];
  $("#sf-matched").textContent = best
    ? `${data.results.length} chunk${data.results.length === 1 ? "" : "s"} returned, best match chunk ${best.chunk_id} at ${best.similarity.toFixed(3)}`
    : "No rows returned";
  setStage("retrieval", "completed");

  state.lastSearch = data;
  state.projection = data.projection;
  setStage("results", "processing");
  renderResults(data);
  renderMap();
  if (best) select(best.chunk_id, "results");
  $("#results").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  await wait(400);
  setStage("results", "completed");

  state.busy = false;
  setBusy(button, false);
}

function renderResults(data) {
  const list = $("#result-list");
  if (!data.results.length) {
    list.replaceChildren(el("div", { class: "empty", text: "No chunks were returned." }));
    return;
  }
  const cards = data.results.map((r, i) => {
    const fill = el("i");
    const card = el(
      "article",
      {
        class: "result",
        tabindex: "0",
        "data-id": r.chunk_id,
        style: `--chunk: ${chunkColor(r.chunk_id)}; animation-delay: ${reduceMotion ? 0 : i * 90}ms`,
        onclick: () => select(r.chunk_id, "results"),
        onkeydown: (e) => e.key === "Enter" && select(r.chunk_id, "results"),
      },
      [
        el("div", { class: "rank", text: r.rank }),
        el("div", {}, [
          el("div", { class: "result-meta" }, [
            el("span", { class: "chunk-id", text: `chunk ${r.chunk_id}` }),
            el("span", { text: `${r.char_count} chars` }),
            el("span", { class: "score", text: r.similarity.toFixed(4) }),
          ]),
          el("div", { class: "bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "1", "aria-valuenow": r.similarity, "aria-label": "Cosine similarity" }, [fill]),
          el("p", { class: "result-text", text: r.text }),
        ]),
      ],
    );
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, r.similarity))})`;
    }));
    return card;
  });
  list.replaceChildren(...cards);
}

async function resetDatabase() {
  if (state.busy) return;
  if (!window.confirm("Delete every stored chunk and vector from PostgreSQL?")) return;
  const button = $("#reset-btn");
  setBusy(button, true);
  try {
    const data = await api("/api/reset", { method: "DELETE" });
    state.document = null;
    state.chunks = [];
    state.projection = null;
    state.selected = null;
    showChunkSections(false);
    renderTable([]);
    renderDbMetrics(data.stats);
    resetSearchUI();
    renderMap();
    setStages({ document: "waiting", chunking: "waiting", embeddings: "waiting", storage: "waiting" });
    $("#process-note").textContent = "Processing replaces whatever is currently stored in the database.";
    toast("Database cleared", `Deleted ${data.deleted_rows} row${data.deleted_rows === 1 ? "" : "s"} from the chunks table.`);
  } catch (error) {
    toast("Reset failed", error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function loadExisting() {
  const stats = await refreshStats();
  if (!stats.connected || !stats.total_chunks) return;
  try {
    const data = await api("/api/chunks?with_projection=true");
    state.chunks = data.chunks;
    state.projection = data.projection;
    state.selected = data.chunks[0]?.chunk_id ?? null;
    showChunkSections(true);
    renderChunkMetrics({ chunks: data.chunks });
    renderSource(null, data.chunks);
    renderChunkCards(data.chunks, "stored");
    renderEmbeddings({ chunks: data.chunks, model: state.model });
    renderTable(data.chunks);
    renderMap();
    select(state.selected, "load");
    setStages({ document: "completed", chunking: "completed", embeddings: "completed", storage: "completed" });
    $("#process-note").textContent = `${data.chunks.length} chunks from an earlier session are already stored and searchable.`;
  } catch (error) {
    toast("Could not load stored chunks", error.message, "error");
  }
}

function init() {
  $("#doc-input").addEventListener("input", updateCharCount);
  $("#sample-btn").addEventListener("click", () => {
    $("#doc-input").value = SAMPLE_DOCUMENT;
    updateCharCount();
  });
  $("#clear-btn").addEventListener("click", () => {
    $("#doc-input").value = "";
    updateCharCount();
    $("#doc-input").focus();
  });
  $("#chunk-size").addEventListener("input", syncSliders);
  $("#chunk-overlap").addEventListener("input", syncSliders);
  $("#top-k").addEventListener("input", (e) => ($("#topk-out").textContent = e.target.value));
  $("#process-btn").addEventListener("click", processDocument);
  $("#search-form").addEventListener("submit", runSearch);
  $("#reset-btn").addEventListener("click", resetDatabase);
  $("#suggestions").replaceChildren(
    ...SUGGESTIONS.map((q) =>
      el("button", { class: "chip", type: "button", text: q, onclick: () => { $("#query-input").value = q; runSearch(); } }),
    ),
  );
  syncSliders();
  updateCharCount();
  refreshHealth().then(loadExisting);
}

init();
