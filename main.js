const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer,
  clipboard, safeStorage, Tray, Menu, nativeImage, Notification, systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const MiniSearch = require('minisearch');

// ---------- Config ----------
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
// Basic web search tool. If the API ever rejects this version, check docs.claude.com for the current one.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULTS = {
  provider: 'gemini', // 'gemini' (free tier available) or 'claude'
  geminiModel: 'gemini-3.8-flash',
  claudeModel: 'claude-sonnet-5-5',
  snipHotkey: 'CommandOrControl+Alt+X',
  panelHotkey: 'CommandOrControl+Alt+Z',
};

const EXTRACT_SYSTEM =
  'You are a transcription engine. Transcribe all text visible in the image exactly, in reading order. ' +
  'Output clean Markdown: keep headings and lists, render tables as Markdown tables, and write math as LaTeX ' +
  '($...$ inline, $$...$$ for display). Rejoin words hyphenated across line breaks and join lines that belong to ' +
  'the same paragraph. Fix obvious ligature or encoding artefacts (for example "ﬁ" becomes "fi"). ' +
  'If part of the image is a figure with no text, add a one-line description in [square brackets]. ' +
  'Output only the transcription, with no commentary.';
const SUMMARY_SYSTEM =
  'Summarize the user\'s text faithfully. Give 3 to 5 short bullet points, then one sentence starting with "Takeaway:". ' +
  'Do not add facts that are not in the text.';
const ASK_SYSTEM =
  'Answer the question using the provided snipped text as the main context. Be concise and direct. ' +
  'If you search the web, say what you found and keep citations light.';

// ---------- Storage ----------
let userDir;
const settingsFile = () => path.join(userDir, 'settings.json');
const libraryFile = () => path.join(userDir, 'library.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function decryptField(raw, name) {
  try {
    if (raw[name + 'Enc'] && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(raw[name + 'Enc'], 'base64'));
    }
    return raw[name + 'Plain'] || '';
  } catch { return ''; }
}

function encryptField(raw, name, value) {
  if (safeStorage.isEncryptionAvailable()) {
    raw[name + 'Enc'] = safeStorage.encryptString(value).toString('base64');
    delete raw[name + 'Plain'];
  } else {
    raw[name + 'Plain'] = value;
  }
}

function getSettings() {
  const raw = readJson(settingsFile(), {});
  return {
    ...DEFAULTS,
    ...raw,
    geminiKey: decryptField(raw, 'geminiKey'),
    claudeKey: decryptField(raw, 'claudeKey'),
  };
}

function saveSettings({ provider, geminiKey, claudeKey, geminiModel, claudeModel }) {
  const raw = readJson(settingsFile(), {});
  if (provider === 'gemini' || provider === 'claude') raw.provider = provider;
  if (typeof geminiModel === 'string' && geminiModel.trim()) raw.geminiModel = geminiModel.trim();
  if (typeof claudeModel === 'string' && claudeModel.trim()) raw.claudeModel = claudeModel.trim();
  if (typeof geminiKey === 'string' && geminiKey.trim()) encryptField(raw, 'geminiKey', geminiKey.trim());
  if (typeof claudeKey === 'string' && claudeKey.trim()) encryptField(raw, 'claudeKey', claudeKey.trim());
  writeJson(settingsFile(), raw);
}

// ---------- Library + search ----------
let library = [];
let index;

function buildIndex() {
  index = new MiniSearch({
    fields: ['text', 'title'],
    storeFields: ['id'],
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2 } },
  });
  index.addAll(library);
}

function loadLibrary() {
  library = readJson(libraryFile(), []);
  buildIndex();
}

function addToLibrary(text) {
  const entry = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    title: text.replace(/\s+/g, ' ').trim().slice(0, 70) || '(empty snip)',
    text,
    summary: '',
  };
  library.unshift(entry);
  index.add(entry);
  writeJson(libraryFile(), library);
  return entry;
}

function slim(e) {
  return { id: e.id, ts: e.ts, title: e.title };
}

