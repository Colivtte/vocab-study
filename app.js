const STORAGE_KEY = 'shici-local-v1';
const INTERVAL_DAYS = [1, 2, 4, 7, 15, 30];
const POS_LABELS = { n: '名词', v: '动词', adj: '形容词', adv: '副词', prep: '介词', pron: '代词', conj: '连词', interj: '感叹词', phr: '词组' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function blankState() {
  return { version: 1, vocabs: [], entries: [], daily: {}, settings: { dailyGoal: 20, apiBase: '', apiModel: '', apiKey: '' } };
}

function readState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && parsed.version === 1 && Array.isArray(parsed.vocabs) && Array.isArray(parsed.entries)) {
      return { ...blankState(), ...parsed, settings: { ...blankState().settings, ...parsed.settings } };
    }
  } catch { /* Invalid local data should not prevent the app from opening. */ }
  return blankState();
}

let state = readState();
let pendingFileText = '';
let pendingParsed = [];
let session = null;
let activeMenu = null;
let toastTimer = null;

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    showToast('本机存储空间不足，请先导出备份或减少词库内容');
    return false;
  }
}

function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function normalize(value = '') { return value.trim().toLocaleLowerCase(); }
function findVocab(id) { return state.vocabs.find((vocab) => vocab.id === id); }
function vocabEntries(id) { return state.entries.filter((entry) => entry.vocabId === id); }
function reviewable(entry) { return entry.generation === 'ready' && entry.example && entry.translation && entry.distractors?.length === 3; }
function seen(entry) { return Number(entry.reviewCount || 0) > 0; }
function dueEntries() { const now = Date.now(); return state.entries.filter((entry) => seen(entry) && reviewable(entry) && Number(entry.dueAt || Infinity) <= now); }
function newEntries() { return state.entries.filter((entry) => !seen(entry) && reviewable(entry)); }
function vocabProgress(vocabId) {
  const entries = vocabEntries(vocabId);
  const mastered = entries.filter((entry) => Number(entry.intervalIndex ?? -1) >= 3).length;
  const studied = entries.filter(seen).length;
  return { entries, mastered, studied, rate: entries.length ? Math.round(mastered / entries.length * 100) : 0 };
}

function dailyStats(key = localDate()) { return state.daily[key] || { newWords: 0, reviews: 0, correct: 0, answers: 0 }; }

function studyDates() { return Object.keys(state.daily).filter((date) => ((state.daily[date].newWords || 0) + (state.daily[date].reviews || 0)) > 0).sort(); }

function streakCount() {
  const dates = new Set(studyDates());
  const cursor = new Date();
  if (!dates.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (dates.has(localDate(cursor))) { count += 1; cursor.setDate(cursor.getDate() - 1); }
  return count;
}

function overallMastery() {
  const learned = state.entries.filter(seen);
  return { count: learned.filter((entry) => Number(entry.intervalIndex ?? -1) >= 3).length, total: learned.length };
}

function showToast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2700);
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  if (!$('.modal-backdrop.is-open')) document.body.style.overflow = '';
}

