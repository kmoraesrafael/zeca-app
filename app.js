import { detect, loadModel } from "./detector.js";
import { sendSubmission } from "./submission.js";

// Limita o tamanho em memória; os ovos continuam com dezenas de pixels de diâmetro nessa resolução.
const MAX_SIDE = 3000;
const MAX_ZOOM = 15;
// pequeno o bastante para o ovo continuar visível em volta do ponto (importante para conferir a pré-contagem)
const MARK_RADIUS = 2.5;
const MARK_OUTLINE = 1;
const TOUCH_TOLERANCE = 24;
const TAP_SLOP = 10;

const $ = (id) => document.getElementById(id);

const state = {
  /** @type {HTMLCanvasElement | null} foto já rotacionada; as marcações são em pixels dela */
  photo: null,
  source: "",
  /** @type {{x: number, y: number}[]} */
  marks: [],
  /** @type {"add" | "remove" | null} */
  mode: null,
  /** @type {{version: string, count: number} | null} o que o modelo contou, antes das correções */
  prediction: null,
  detecting: false,
  sending: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
};

// ---------- carregar a foto ----------

/** Decodifica a foto já rotacionada conforme o EXIF (o navegador faz isso), reduzindo para no máximo MAX_SIDE. */
async function decodePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (!longest) throw new Error("formato de imagem não suportado");
    const scale = Math.min(1, MAX_SIDE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (e) {
    throw new Error(e?.name === "EncodingError" ? "formato de imagem não suportado" : e.message);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function onFilePicked(input, source) {
  const file = input.files?.[0];
  input.value = ""; // permite escolher a mesma foto de novo
  if (!file) return;
  setHomeBusy(true);
  showHomeError(null);
  let photo;
  try {
    photo = await decodePhoto(file);
  } catch (e) {
    showHomeError(`Não foi possível abrir a imagem: ${e.message}`);
    return;
  } finally {
    setHomeBusy(false);
  }
  openAnnotation(photo, source);
  autoCount(photo);
}

/** Pré-marca os ovos com o modelo; o usuário depois corrige com + e −. */
async function autoCount(photo) {
  state.detecting = true;
  render();
  try {
    const points = await detect(photo);
    const { version } = await loadModel();
    if (state.photo === photo) {
      state.marks = points;
      // cópia do "antes": state.marks muda a cada correção
      state.prediction = { version, count: points.length, points: points.map((p) => [p.x, p.y]) };
    }
  } catch (e) {
    console.error("falha na contagem automática", e);
  } finally {
    if (state.photo === photo) state.detecting = false;
    render();
  }
}

// ---------- telas ----------

function setHomeBusy(busy) {
  $("home-loading").hidden = !busy;
  document.querySelectorAll(".source").forEach((el) => el.classList.toggle("disabled", busy));
}

function showHomeError(message) {
  $("home-error").hidden = !message;
  $("home-error").textContent = message ?? "";
}

function openAnnotation(photo, source) {
  Object.assign(state, {
    photo,
    source,
    marks: [],
    mode: null,
    prediction: null,
    detecting: false,
    sending: false,
    zoom: 1,
    pan: { x: 0, y: 0 },
  });
  $("home").hidden = true;
  $("annotate").hidden = false;
  // o botão/gesto "voltar" do aparelho passa a pedir confirmação em vez de sair do app
  history.pushState({ zeca: "annotate" }, "");
  resizeCanvas();
}

/** @param {boolean} fromHistory true quando o "voltar" do navegador já tirou a tela do histórico */
function discard(fromHistory = false) {
  state.photo = null;
  state.marks = [];
  state.detecting = false;
  $("annotate").hidden = true;
  $("home").hidden = false;
  closeDialog();
  if (!fromHistory && history.state?.zeca === "annotate") history.back();
}

function onCancel(fromHistory = false) {
  if (state.marks.length === 0) return discard(fromHistory);
  if (fromHistory) history.pushState({ zeca: "annotate" }, "");
  showDialog({
    title: "Descartar marcações?",
    body: `As ${state.marks.length} marcações desta foto serão perdidas.`,
    buttons: [
      { label: "Continuar marcando", onClick: closeDialog },
      { label: "Descartar", onClick: () => discard() },
    ],
  });
}

// a página foi recarregada no meio de uma marcação: a foto se perdeu, então a entrada do histórico também
if (history.state?.zeca) history.replaceState(null, "");

window.addEventListener("popstate", () => {
  if (!$("tutorial").hidden) {
    $("tutorial").hidden = true;
    return;
  }
  if (!$("annotate").hidden && !state.sending) onCancel(true);
});

// O tutorial abre por cima da tela atual e entra no histórico, então o "voltar" do aparelho o fecha
// sem mexer na marcação que estiver aberta embaixo.
function openTutorial() {
  $("tutorial").hidden = false;
  $("tutorial-body").scrollTop = 0;
  history.pushState({ zeca: "tutorial" }, "");
}

function closeTutorial() {
  if (history.state?.zeca === "tutorial") history.back(); // o popstate esconde a tela
  else $("tutorial").hidden = true;
}

function toggleMode(target) {
  state.mode = state.mode === target ? null : target;
  render();
}

async function send() {
  if (!state.photo || state.sending) return;
  const { photo, source, prediction } = state;
  const points = [...state.marks];
  state.sending = true;
  render();
  showDialog({ title: "Enviando…", body: '<div class="progress"></div>', html: true, dismissable: false });
  try {
    await sendSubmission(photo, points, source, prediction);
    showDialog({
      title: "Contagem enviada",
      body: `${points.length} ovos registrados. Obrigado por contribuir com o treinamento!`,
      buttons: [{ label: "Nova foto", onClick: () => discard() }],
      onDismiss: () => discard(),
    });
  } catch (e) {
    showDialog({
      title: "Falha ao enviar",
      body: `${e.message}\n\nConfira a conexão com a internet e tente de novo. Suas marcações foram mantidas.`,
      buttons: [{ label: "OK", onClick: closeDialog }],
    });
  } finally {
    state.sending = false;
    render();
  }
}

// ---------- diálogo ----------

const dialog = $("dialog");
let dialogOptions = null;

function showDialog(options) {
  dialogOptions = options;
  $("dialog-title").textContent = options.title;
  if (options.html) $("dialog-body").innerHTML = options.body;
  else $("dialog-body").textContent = options.body;
  $("dialog-buttons").replaceChildren(
    ...(options.buttons ?? []).map(({ label, onClick }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    }),
  );
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  dialogOptions = null;
  if (dialog.open) dialog.close();
}

dialog.addEventListener("cancel", (e) => {
  e.preventDefault(); // Esc / voltar
  if (dialogOptions?.dismissable === false) return;
  (dialogOptions?.onDismiss ?? closeDialog)();
});
dialog.addEventListener("click", (e) => {
  // toque fora da caixa
  if (e.target !== dialog || dialogOptions?.dismissable === false) return;
  const r = dialog.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) (dialogOptions?.onDismiss ?? closeDialog)();
});

// ---------- foto com zoom/arraste e marcações por cima ----------
// As marcações ficam em coordenadas de pixel da foto, então não dependem do zoom nem do tamanho da tela.

const canvas = $("canvas");
const ctx = canvas.getContext("2d");
let box = { width: 0, height: 0 };

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  box = { width: rect.width, height: rect.height };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  state.pan = clampPan(state.pan, state.zoom);
  render();
}
new ResizeObserver(() => !$("annotate").hidden && resizeCanvas()).observe(canvas);