// ---------- Claude API ----------
async function callAnthropic({ system, content, webSearch = false, maxTokens = 2500 }) {
  const { claudeKey: apiKey, claudeModel: model } = getSettings();
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');

  const messages = [{ role: 'user', content }];
  let text = '';
  const sources = [];

  for (let turn = 0; turn < 3; turn++) {
    const body = { model, max_tokens: maxTokens, system, messages };
    if (webSearch) body.tools = [WEB_SEARCH_TOOL];

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `API error ${res.status}`);

    for (const block of data.content || []) {
      if (block.type !== 'text') continue;
      text += block.text;
      for (const c of block.citations || []) {
        if (c.url && !sources.some((s) => s.url === c.url)) sources.push({ url: c.url, title: c.title || c.url });
      }
    }
    // Server-side tools can pause a long turn; continue it.
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    break;
  }
  return { text: text.trim(), sources };
}

async function callGemini({ system, content, webSearch = false, maxTokens = 2500 }) {
  const { geminiKey, geminiModel } = getSettings();
  if (!geminiKey) throw new Error('Add your Gemini API key in Settings first (free at aistudio.google.com/apikey).');

  // Content arrives in Claude block format; convert to Gemini parts.
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const parts = blocks.map((b) =>
    b.type === 'image'
      ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
      : { text: b.text }
  );
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    // Gemini 2.5+ counts thinking tokens against this limit, so leave generous room.
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 8192) },
  };
  if (webSearch) body.tools = [{ google_search: {} }];

  const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(geminiModel)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error('Free-tier limit reached. Wait a minute and try again.');
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);

  const cand = data.candidates?.[0];
  if (!cand) {
    const why = data.promptFeedback?.blockReason;
    throw new Error(why ? `Gemini blocked this request (${why}).` : 'Gemini returned no answer.');
  }
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  if (!text) {
    throw new Error(cand.finishReason === 'MAX_TOKENS'
      ? 'The model ran out of output space. Try a smaller snip.'
      : 'Gemini returned an empty answer.');
  }
  const sources = [];
  for (const chunk of cand.groundingMetadata?.groundingChunks || []) {
    const w = chunk.web;
    if (w?.uri && !sources.some((x) => x.url === w.uri)) sources.push({ url: w.uri, title: w.title || w.uri });
  }
  return { text, sources };
}

function callModel(opts) {
  return getSettings().provider === 'claude' ? callAnthropic(opts) : callGemini(opts);
}