function setView(name) {
  $$('.page').forEach((page) => page.classList.toggle('is-visible', page.id === `${name}Page`));
  $$('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === name));
  if (name === 'today') renderToday();
  if (name === 'library') renderLibrary();
  if (name === 'progress') renderProgress();
  if (name === 'settings') renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateSessionCounts() {
  const due = dueEntries().length;
  const fresh = Math.min(newEntries().length, Number(state.settings.dailyGoal) || 20);
  $('#reviewAvailable').textContent = due ? `${due} 个单词已到复习时间` : '目前没有到期词';
  $('#newAvailable').textContent = fresh ? `${newEntries().length} 个可学习，今日目标 ${state.settings.dailyGoal} 个` : (state.vocabs.length ? '当前没有可学新词' : '先导入一个词库开始');
  $('#reviewCount').max = String(due);
  $('#newCount').max = String(fresh);
  $('#reviewCount').value = String(Math.min(Number($('#reviewCount').value) || 0, due));
  $('#newCount').value = String(Math.min(Number($('#newCount').value) || 0, fresh));
  const total = Number($('#reviewCount').value) + Number($('#newCount').value);
  $('#planTotal').textContent = `本轮 ${total} 个单词`;
  $('#startSession').disabled = total < 1 || (!$('#includeReview').checked && !$('#includeNew').checked);
  $('#reviewCount').disabled = !$('#includeReview').checked;
  $('#newCount').disabled = !$('#includeNew').checked;
}

function collectionRow(vocab, compact = false) {
  const progress = vocabProgress(vocab.id);
  const pending = progress.entries.filter((entry) => entry.generation !== 'ready').length;
  const desc = pending ? `${progress.entries.length} 个词 · ${pending} 个待生成` : `${progress.entries.length} 个词 · 已学习 ${progress.studied} 个`;
  return `<div class="collection-row" data-open-vocab="${escapeHtml(vocab.id)}"><span class="collection-icon">字</span><span class="collection-meta"><strong>${escapeHtml(vocab.name)}</strong><small>${desc}</small></span>${compact ? `<span class="collection-progress"><span>${progress.rate}%</span><i class="mini-track"><i style="width:${progress.rate}%"></i></i></span>` : `<span class="nav-count">→</span>`}</div>`;
}

function renderToday() {
  const today = new Date();
  $('#todayDate').textContent = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' }).format(today).toUpperCase();
  $('#dateLabel').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(today);
  const due = dueEntries().length;
  const fresh = newEntries().length;
  $('#dueCaption').textContent = due ? `${due} 个单词已到复习时间` : (fresh ? '没有到期复习词，可以开始学习新词' : '今天的安排已经准备好');
  const stats = dailyStats();
  $('#todayReviewStat').textContent = stats.reviews || 0;
  $('#todayNewStat').textContent = stats.newWords || 0;
  $('#streakNumber').textContent = streakCount();
  const mastery = overallMastery();
  const rate = mastery.total ? Math.round(mastery.count / mastery.total * 100) : 0;
  $('#masteryPercent').textContent = `${rate}%`;
  $('#masteryBar').style.width = `${rate}%`;
  $('#masteryDetail').textContent = mastery.total ? `${mastery.count} 个词进入 7 天以上复习阶段` : '完成几轮复习后，这里会显示掌握进度';
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const start = new Date(); start.setDate(start.getDate() - 6);
  const dates = new Set(studyDates());
  $('#weekDots').innerHTML = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const key = localDate(date);
    return `<span class="week-dot ${dates.has(key) ? 'is-done' : ''} ${key === localDate() ? 'is-today' : ''}"><i></i>${weekdays[date.getDay()]}</span>`;
  }).join('');
  const vocabs = state.vocabs.slice(0, 4);
  $('#todayCollections').innerHTML = vocabs.length ? vocabs.map((vocab) => collectionRow(vocab, true)).join('') : '<div class="empty-inline">还没有词库，导入自己的词表就可以开始。</div>';
  $('#libraryCount').textContent = String(state.vocabs.length);
  updateSessionCounts();
}

function renderLibrary(query = $('#librarySearch').value) {
  const term = normalize(query || '');
  const matches = state.vocabs.filter((vocab) => normalize(vocab.name).includes(term) || vocabEntries(vocab.id).some((entry) => normalize(entry.term).includes(term)));
  const total = state.entries.length;
  $('#librarySummary').textContent = `${state.vocabs.length} 个词库 · ${total} 个单词`;
  $('#libraryGrid').innerHTML = matches.length ? matches.map((vocab) => {
    const info = vocabProgress(vocab.id);
    const failed = info.entries.filter((entry) => entry.generation === 'failed').length;
    const added = new Date(vocab.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
    return `<article class="library-card" data-open-vocab="${escapeHtml(vocab.id)}"><div class="library-card-top"><span class="collection-icon">字</span><div class="library-card-title"><h3>${escapeHtml(vocab.name)}</h3><small>${added} 创建</small></div><button class="more-button" data-menu-vocab="${escapeHtml(vocab.id)}" aria-label="词库选项">···</button></div><div class="library-card-stats"><span><strong>${info.entries.length}</strong> 个单词</span><span><strong>${info.studied}</strong> 个已学习</span>${failed ? `<span><strong>${failed}</strong> 个待重试</span>` : ''}</div><i class="mini-track"><i style="width:${info.rate}%"></i></i><div class="library-card-foot"><span>掌握率 ${info.rate}%</span><button data-open-vocab="${escapeHtml(vocab.id)}">查看词条 →</button></div></article>`;
  }).join('') : `<div class="empty-state"><span class="empty-state-mark">＋</span><h3>${term ? '没有找到匹配的词库' : '先建一个自己的词库'}</h3><p>${term ? '试试换一个单词或词库名称。' : '导入 TXT 或 DOCX 词表，开始一轮专属学习。'}</p>${term ? '' : '<button class="primary-button" id="emptyImport"><span>导入词表</span><b>→</b></button>'}</div>`;
  $('#libraryCount').textContent = String(state.vocabs.length);
}

function renderProgress() {
  const stats = dailyStats();
  const mastery = overallMastery();
  $('#progressNew').textContent = stats.newWords || 0;
  $('#progressReview').textContent = stats.reviews || 0;
  $('#progressMastery').textContent = `${mastery.total ? Math.round(mastery.count / mastery.total * 100) : 0}%`;
  $('#progressStreak').textContent = streakCount();
  $('#progressMonth').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date());
  $('#progressCollections').innerHTML = state.vocabs.length ? state.vocabs.map((vocab) => {
    const progress = vocabProgress(vocab.id);
    return `<div class="progress-collection-row"><strong>${escapeHtml(vocab.name)}</strong><i class="mini-track"><i style="width:${progress.rate}%"></i></i><span>${progress.mastered}/${progress.entries.length}</span></div>`;
  }).join('') : '<div class="empty-inline">导入词库后会显示各词库的掌握进度。</div>';
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - (6 - index)); return date; });
  const max = Math.max(1, ...days.map((date) => { const item = dailyStats(localDate(date)); return (item.newWords || 0) + (item.reviews || 0); }));
  const labels = ['日', '一', '二', '三', '四', '五', '六'];
  $('#weeklyChart').innerHTML = days.map((date) => {
    const item = dailyStats(localDate(date));
    const newHeight = Math.max(item.newWords ? 4 : 2, Math.round((item.newWords || 0) / max * 125));
    const reviewHeight = Math.max(item.reviews ? 4 : 2, Math.round((item.reviews || 0) / max * 125));
    return `<div class="chart-day"><div class="chart-bars"><i style="height:${newHeight}px" title="新学 ${item.newWords || 0}"></i><i style="height:${reviewHeight}px" title="复习 ${item.reviews || 0}"></i></div>${labels[date.getDay()]}</div>`;
  }).join('');
}