function baseScale() {
  const p = state.photo;
  if (!p || !box.width) return 1;
  return Math.min(box.width / p.width, box.height / p.height);
}

function imageToScreen(p) {
  const s = baseScale() * state.zoom;
  return {
    x: box.width / 2 + state.pan.x + (p.x - state.photo.width / 2) * s,
    y: box.height / 2 + state.pan.y + (p.y - state.photo.height / 2) * s,
  };
}

function screenToImage(p) {
  const s = baseScale() * state.zoom;
  return {
    x: (p.x - box.width / 2 - state.pan.x) / s + state.photo.width / 2,
    y: (p.y - box.height / 2 - state.pan.y) / s + state.photo.height / 2,
  };
}

function clampPan(pan, zoom) {
  if (!state.photo) return pan;
  const s = baseScale() * zoom;
  const maxX = Math.max(0, (state.photo.width * s - box.width) / 2);
  const maxY = Math.max(0, (state.photo.height * s - box.height) / 2);
  return { x: Math.min(maxX, Math.max(-maxX, pan.x)), y: Math.min(maxY, Math.max(-maxY, pan.y)) };
}

/** Zoom mantendo fixo o ponto da foto que estava em `center` (em px da tela), mais um arraste opcional. */
function zoomAround(center, factor, panChange = { x: 0, y: 0 }) {
  const newZoom = Math.min(MAX_ZOOM, Math.max(1, state.zoom * factor));
  const f = newZoom / state.zoom;
  const c = { x: center.x - box.width / 2, y: center.y - box.height / 2 };
  const prev = { x: c.x - panChange.x, y: c.y - panChange.y };
  state.pan = clampPan({ x: c.x - (prev.x - state.pan.x) * f, y: c.y - (prev.y - state.pan.y) * f }, newZoom);
  state.zoom = newZoom;
  render();
}