function imageBlock(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error('Unsupported image data.');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

async function extractFromImage(dataUrl) {
  const { text } = await callModel({
    system: EXTRACT_SYSTEM,
    content: [imageBlock(dataUrl), { type: 'text', text: 'Transcribe this.' }],
    maxTokens: 4000,
  });
  return text;
}

// ---------- Windows ----------
let panel = null;
let selector = null;
let tray = null;
let snipping = false;

function createPanel() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 460, h = 640;
  panel = new BrowserWindow({
    width: w,
    height: h,
    x: workArea.x + workArea.width - w - 24,
    y: workArea.y + workArea.height - h - 24,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  // Keeps the panel out of screen recordings and screenshots where the OS supports it.
  panel.setContentProtection(true);
  panel.loadFile('panel.html');
  panel.on('closed', () => { panel = null; });
}

function showPanel() {
  if (!panel) createPanel();
  panel.show();
  panel.focus();
}

function togglePanel() {
  if (panel && panel.isVisible()) panel.hide();
  else showPanel();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startSnip() {
  if (snipping) return;
  snipping = true;
  try {
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status !== 'granted') {
        new Notification({
          title: 'Screen recording permission needed',
          body: 'Allow Snipsearch under System Settings > Privacy & Security > Screen Recording, then restart it.',
        }).show();
      }
    }

    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const sf = display.scaleFactor || 1;

    if (panel && panel.isVisible()) { panel.hide(); await sleep(150); }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('Could not capture the screen. Check screen recording permission.');

    const shot = src.thumbnail.toDataURL();

    selector = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    selector.setAlwaysOnTop(true, 'screen-saver');
    selector.on('closed', () => { selector = null; snipping = false; });
    await selector.loadFile('selector.html');
    selector.webContents.send('snip:shot', shot);
    selector.show();
    selector.focus();
  } catch (err) {
    snipping = false;
    showPanel();
    panel.webContents.send('job:error', err.message);
  }
}

function closeSelector() {
  if (selector) { selector.close(); }
  snipping = false;
}

async function runExtract(dataUrl) {
  showPanel();
  const send = (ch, payload) => panel && !panel.isDestroyed() && panel.webContents.send(ch, payload);
  send('job:start', { preview: dataUrl });
  try {
    const text = await extractFromImage(dataUrl);
    clipboard.writeText(text);
    const entry = addToLibrary(text);
    send('job:done', { id: entry.id, text, copied: true });
  } catch (err) {
    send('job:error', err.message);
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on('snip:done', async (_e, dataUrl) => {
    closeSelector();
    await runExtract(dataUrl);
  });
  ipcMain.on('snip:cancel', () => { closeSelector(); showPanel(); });
  ipcMain.on('snip:start', () => startSnip());
  ipcMain.on('panel:hide', () => panel && panel.hide());

  ipcMain.handle('image:extract', async (_e, dataUrl) => { await runExtract(dataUrl); return true; });

  ipcMain.handle('settings:get', () => {
    const s = getSettings();
    return {
      provider: s.provider,
      hasGeminiKey: Boolean(s.geminiKey),
      hasClaudeKey: Boolean(s.claudeKey),
      geminiModel: s.geminiModel,
      claudeModel: s.claudeModel,
      snipHotkey: s.snipHotkey,
      panelHotkey: s.panelHotkey,
    };
  });
  ipcMain.handle('settings:set', (_e, payload) => { saveSettings(payload || {}); return true; });

  ipcMain.handle('action:summarize', async (_e, { id, text }) => {
    const { text: out } = await callModel({ system: SUMMARY_SYSTEM, content: text, maxTokens: 800 });
    const entry = library.find((x) => x.id === id);
    if (entry) { entry.summary = out; writeJson(libraryFile(), library); }
    return out;
  });

  ipcMain.handle('action:ask', async (_e, { text, question, web }) => {
    const content = `Snipped text:\n"""\n${text}\n"""\n\nQuestion: ${question}`;
    return callModel({ system: ASK_SYSTEM, content, webSearch: Boolean(web), maxTokens: 1500 });
  });

  ipcMain.handle('library:list', () => library.slice(0, 100).map(slim));
  ipcMain.handle('library:search', (_e, q) => {
    const query = String(q || '').trim();
    if (!query) return library.slice(0, 100).map(slim);
    const ids = new Set(index.search(query).map((r) => r.id));
    return library.filter((e) => ids.has(e.id)).map(slim);
  });
  ipcMain.handle('library:get', (_e, id) => library.find((e) => e.id === id) || null);
  ipcMain.handle('library:delete', (_e, id) => {
    const i = library.findIndex((e) => e.id === id);
    if (i >= 0) {
      library.splice(i, 1);
      writeJson(libraryFile(), library);
      buildIndex();
    }
    return true;
  });

  ipcMain.handle('clipboard:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
}

// ---------- App lifecycle ----------
function registerHotkeys() {
  const { snipHotkey, panelHotkey } = getSettings();
  globalShortcut.unregisterAll();
  const ok1 = globalShortcut.register(snipHotkey, startSnip);
  const ok2 = globalShortcut.register(panelHotkey, togglePanel);
  if (!ok1 || !ok2) {
    new Notification({
      title: 'Hotkey unavailable',
      body: 'Another app is using one of the hotkeys. Edit snipHotkey / panelHotkey in settings.json in the app data folder.',
    }).show();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Snipsearch');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New snip', click: startSnip },
    { label: 'Show / hide panel', click: togglePanel },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', togglePanel);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showPanel);
  app.whenReady().then(() => {
    userDir = app.getPath('userData');
    loadLibrary();
    registerIpc();
    registerHotkeys();
    createTray();
    createPanel();
    panel.once('ready-to-show', () => panel.show());
    if (process.platform === 'darwin') app.dock.hide();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Stay alive in the tray when windows close.
  app.on('window-all-closed', (e) => e.preventDefault());
}