function renderSettings() {
  $('#apiBase').value = state.settings.apiBase || '';
  $('#apiModel').value = state.settings.apiModel || '';
  $('#apiKey').value = state.settings.apiKey || '';
  $('#dailyGoal').value = state.settings.dailyGoal || 20;
  $('#accentSelect').value = state.settings.accent || 'en-US';
  $('#apiStatus').textContent = state.settings.apiKey ? 'API 设置已保存在此浏览器' : '密钥仅保存在此浏览器';
}

function parseVocabText(text) {
  const result = [];
  const invalid = [];
  const seenTerms = new Map();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const posPattern = '(n|v|adj|adv|prep|pron|conj|interj|phr)\\.';
  const rowPattern = new RegExp(`^([A-Za-z][A-Za-z\\s'’\\-]*?)(?:\\s+${posPattern})?\\s+([\\u3400-\\u9fff].+)$`, 'i');
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const match = line.match(rowPattern);
    if (!match) { invalid.push(index + 1); return; }
    const term = match[1].trim().replace(/\s+/g, ' ');
    const partOfSpeech = match[2] || '';
    const meanings = [...new Set(match[3].split(/[；;]/).map((meaning) => meaning.trim()).filter(Boolean))];
    if (!term || !meanings.length) { invalid.push(index + 1); return; }
    const key = normalize(term);
    const existing = seenTerms.get(key);
    if (existing) existing.meanings = [...new Set([...existing.meanings, ...meanings])];
    else {
      const entry = { term, partOfSpeech, meanings, sourceLine: index + 1 };
      seenTerms.set(key, entry); result.push(entry);
    }
  });
  return { entries: result, invalid };
}

async function readDocx(file) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器无法读取 DOCX，请另存为 TXT 后导入。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无法识别该 DOCX 文件。');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  let documentXml = null;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const filename = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (filename !== 'word/document.xml') continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === 0) documentXml = new TextDecoder().decode(compressed);
    else if (method === 8) {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      documentXml = await new Response(stream).text();
    } else throw new Error('该 DOCX 使用了暂不支持的压缩格式。');
    break;
  }
  if (!documentXml) throw new Error('DOCX 中没有找到可读取的正文。');
  const xml = new DOMParser().parseFromString(documentXml, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('DOCX 正文格式无法解析。');
  return [...xml.getElementsByTagName('w:p')].map((paragraph) => [...paragraph.getElementsByTagName('w:t')].map((node) => node.textContent).join('')).join('\n');
}

function setImportProgress(done, total, message) {
  const percent = total ? Math.round(done / total * 100) : 0;
  $('#importProgress').hidden = false;
  $('#importProgressText').textContent = message;
  $('#importProgressNumber').textContent = `${percent}%`;
  $('#importProgressBar').style.width = `${percent}%`;
}