let frame = 0;
function render() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(draw);
  updateControls();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const photo = state.photo;
  if (!photo) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const s = baseScale() * state.zoom;
  const topLeft = imageToScreen({ x: 0, y: 0 });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = state.zoom > 4 ? "low" : "medium";
  ctx.drawImage(photo, topLeft.x, topLeft.y, photo.width * s, photo.height * s);

  const outer = new Path2D();
  const inner = new Path2D();
  for (const m of state.marks) {
    const p = imageToScreen(m);
    if (p.x < -10 || p.y < -10 || p.x > box.width + 10 || p.y > box.height + 10) continue;
    outer.moveTo(p.x + MARK_RADIUS + MARK_OUTLINE, p.y);
    outer.arc(p.x, p.y, MARK_RADIUS + MARK_OUTLINE, 0, 2 * Math.PI);
    inner.moveTo(p.x + MARK_RADIUS, p.y);
    inner.arc(p.x, p.y, MARK_RADIUS, 0, 2 * Math.PI);
  }
  ctx.fillStyle = "#1f1b8c";
  ctx.fill(outer);
  ctx.fillStyle = "#1fc290";
  ctx.fill(inner);
}

function updateControls() {
  $("count").textContent = String(state.marks.length);
  $("counting").hidden = !state.detecting;
  $("send").disabled = state.sending;
  for (const [id, mode] of [["mode-add", "add"], ["mode-remove", "remove"]]) {
    $(id).setAttribute("aria-pressed", String(state.mode === mode));
  }
  $("hint").textContent =
    state.mode === "add"
      ? "Adicionar: toque em cada ovo"
      : state.mode === "remove"
        ? "Remover: toque numa marcação para apagá-la"
        : state.prediction
          ? `Z.E.C.A marcou ${state.prediction.count} ovos. Confira e corrija com + e −.`
          : "Escolha + ou − para marcar. Use dois dedos para zoom.";
}

function onTap(screen) {
  if (!state.photo || state.detecting) return;
  const p = screenToImage(screen);
  if (state.mode === "add") {
    const inside = p.x >= 0 && p.x <= state.photo.width && p.y >= 0 && p.y <= state.photo.height;
    if (inside) {
      state.marks.push(p);
      pulseCount("added");
    }
  } else if (state.mode === "remove") {
    // remove a marcação mais próxima, desde que esteja perto o bastante do toque
    const tolerance = TOUCH_TOLERANCE / (baseScale() * state.zoom);
    let best = -1;
    let bestDist = Infinity;
    state.marks.forEach((m, i) => {
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (d < bestDist) [best, bestDist] = [i, d];
    });
    if (best >= 0 && bestDist <= tolerance) {
      state.marks.splice(best, 1);
      pulseCount("removed");
    }
  }
  render();
}

/** Destaque rápido no selo da contagem (style.css), para o usuário ver que o número mudou. */
function pulseCount(kind) {
  const pill = $("count-pill");
  pill.classList.remove("added", "removed");
  void pill.offsetWidth; // reinicia a animação mesmo se for igual à anterior
  pill.classList.add(kind);
}

// gestos: um dedo arrasta (ou toca), dois dedos fazem zoom; no computador, a roda do mouse faz zoom
const pointers = new Map();
let gesture = null;

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function centroidAndSpread() {
  const pts = [...pointers.values()];
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  const spread = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  return { c, spread };
}

canvas.addEventListener("pointerdown", (e) => {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // ponteiro já liberado; segue sem captura
  }
  pointers.set(e.pointerId, localPoint(e));
  const { c, spread } = centroidAndSpread();
  if (pointers.size === 1) gesture = { start: c, moved: false, multi: false, last: c, spread };
  else if (gesture) Object.assign(gesture, { multi: true, last: c, spread });
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, localPoint(e));
  const { c, spread } = centroidAndSpread();
  if (!gesture.moved && Math.hypot(c.x - gesture.start.x, c.y - gesture.start.y) > TAP_SLOP) gesture.moved = true;
  if (gesture.moved || gesture.multi) {
    const factor = pointers.size > 1 && gesture.spread > 0 ? spread / gesture.spread : 1;
    zoomAround(c, factor, { x: c.x - gesture.last.x, y: c.y - gesture.last.y });
  }
  gesture.last = c;
  gesture.spread = spread;
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (gesture && !gesture.moved && !gesture.multi && e.type === "pointerup") onTap(localPoint(e));
    gesture = null;
  } else if (gesture) {
    // um dedo saiu do zoom: continua arrastando com o outro, sem pular
    const { c, spread } = centroidAndSpread();
    gesture.last = c;
    gesture.spread = spread;
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAround(localPoint(e), Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
  },
  { passive: false },
);
// Safari do iPhone: impede o zoom da página inteira com pinça
document.addEventListener("gesturestart", (e) => e.preventDefault());

// ---------- ligações ----------

// a animação de abertura (style.css) some sozinha; um toque pula
const splash = $("splash");
splash.querySelector(".splash-flash").addEventListener("animationend", () => splash.remove());
splash.addEventListener("click", () => splash.remove());

$("pick-camera").addEventListener("change", (e) => onFilePicked(e.target, "camera"));
$("pick-gallery").addEventListener("change", (e) => onFilePicked(e.target, "galeria"));
$("cancel").addEventListener("click", () => onCancel());
$("mode-add").addEventListener("click", () => toggleMode("add"));
$("mode-remove").addEventListener("click", () => toggleMode("remove"));
$("send").addEventListener("click", send);
$("open-tutorial").addEventListener("click", openTutorial);
$("help").addEventListener("click", openTutorial);
$("tutorial-back").addEventListener("click", closeTutorial);
$("tutorial-done").addEventListener("click", closeTutorial);

// baixa o modelo já na abertura, para a primeira contagem ser rápida
loadModel().then(
  // "release" é o número curto (x.y.z) cujo último dígito training/train.py aumenta a cada treino
  ({ version, config }) => ($("model-info").textContent = `Versão do Modelo ${config.release ?? version}`),
  (e) => {
    console.error("falha ao carregar o modelo", e);
    $("model-info").textContent = "modelo indisponível (sem internet?) — a contagem será manual";
  },
);

// funciona offline e se atualiza sozinho (ver sw.js)
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("service worker não registrado", e));
}