function splitChunks(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function parseModelJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

function chatCompletionsUrl(base) {
  const value = base.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

async function generateChunk(entries) {
  const payload = entries.map((entry) => ({ word: entry.term, part_of_speech: entry.partOfSpeech || null, meanings: entry.meanings }));
  const response = await fetch(chatCompletionsUrl(state.settings.apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.settings.apiKey}` },
    body: JSON.stringify({
      model: state.settings.apiModel,
      temperature: 0.45,
      messages: [
        { role: 'system', content: 'You create study material for Chinese senior high school English learners. Return only valid JSON with shape {"items":[{"word":"...","example":"...","translation":"...","distractors":["...","...","..."]}]}. For every input word, write one natural short everyday-life English sentence using vocabulary around the Chinese high school 3500-word level, its accurate Chinese translation, and exactly three concise Chinese distractor meanings semantically close to the supplied correct meanings but clearly incorrect. Keep the original word spelling. Do not use the supplied correct meanings as distractors.' },
        { role: 'user', content: JSON.stringify({ words: payload }) },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`服务返回 ${response.status}${detail ? `：${detail.slice(0, 130)}` : ''}`);
  }
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 服务没有返回内容。');
  const parsed = parseModelJson(content);
  if (!Array.isArray(parsed.items)) throw new Error('AI 返回内容格式不正确。');
  return parsed.items;
}

function resetImportModal() {
  pendingFileText = '';
  pendingParsed = [];
  $('#vocabName').value = '';
  $('#vocabFile').value = '';
  $('#fileName').textContent = '尚未选择文件';
  $('#importPreview').hidden = true;
  $('#importProgress').hidden = true;
  $('#importError').textContent = '';
  $('#runImport').disabled = false;
  $('#runImport').classList.remove('is-busy');
  $('#runImport').querySelector('span').textContent = '导入并生成';
}

async function handleVocabFile(file) {
  $('#importError').textContent = '';
  if (!file) return;
  try {
    pendingFileText = file.name.toLowerCase().endsWith('.docx') ? await readDocx(file) : await file.text();
    const parsed = parseVocabText(pendingFileText);
    pendingParsed = parsed.entries;
    $('#fileName').textContent = file.name;
    $('#importPreview').hidden = false;
    $('#importPreview').innerHTML = `<strong>${parsed.entries.length}</strong> 个有效词条${parsed.invalid.length ? ` · ${parsed.invalid.length} 行无法识别（第 ${parsed.invalid.slice(0, 8).join('、')}${parsed.invalid.length > 8 ? '…' : ''} 行）` : ''}<br>${parsed.entries.slice(0, 4).map((entry) => `${escapeHtml(entry.term)}${entry.partOfSpeech ? ` ${escapeHtml(entry.partOfSpeech)}.` : ''} · ${escapeHtml(entry.meanings.join('；'))}`).join('<br>')}`;
    if (!parsed.entries.length) $('#importError').textContent = '没有识别到有效词条。请按“abandon v. 放弃；遗弃”的格式整理。';
  } catch (error) {
    pendingFileText = ''; pendingParsed = [];
    $('#fileName').textContent = file.name;
    $('#importError').textContent = error.message || '文件读取失败。';
  }
}

function mergeMeanings(existing, meanings) { existing.meanings = [...new Set([...(existing.meanings || []), ...meanings])]; }

function addEntriesToState(name, parsed) {
  const key = normalize(name);
  let vocab = state.vocabs.find((item) => normalize(item.name) === key);
  if (!vocab) {
    vocab = { id: crypto.randomUUID(), name: name.trim(), createdAt: new Date().toISOString() };
    state.vocabs.push(vocab);
  }
  const added = [];
  parsed.forEach((item) => {
    const existing = state.entries.find((entry) => entry.vocabId === vocab.id && normalize(entry.term) === normalize(item.term));
    if (existing) {
      const before = existing.meanings.length;
      mergeMeanings(existing, item.meanings);
      if (!existing.partOfSpeech && item.partOfSpeech) existing.partOfSpeech = item.partOfSpeech;
      if (existing.meanings.length !== before) {
        delete existing.example; delete existing.translation; delete existing.distractors;
        existing.generation = 'pending';
      }
      if (!reviewable(existing)) added.push(existing);
      return;
    }
    const entry = {
      id: crypto.randomUUID(), vocabId: vocab.id, term: item.term, partOfSpeech: item.partOfSpeech,
      meanings: item.meanings, generation: 'pending', createdAt: new Date().toISOString(),
      reviewCount: 0, intervalIndex: -1, dueAt: null,
    };
    state.entries.push(entry); added.push(entry);
  });
  return { vocab, entries: [...new Map(added.map((entry) => [entry.id, entry])).values()] };
}

async function generateEntries(entries, onProgress = () => {}) {
  const todo = entries.filter((entry) => !reviewable(entry));
  const chunks = splitChunks(todo, 4);
  let finished = 0;
  let failed = 0;
  for (const chunk of chunks) {
    chunk.forEach((entry) => { entry.generation = 'pending'; delete entry.generationError; });
    try {
      const generated = await generateChunk(chunk);
      const byWord = new Map(generated.map((item) => [normalize(item.word || ''), item]));
      chunk.forEach((entry) => {
        const item = byWord.get(normalize(entry.term));
        if (!item || typeof item.example !== 'string' || typeof item.translation !== 'string' || !Array.isArray(item.distractors) || item.distractors.length !== 3) {
          entry.generation = 'failed'; entry.generationError = '生成内容不完整'; failed += 1;
        } else {
          entry.example = item.example.trim(); entry.translation = item.translation.trim();
          entry.distractors = item.distractors.map((value) => String(value).trim()).filter(Boolean).slice(0, 3);
          if (entry.distractors.length !== 3 || !entry.example || !entry.translation) {
            entry.generation = 'failed'; entry.generationError = '生成内容不完整'; failed += 1;
          } else { entry.generation = 'ready'; delete entry.generationError; }
        }
      });
    } catch (error) {
      chunk.forEach((entry) => { entry.generation = 'failed'; entry.generationError = error.message || '生成失败'; failed += 1; });
    }
    finished += chunk.length;
    saveState();
    onProgress(finished, todo.length, failed);
  }
  return { total: todo.length, failed };
}

async function runImport() {
  const name = $('#vocabName').value.trim();
  if (!name) { $('#importError').textContent = '请先为词库填写名称。'; $('#vocabName').focus(); return; }
  if (!pendingParsed.length) { $('#importError').textContent = '请先选择包含有效词条的 TXT 或 DOCX 文件。'; return; }
  if (!state.settings.apiBase || !state.settings.apiModel || !state.settings.apiKey) {
    $('#importError').innerHTML = '请先在设置中填写 API 地址、模型名称和 API 密钥。<button class="inline-link" id="goApiSettings">前往设置</button>';
    return;
  }
  const { vocab, entries } = addEntriesToState(name, pendingParsed);
  saveState();
  const btn = $('#runImport'); btn.disabled = true; btn.classList.add('is-busy'); btn.querySelector('span').textContent = '正在生成';
  $('#importError').textContent = '';
  setImportProgress(0, entries.filter((entry) => !reviewable(entry)).length, '正在连接 AI 服务');
  const result = await generateEntries(entries, (done, total, failed) => setImportProgress(done, total, `已处理 ${done} / ${total} 个单词${failed ? ` · ${failed} 个待重试` : ''}`));
  btn.disabled = false; btn.classList.remove('is-busy'); btn.querySelector('span').textContent = '导入并生成';
  saveState();
  if (result.failed) {
    closeModal('importModal'); resetImportModal(); setView('library'); renderLibrary(); openVocabDetail(vocab.id);
    showToast(`${result.failed} 个单词生成失败，已保存在词库中待重试`);
  } else {
    closeModal('importModal'); resetImportModal(); setView('today');
    const newCount = vocabEntries(vocab.id).filter((entry) => !seen(entry) && reviewable(entry)).length;
    $('#includeNew').checked = true; $('#newCount').value = String(Math.min(newCount, Number(state.settings.dailyGoal)));
    updateSessionCounts();
    showToast(`已导入 ${entries.length} 个词条${result.total ? '，例句已生成' : '，词条已更新'}`);
  }
}

function speak(text, lang = 'en-US') {
  if (!('speechSynthesis' in window) || !text) { showToast('此浏览器暂不支持语音播放'); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = state.settings.accent === 'en-GB' ? 'en-GB' : lang;
  utterance.rate = 0.92;
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((item) => item.lang === utterance.lang) || voices.find((item) => item.lang.toLowerCase().startsWith('en-us')) || voices.find((item) => item.lang.toLowerCase().startsWith('en'));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

function startSession() {
  const reviews = $('#includeReview').checked ? Math.min(Number($('#reviewCount').value) || 0, dueEntries().length) : 0;
  const fresh = $('#includeNew').checked ? Math.min(Number($('#newCount').value) || 0, newEntries().length) : 0;
  const selected = [
    ...shuffled(dueEntries()).slice(0, reviews),
    ...shuffled(newEntries()).slice(0, fresh),
  ];
  if (!selected.length) { showToast('先选择至少一个可学习的单词'); return; }
  session = { entries: selected, index: 0, correct: 0, reviewed: 0, newWords: 0, reviews: 0, answered: false };
  openModal('sessionModal');
  renderSessionCard();
}

function renderSessionCard() {
  if (!session) return;
  if (session.index >= session.entries.length) { renderSessionComplete(); return; }
  const entry = session.entries[session.index];
  const vocab = findVocab(entry.vocabId);
  session.answered = false;
  const progress = Math.round(session.index / session.entries.length * 100);
  $('#sessionMode').textContent = seen(entry) ? '到期复习' : '学习新词';
  $('#sessionCounter').textContent = `${session.index + 1} / ${session.entries.length}`;
  $('#sessionProgressBar').style.width = `${progress}%`;
  const correctMeaning = entry.meanings[Math.floor(Math.random() * entry.meanings.length)];
  const options = shuffled([{ text: correctMeaning, correct: true }, ...entry.distractors.map((text) => ({ text, correct: false }))]);
  session.currentMeaning = correctMeaning;
  $('#sessionContent').innerHTML = `<div class="word-meta"><span>${POS_LABELS[entry.partOfSpeech] || (entry.partOfSpeech ? entry.partOfSpeech + '.' : '词条')}</span><span>${escapeHtml(vocab?.name || '')}</span></div><div class="word-title-row"><h2 id="sessionWord">${escapeHtml(entry.term)}</h2><button class="sound-button" id="speakWord" aria-label="播放单词发音" title="播放单词发音">◖</button></div><p class="quiz-prompt">选择这个词在词表中的中文释义</p><div class="answer-options">${options.map((option, index) => `<button class="answer-option" data-option="${index}" data-correct="${option.correct}" data-answer="${escapeHtml(option.text)}"><span class="option-key">${String.fromCharCode(65 + index)}</span><span>${escapeHtml(option.text)}</span></button>`).join('')}</div><div id="answerReveal"></div>`;
  $('#speakWord').addEventListener('click', () => speak(entry.term));
  $$('.answer-option').forEach((button) => button.addEventListener('click', () => chooseAnswer(button, entry)));
  speak(entry.term);
}

function chooseAnswer(button, entry) {
  if (!session || session.answered) return;
  session.answered = true;
  const correct = button.dataset.correct === 'true';
  session.lastAnswerCorrect = correct;
  if (correct) session.correct += 1;
  session.reviewed += 1;
  $$('.answer-option').forEach((option) => {
    option.disabled = true;
    if (option.dataset.correct === 'true') option.classList.add('is-correct');
  });
  if (!correct) button.classList.add('is-wrong');
  $('#answerReveal').innerHTML = `<div class="answer-reveal"><p class="reveal-meaning"><strong>${escapeHtml(entry.meanings.join('；'))}</strong></p><div class="example-line"><span>${escapeHtml(entry.example)}</span><button id="speakExample" aria-label="播放例句" title="播放例句">◖</button></div><button class="translation-toggle" id="showTranslation">显示中文翻译</button><p class="example-translation" id="exampleTranslation" hidden>${escapeHtml(entry.translation)}</p><div class="self-rate"><button class="rate-button rate-again" data-rating="again">不认识</button><button class="rate-button rate-hard" data-rating="hard">模糊</button><button class="rate-button rate-good" data-rating="good">认识</button></div></div>`;
  $('#speakExample').addEventListener('click', () => speak(entry.example));
  $('#showTranslation').addEventListener('click', () => {
    const translation = $('#exampleTranslation');
    translation.hidden = false;
    $('#showTranslation').hidden = true;
    speak(entry.example);
  });
  $$('[data-rating]').forEach((item) => item.addEventListener('click', () => rateEntry(entry, item.dataset.rating)));
  speak(entry.example);
}

function rateEntry(entry, rating) {
  const now = new Date();
  const currentIndex = Number(entry.intervalIndex ?? -1);
  if (rating === 'good') {
    entry.intervalIndex = Math.min(INTERVAL_DAYS.length - 1, currentIndex < 0 ? 0 : currentIndex + 1);
    entry.dueAt = now.getTime() + INTERVAL_DAYS[entry.intervalIndex] * 86400000;
    entry.lastRating = 'good';
  } else if (rating === 'hard') {
    entry.intervalIndex = Math.max(0, currentIndex - 1);
    entry.dueAt = now.getTime() + 60 * 60 * 1000;
    entry.lastRating = 'hard';
  } else {
    entry.intervalIndex = -1;
    entry.dueAt = now.getTime() + 10 * 60 * 1000;
    entry.lastRating = 'again';
  }
  entry.lastReviewedAt = now.toISOString();
  entry.reviewCount = (entry.reviewCount || 0) + 1;
  const key = localDate(now);
  const item = state.daily[key] || (state.daily[key] = { newWords: 0, reviews: 0, correct: 0, answers: 0 });
  if (entry.reviewCount === 1) { item.newWords = (item.newWords || 0) + 1; session.newWords += 1; }
  else { item.reviews = (item.reviews || 0) + 1; session.reviews += 1; }
  item.answers = (item.answers || 0) + 1;
  if (session.lastAnswerCorrect) item.correct = (item.correct || 0) + 1;
  saveState();
  session.index += 1;
  renderSessionCard();
}

function renderSessionComplete() {
  $('#sessionCounter').textContent = `${session.entries.length} / ${session.entries.length}`;
  $('#sessionProgressBar').style.width = '100%';
  $('#sessionMode').textContent = '本轮完成';
  $('#sessionContent').innerHTML = `<div class="session-complete"><span class="complete-mark">✓</span><h2>这一轮完成了。</h2><p>记忆正在慢慢变牢，继续保持自己的节奏。</p><div class="complete-stats"><div><strong>${session.newWords}</strong><span>新学</span></div><div><strong>${session.reviews}</strong><span>复习</span></div><div><strong>${session.correct}/${session.reviewed}</strong><span>答对</span></div></div><button class="primary-button" id="finishSession"><span>回到今日</span><b>→</b></button></div>`;
  $('#finishSession').addEventListener('click', () => {
    closeModal('sessionModal'); session = null; setView('today'); renderToday();
  });
  renderToday();
}

function endSession() {
  if (!session) return;
  closeModal('sessionModal'); session = null; saveState(); setView('today'); renderToday();
}

function openVocabDetail(vocabId) {
  const vocab = findVocab(vocabId);
  if (!vocab) return;
  const entries = vocabEntries(vocabId).sort((a, b) => a.term.localeCompare(b.term));
  const failed = entries.filter((entry) => entry.generation === 'failed').length;
  const seenCount = entries.filter(seen).length;
  $('#vocabDetail').innerHTML = `<div class="detail-head"><span class="collection-icon">字</span><div><h2>${escapeHtml(vocab.name)}</h2><small>${entries.length} 个词 · 已学习 ${seenCount} 个</small></div><div class="detail-actions"><button id="renameVocab">重命名</button>${failed ? `<button id="retryVocab">重试 ${failed} 个</button>` : ''}</div></div><div class="detail-table">${entries.map((entry) => `<div class="detail-word"><strong>${escapeHtml(entry.term)}${entry.partOfSpeech ? ` <small>${escapeHtml(entry.partOfSpeech)}.</small>` : ''}</strong><span>${escapeHtml(entry.meanings.join('；'))}</span><small>${entry.generation === 'ready' ? (seen(entry) ? `第 ${Math.max(1,Number(entry.intervalIndex) + 1)} 阶段` : '待学习') : entry.generation === 'failed' ? '待重试' : '生成中'}</small></div>`).join('') || '<div class="empty-inline">词库里还没有单词。</div>'}</div>`;
  $('#renameVocab')?.addEventListener('click', () => {
    const next = prompt('请输入新的词库名称', vocab.name)?.trim();
    if (!next) return;
    if (state.vocabs.some((item) => item.id !== vocab.id && normalize(item.name) === normalize(next))) { showToast('已经有同名词库了'); return; }
    vocab.name = next; saveState(); openVocabDetail(vocab.id); renderLibrary(); renderToday();
  });
  $('#retryVocab')?.addEventListener('click', async () => {
    if (!state.settings.apiBase || !state.settings.apiModel || !state.settings.apiKey) { closeModal('vocabDetailModal'); setView('settings'); showToast('先填写 AI 服务设置'); return; }
    const button = $('#retryVocab'); button.disabled = true; button.textContent = '正在重试';
    const result = await generateEntries(entries.filter((entry) => entry.generation === 'failed'));
    openVocabDetail(vocab.id); renderLibrary(); renderToday();
    showToast(result.failed ? `${result.failed} 个词仍未成功，可再次重试` : '例句已生成');
  });
  openModal('vocabDetailModal');
}

function showVocabMenu(button, vocabId) {
  activeMenu?.remove();
  const rect = button.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'more-menu';
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 95)}px`;
  menu.style.left = `${Math.min(rect.right - 150, window.innerWidth - 158)}px`;
  menu.innerHTML = '<button data-menu-action="open">查看词条</button><button data-menu-action="rename">重命名词库</button><button class="danger" data-menu-action="delete">删除词库</button>';
  menu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
    const vocab = findVocab(vocabId);
    if (!vocab || !action) return;
    if (action === 'open') openVocabDetail(vocabId);
    if (action === 'rename') {
      const next = prompt('请输入新的词库名称', vocab.name)?.trim();
      if (next && !state.vocabs.some((item) => item.id !== vocabId && normalize(item.name) === normalize(next))) { vocab.name = next; saveState(); renderLibrary(); renderToday(); }
      else if (next) showToast('已经有同名词库了');
    }
    if (action === 'delete' && confirm(`删除“${vocab.name}”及其中的所有学习记录？此操作无法撤销。`)) {
      state.vocabs = state.vocabs.filter((item) => item.id !== vocabId);
      state.entries = state.entries.filter((entry) => entry.vocabId !== vocabId);
      saveState(); renderLibrary(); renderToday(); showToast('词库已删除');
    }
    menu.remove(); activeMenu = null;
  });
  document.body.append(menu); activeMenu = menu;
}

function exportBackup() {
  const payload = { app: 'shici', version: 1, exportedAt: new Date().toISOString(), data: state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `shici-backup-${localDate()}.json`; link.click();
  URL.revokeObjectURL(url); showToast('备份文件已导出');
}

function mergeBackup(incoming) {
  const idMap = new Map();
  (incoming.vocabs || []).forEach((source) => {
    let target = state.vocabs.find((item) => normalize(item.name) === normalize(source.name));
    if (!target) { target = { ...source, id: crypto.randomUUID() }; state.vocabs.push(target); }
    idMap.set(source.id, target.id);
  });
  (incoming.entries || []).forEach((source) => {
    const vocabId = idMap.get(source.vocabId);
    if (!vocabId) return;
    const target = state.entries.find((item) => item.vocabId === vocabId && normalize(item.term) === normalize(source.term));
    if (!target) { state.entries.push({ ...source, id: crypto.randomUUID(), vocabId }); return; }
    mergeMeanings(target, source.meanings || []);
    if (!reviewable(target) && reviewable(source)) Object.assign(target, { example: source.example, translation: source.translation, distractors: source.distractors, generation: 'ready' });
    if (new Date(source.lastReviewedAt || 0) > new Date(target.lastReviewedAt || 0)) {
      Object.assign(target, { dueAt: source.dueAt, intervalIndex: source.intervalIndex, lastReviewedAt: source.lastReviewedAt, lastRating: source.lastRating, reviewCount: Math.max(target.reviewCount || 0, source.reviewCount || 0) });
    }
  });
  Object.entries(incoming.daily || {}).forEach(([date, source]) => {
    const target = state.daily[date] || (state.daily[date] = { newWords: 0, reviews: 0, correct: 0, answers: 0 });
    ['newWords', 'reviews', 'correct', 'answers'].forEach((key) => { target[key] = Math.max(target[key] || 0, source[key] || 0); });
  });
  if (incoming.settings) state.settings = { ...state.settings, ...incoming.settings };
}

async function restoreBackup(file) {
  try {
    const payload = JSON.parse(await file.text());
    const incoming = payload.data || payload;
    if (payload.app && payload.app !== 'shici') throw new Error('这不是拾词的备份文件。');
    if (!Array.isArray(incoming.vocabs) || !Array.isArray(incoming.entries)) throw new Error('备份文件格式不正确。');
    mergeBackup(incoming); saveState(); renderToday(); renderSettings();
    showToast(`已合并恢复 ${incoming.vocabs.length} 个词库`);
  } catch (error) { showToast(error.message || '无法读取备份文件'); }
}

function bindEvents() {
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#openImport').addEventListener('click', () => { resetImportModal(); openModal('importModal'); });
  $('#runImport').addEventListener('click', runImport);
  $('#vocabFile').addEventListener('change', (event) => handleVocabFile(event.target.files[0]));
  $('#librarySearch').addEventListener('input', (event) => renderLibrary(event.target.value));
  $('#startSession').addEventListener('click', startSession);
  $('#closeSession').addEventListener('click', endSession);
  $('#endSession').addEventListener('click', endSession);
  $('#includeReview').addEventListener('change', updateSessionCounts);
  $('#includeNew').addEventListener('change', updateSessionCounts);
  ['reviewCount', 'newCount'].forEach((id) => $(`#${id}`).addEventListener('input', updateSessionCounts));
  document.addEventListener('click', (event) => {
    const step = event.target.closest('[data-step]');
    if (step) {
      event.preventDefault(); event.stopPropagation();
      const kind = step.dataset.step; const delta = Number(step.dataset.delta);
      const input = kind === 'goal' ? $('#dailyGoal') : $(`#${kind}Count`);
      const max = kind === 'goal' ? 200 : (kind === 'review' ? dueEntries().length : Math.min(newEntries().length, Number(state.settings.dailyGoal)));
      input.value = String(Math.max(kind === 'goal' ? 1 : 0, Math.min(max, Number(input.value || 0) + delta)));
      if (kind !== 'goal') updateSessionCounts();
    }
    const openId = event.target.closest('[data-open-vocab]')?.dataset.openVocab;
    if (openId) openVocabDetail(openId);
    const menuButton = event.target.closest('[data-menu-vocab]');
    if (menuButton) { event.stopPropagation(); showVocabMenu(menuButton, menuButton.dataset.menuVocab); }
    if (event.target.closest('[data-close]')) {
      const modal = event.target.closest('.modal-backdrop'); if (modal) closeModal(modal.id);
    }
    if (event.target.classList.contains('modal-backdrop')) {
      if (event.target.id === 'sessionModal') endSession();
      else closeModal(event.target.id);
    }
    if (event.target.id === 'emptyImport') { resetImportModal(); openModal('importModal'); }
    if (event.target.id === 'goApiSettings') { closeModal('importModal'); setView('settings'); }
    if (activeMenu && !event.target.closest('.more-menu') && !event.target.closest('[data-menu-vocab]')) { activeMenu.remove(); activeMenu = null; }
  });
  $('#saveApi').addEventListener('click', () => {
    state.settings.apiBase = $('#apiBase').value.trim().replace(/\/+$/, '');
    state.settings.apiModel = $('#apiModel').value.trim();
    state.settings.apiKey = $('#apiKey').value.trim();
    saveState(); renderSettings(); showToast('AI 服务设置已保存');
  });
  $('#toggleSecret').addEventListener('click', () => {
    const input = $('#apiKey'); const visible = input.type === 'password'; input.type = visible ? 'text' : 'password'; $('#toggleSecret').textContent = visible ? '隐藏' : '显示';
  });
  $('#saveGoal').addEventListener('click', () => {
    state.settings.dailyGoal = Math.max(1, Math.min(200, Number($('#dailyGoal').value) || 20));
    saveState(); renderSettings(); renderToday(); showToast('每日新词目标已保存');
  });
  $('#accentSelect').addEventListener('change', () => {
    state.settings.accent = $('#accentSelect').value;
    saveState();
  });
  $('#exportBackup').addEventListener('click', exportBackup);
  $('#importBackup').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', (event) => { if (event.target.files[0]) restoreBackup(event.target.files[0]); event.target.value = ''; });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (session) endSession();
      $$('.modal-backdrop.is-open').forEach((modal) => closeModal(modal.id));
      activeMenu?.remove(); activeMenu = null;
    }
    if (session && !session.answered && /^[1-4]$/.test(event.key)) $$('.answer-option')[Number(event.key) - 1]?.click();
  });
}

bindEvents();
renderToday();
if (!state.settings.apiKey) $('#apiStatus').textContent = '密钥仅保存在此浏览器';
