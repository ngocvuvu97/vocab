'use client';

import { useEffect, useMemo, useState } from 'react';
import { Award, BookOpen, Check, ChevronRight, CircleHelp, Download, Heart, Home as HomeIcon, Library, LoaderCircle, Plus, Search, Settings, Sparkles, Upload, Volume2, X } from 'lucide-react';

const DB_NAME = 'wordly-db';
const DB_VERSION = 2;
const EXPORT_SCHEMA_VERSION = 2;
const DEFAULT_SETTINGS = { goal: 20, topicPositions: {}, lastTopicId: '', mw_learners_api_key: '' };
const MY_SHELF_TOPIC = { topic_id: 'myshelf', topic_vi: 'My shelf', topic_en: 'My shelf', count: 0 };

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('topics')) db.createObjectStore('topics', { keyPath: 'topic_id' });
      if (!db.objectStoreNames.contains('words')) db.createObjectStore('words', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAll(storeName) {
  const db = await openDb();
  try {
    return await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
  } finally {
    db.close();
  }
}

async function getRecord(storeName, id) {
  const db = await openDb();
  try {
    return await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(id));
  } finally {
    db.close();
  }
}

async function getSettings() {
  const db = await openDb();
  try {
    const stored = await requestResult(db.transaction('settings', 'readonly').objectStore('settings').get('app'));
    return { ...DEFAULT_SETTINGS, ...(stored?.value || {}) };
  } finally {
    db.close();
  }
}

async function putRecord(storeName, record) {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function deleteRecord(storeName, id) {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function putSettings(value) {
  await putRecord('settings', { id: 'app', value });
}

function normalizeImportData(fileData) {
  const payload = fileData.data || fileData;
  const flatEntries = payload.entries || [];
  const progressRows = Array.isArray(payload.progress) ? payload.progress : Object.values(payload.progress || {});
  if (!Array.isArray(payload.topics) || !payload.topics.length) throw Error('File thiếu topics');
  return {
    topics: payload.topics.map(topic => {
      const entries = topic.entries?.length ? topic.entries : flatEntries.filter(entry => entry.topic_id === topic.topic_id);
      return {
        topic_id: topic.topic_id,
        topic_vi: topic.topic_vi,
        topic_en: topic.topic_en,
        count: entries.length || topic.count || 0,
        entries: entries.map(entry => ({ ...entry, topic_id: entry.topic_id || topic.topic_id })),
      };
    }),
    progress: Object.fromEntries(progressRows.filter(row => row?.id).map(row => [row.id, row])),
    settings: {
      ...DEFAULT_SETTINGS,
      ...(payload.settings || {}),
      mw_learners_api_key: payload.mw_learners_api_key || payload.settings?.mw_learners_api_key || '',
    },
    audio: Array.isArray(payload.audio) ? payload.audio : Object.values(payload.audio || {}),
  };
}

function createBackupPayload({ topics, progress, settings, audio }) {
  return {
    app: 'wordly',
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      topics: topics.map(topic => ({
        topic_id: topic.topic_id,
        topic_vi: topic.topic_vi,
        topic_en: topic.topic_en,
        count: topic.entries?.length || topic.count || 0,
        entries: (topic.entries || []).map(({ topic_vi, ...entry }) => ({ ...entry, topic_id: entry.topic_id || topic.topic_id })),
      })),
      progress,
      settings,
      audio: audio.map(({ blob, ...row }) => row),
    },
  };
}

async function fetchLearnersAudio(word, apiKey) {
  if (!apiKey) throw Error('Chưa có mw_learners_api_key trong dữ liệu đã import');
  const response = await fetch(`https://www.dictionaryapi.com/api/v3/references/learners/json/${encodeURIComponent(word.trim())}?key=${encodeURIComponent(apiKey)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error('Merriam-Webster API lỗi: ' + response.status);
  const entry = Array.isArray(data) ? data.find(item => item?.hwi?.prs?.some(pron => pron?.sound?.audio)) : null;
  const audioName = entry?.hwi?.prs?.map(pron => pron?.sound?.audio).find(Boolean);
  if (!audioName) throw Error('Không tìm thấy audio cho từ này');
  const subdirectory = audioName.startsWith('bix') ? 'bix' : audioName.startsWith('gg') ? 'gg' : /^[a-z]/i.test(audioName) ? audioName[0].toLowerCase() : 'number';
  const audioUrl = `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdirectory}/${audioName}.mp3`;
  const row = { id: word.trim().toLowerCase(), word: word.trim(), audioName, audioUrl, cachedAt: Date.now() };
  // Persist the URL immediately. Blob downloading may fail because of CORS,
  // but the pronunciation lookup itself is still a valid reusable cache.
  await putRecord('audio', row);
  try {
    const audioResponse = await fetch(audioUrl);
    if (audioResponse.ok) {
      row.blob = await audioResponse.blob();
      await putRecord('audio', row);
    }
  } catch {}
  return row;
}

async function playAudioRow(row) {
  const url = row.blob ? URL.createObjectURL(row.blob) : row.audioUrl;
  const audio = new Audio(url);
  audio.onended = () => {
    if (row.blob) URL.revokeObjectURL(url);
  };
  audio.onerror = () => {
    if (row.blob) URL.revokeObjectURL(url);
  };
  await audio.play();
}

async function seedDatabase(fileData) {
  const data = normalizeImportData(fileData);
  const db = await openDb();
  try {
    const tx = db.transaction(['topics', 'words', 'progress', 'settings', 'audio'], 'readwrite');
    ['topics', 'words', 'progress', 'audio'].forEach(name => tx.objectStore(name).clear());
    data.topics.forEach(topic => {
      tx.objectStore('topics').put({
        topic_id: topic.topic_id,
        topic_vi: topic.topic_vi,
        topic_en: topic.topic_en,
        count: topic.entries?.length || topic.count || 0,
      });
      (topic.entries || []).forEach(entry => tx.objectStore('words').put({ ...entry, topic_id: topic.topic_id }));
    });
    Object.values(data.progress || {}).forEach(row => tx.objectStore('progress').put(row));
    (data.audio || []).filter(row => row?.audioUrl).forEach(row => tx.objectStore('audio').put({ ...row, id: (row.id || row.word || '').trim().toLowerCase() }));
    tx.objectStore('settings').put({ id: 'app', value: data.settings });
    await transactionDone(tx);
    return data;
  } finally {
    db.close();
  }
}

function buildSource(topics, words) {
  const entriesByTopic = words.reduce((acc, word) => {
    acc[word.topic_id] = [...(acc[word.topic_id] || []), word];
    return acc;
  }, {});
  return {
    topics: topics.map(topic => ({
      ...topic,
      count: entriesByTopic[topic.topic_id]?.length || topic.count || 0,
      entries: entriesByTopic[topic.topic_id] || [],
    })),
  };
}

const flatten = source => (source?.topics || []).flatMap(topic => (topic.entries || []).map(entry => ({ ...entry, topic_id: topic.topic_id, topic_vi: topic.topic_vi })));

function isToday(timestamp) {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

const emptyWordForm = {
  word: '',
  part_of_speech: '',
  ipa: '',
  meaning_vi: '',
  examplesText: '',
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { retries = 3, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeout);
      if ([502, 503, 504, 522, 523, 524].includes(response.status) && attempt < retries - 1) {
        lastError = Error(`API lỗi ${response.status}`);
        await wait(700 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries - 1) await wait(700 * (attempt + 1));
    }
  }
  throw lastError || Error('Không gọi được API');
}

function normalizePartOfSpeech(value) {
  const map = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', pronoun: 'pron.', preposition: 'prep.', conjunction: 'conj.', interjection: 'interj.' };
  return map[value] || (value ? `${value}.` : '');
}

function cleanMerriamText(value) {
  return String(value || '')
    .replace(/\{bc\}/g, '')
    .replace(/\{ldquo\}|\{rdquo\}/g, '"')
    .replace(/\{it\}|\{\/it\}/g, '')
    .replace(/\{sc\}|\{\/sc\}/g, '')
    .replace(/\{(?:a_link|d_link|i_link|et_link|sx)\|([^|{}]+)(?:\|[^{}]*)?\}/g, '$1')
    .replace(/\{[^{}]+\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMerriamExamples(entry) {
  const examples = [];
  const visit = value => {
    if (!value || examples.length >= 3) return;
    if (Array.isArray(value)) {
      if (value[0] === 'vis' && Array.isArray(value[1])) {
        value[1].forEach(item => {
          const text = cleanMerriamText(item?.t);
          if (text && !examples.includes(text)) examples.push(text);
        });
        return;
      }
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(entry?.def);
  return examples.slice(0, 3);
}

async function translateToVietnamese(text) {
  if (!text) return '';
  try {
    const translationResponse = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|vi`);
    const translationData = await translationResponse.json();
    return translationData?.responseData?.translatedText || '';
  } catch {
    return '';
  }
}

async function fetchMerriamWebsterWordInfo(word, apiKey) {
  const normalized = word.trim().toLowerCase();
  if (!normalized) throw Error('Bạn cần nhập từ trước');
  if (!apiKey) throw Error('Chưa có mw_learners_api_key trong dữ liệu đã import');
  const response = await fetchWithRetry(`https://www.dictionaryapi.com/api/v3/references/learners/json/${encodeURIComponent(normalized)}?key=${encodeURIComponent(apiKey)}`, { retries: 3, timeoutMs: 20000 });
  if (!response.ok) throw Error(`Merriam-Webster API lỗi ${response.status}`);
  const data = await response.json();
  const entry = Array.isArray(data) ? data.find(item => item?.meta?.id || item?.hwi?.hw) : null;
  if (!entry || typeof entry === 'string') throw Error('Không tìm thấy từ trong Merriam-Webster Learner API');
  const definitions = entry.shortdef || [];
  const examples = extractMerriamExamples(entry);
  const firstDefinition = definitions[0] || '';
  const meaningVi = await translateToVietnamese(firstDefinition);
  return {
    word: (entry.hwi?.hw || normalized).replace(/\*/g, ''),
    part_of_speech: normalizePartOfSpeech(entry.fl || ''),
    ipa: entry.hwi?.prs?.find(item => item.ipa)?.ipa || entry.hwi?.prs?.find(item => item.mw)?.mw || '',
    meaning_vi: meaningVi,
    examplesText: examples.join('\n'),
    source: 'merriam-webster',
  };
}

export default function Home() {
  const [source, setSource] = useState(null);
  const [progress, setProgress] = useState({});
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [view, setView] = useState('home');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [topic, setTopic] = useState('all');
  const [learnTopic, setLearnTopic] = useState('');
  const [learnIndex, setLearnIndex] = useState(0);
  const [card, setCard] = useState(null);
  const [answer, setAnswer] = useState(false);
  const [audioLoading, setAudioLoading] = useState('');
  const [audioMessage, setAudioMessage] = useState('');
  const [newWordOpen, setNewWordOpen] = useState(false);
  const [newWordForm, setNewWordForm] = useState(emptyWordForm);
  const [newWordLoading, setNewWordLoading] = useState(false);
  const [newWordMessage, setNewWordMessage] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [topics, words, progressRows, storedSettings] = await Promise.all([getAll('topics'), getAll('words'), getAll('progress'), getSettings()]);
        if (topics.length) setSource(buildSource(topics, words));
        setProgress(Object.fromEntries(progressRows.map(row => [row.id, row])));
        setSettingsState(storedSettings);
      } catch (error) {
        alert('Không mở được IndexedDB: ' + error.message);
      } finally {
        setReady(true);
      }
    }
    load();
  }, []);

  const entries = useMemo(() => flatten(source), [source]);
  const topics = source?.topics || [];
  const merged = useMemo(() => entries.map(entry => ({ ...entry, ...(progress[entry.id] || {}) })), [entries, progress]);
  const due = merged.filter(entry => entry.nextReview && entry.nextReview <= Date.now());
  const favorites = merged.filter(entry => entry.favorite);
  const reviewQueue = useMemo(() => {
    const seen = new Set();
    return [...due, ...favorites].filter(entry => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [due, favorites]);
  const learned = merged.filter(entry => entry.status === 'mastered');
  const learnedToday = merged.filter(entry => entry.status === 'mastered' && isToday(entry.lastReviewed));
  const topicWords = merged.filter(entry => entry.topic_id === learnTopic);
  const safeLearnIndex = topicWords.length ? Math.min(learnIndex, topicWords.length - 1) : 0;
  const topicLearned = topicWords.filter(entry => entry.status === 'mastered');
  const learnCurrent = topicWords[safeLearnIndex];
  const goal = settings.goal || DEFAULT_SETTINGS.goal;
  const dailyCount = Math.min(learnedToday.length, goal);
  const dailyPercent = goal ? Math.min(100, Math.round((dailyCount / goal) * 100)) : 0;
  const masteredPercent = merged.length ? Math.round((learned.length / merged.length) * 100) : 0;
  const continueTopicId = learnTopic || settings.lastTopicId || topics[0]?.topic_id || '';
  const continueTopic = topics.find(item => item.topic_id === continueTopicId) || topics[0];
  const continueTopicWords = continueTopic ? merged.filter(entry => entry.topic_id === continueTopic.topic_id) : [];
  const continueTopicLearned = continueTopicWords.filter(entry => entry.status === 'mastered').length;
  const list = useMemo(() => merged.filter(entry => (!query || entry.word.toLowerCase().includes(query.toLowerCase())) && (topic === 'all' || entry.topic_id === topic) && (filter === 'all' || entry.status === filter || filter === 'today' && entry.status === 'mastered' && isToday(entry.lastReviewed))), [merged, query, topic, filter]);
  const loopIndex = index => (topicWords.length ? (index + topicWords.length) % topicWords.length : 0);
  const previousWord = topicWords.length ? topicWords[loopIndex(safeLearnIndex - 1)] : null;
  const nextWord = topicWords.length ? topicWords[loopIndex(safeLearnIndex + 1)] : null;

  async function updateSettings(next) {
    const value = typeof next === 'function' ? next(settings) : next;
    setSettingsState(value);
    await putSettings(value);
  }

  async function openTopic(topicId) {
    setLearnTopic(topicId);
    setLearnIndex(settings.topicPositions?.[topicId] || 0);
    setAnswer(false);
    await updateSettings(prev => ({ ...prev, lastTopicId: topicId }));
  }

  async function moveLearn(delta) {
    const nextIndex = loopIndex(safeLearnIndex + delta);
    setLearnIndex(nextIndex);
    setAnswer(false);
    await updateSettings(prev => ({ ...prev, lastTopicId: learnTopic, topicPositions: { ...(prev.topicPositions || {}), [learnTopic]: nextIndex } }));
  }

  async function toggleLearnStatus() {
    if (!learnCurrent) return;
    const row = { ...(progress[learnCurrent.id] || {}), id: learnCurrent.id, status: learnCurrent.status === 'mastered' ? 'learning' : 'mastered', lastReviewed: Date.now() };
    setProgress(prev => ({ ...prev, [learnCurrent.id]: row }));
    await putRecord('progress', row);
  }

  async function toggleFavorite(entry) {
    if (!entry?.id) return;
    const row = { ...(progress[entry.id] || {}), id: entry.id, favorite: !entry.favorite };
    setProgress(prev => ({ ...prev, [entry.id]: row }));
    await putRecord('progress', row);
    if (card?.id === entry.id) setCard(prev => prev ? { ...prev, favorite: row.favorite } : prev);
  }

  function showLearnedToday() {
    setQuery('');
    setTopic('all');
    setFilter('today');
    setView('dictionary');
  }

  function openNewWordForm() {
    setNewWordForm(emptyWordForm);
    setNewWordMessage('');
    setNewWordOpen(true);
  }

  async function fetchNewWordInfo() {
    setNewWordLoading(true);
    setNewWordMessage('Đang lấy dữ liệu từ Merriam-Webster Learner API…');
    try {
      const data = await fetchMerriamWebsterWordInfo(newWordForm.word, settings.mw_learners_api_key);
      setNewWordForm(prev => ({ ...prev, ...data }));
      setNewWordMessage('Đã fill dữ liệu từ Merriam-Webster, bạn có thể sửa rồi Save.');
    } catch (error) {
      setNewWordMessage('Không lấy được dữ liệu: ' + error.message);
    } finally {
      setNewWordLoading(false);
    }
  }

  async function saveNewWord() {
    const word = newWordForm.word.trim();
    const topicId = MY_SHELF_TOPIC.topic_id;
    if (!word) {
      setNewWordMessage('Cần có word trước khi save.');
      return;
    }
    const normalizedWord = word.toLowerCase();
    const existing = merged.find(entry => entry.word.toLowerCase() === normalizedWord && entry.topic_id === topicId);
    const row = {
      id: existing?.id || `${topicId}-${normalizedWord.replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      word,
      topic_id: topicId,
      part_of_speech: newWordForm.part_of_speech.trim(),
      ipa: newWordForm.ipa.trim() || null,
      meaning_vi: newWordForm.meaning_vi.trim(),
      examples: newWordForm.examplesText.split('\n').map(item => item.trim()).filter(Boolean),
      needs_review: false,
      user_created: true,
      updated_at: Date.now(),
    };
    if (!topics.some(item => item.topic_id === topicId)) await putRecord('topics', MY_SHELF_TOPIC);
    await putRecord('words', row);
    const words = await getAll('words');
    const topicRows = await getAll('topics');
    setSource(buildSource(topicRows, words));
    setQuery(word);
    setTopic('all');
    setFilter('all');
    setNewWordOpen(false);
    setNewWordMessage('');
  }

  async function deleteUserWord(entry) {
    if (!entry?.id || !entry.user_created) return;
    const confirmed = window.confirm(`Xoá "${entry.word}" khỏi IndexedDB?`);
    if (!confirmed) return;
    await deleteRecord('words', entry.id);
    await deleteRecord('progress', entry.id);
    const words = await getAll('words');
    const topicRows = await getAll('topics');
    setSource(buildSource(topicRows, words));
    setProgress(prev => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
    setCard(null);
  }

  async function playPronunciation(entry) {
    if (!entry?.word) return;
    const audioId = entry.word.trim().toLowerCase();
    if (audioLoading) return;
    setAudioLoading(audioId);
    setAudioMessage('Đang kiểm tra audio đã lưu…');
    try {
      const cached = await getRecord('audio', audioId);
      if (cached) {
        setAudioMessage('Đang phát audio…');
        await playAudioRow(cached);
      } else {
        setAudioMessage('Đang gọi API phát âm…');
        const row = await fetchLearnersAudio(entry.word, settings.mw_learners_api_key);
        setAudioMessage('Đang phát audio…');
        await playAudioRow(row);
      }
    } catch (error) {
      setAudioMessage('Không tải được audio: ' + error.message);
    } finally {
      setAudioLoading('');
    }
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = await seedDatabase(JSON.parse(await file.text()));
      const data = imported;
      const words = data.topics.flatMap(item => (item.entries || []).map(entry => ({ ...entry, topic_id: item.topic_id })));
      setSource(buildSource(data.topics, words));
      setProgress(data.progress);
      setSettingsState(data.settings);
      setLearnTopic('');
      setLearnIndex(0);
      setView('home');
    } catch (error) {
      alert('Import lỗi: ' + error.message);
    } finally {
      event.target.value = '';
    }
  }

  async function backup() {
    const a = document.createElement('a');
    const exportedDate = new Date().toISOString().slice(0, 10);
    const audio = await getAll('audio');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(createBackupPayload({ topics, progress, settings, audio }), null, 2)], { type: 'application/json' }));
    a.download = `wordly-backup-${exportedDate}.json`;
    a.click();
  }

  if (!ready) return null;

  const nav = [['home', HomeIcon, 'Home'], ['learn', BookOpen, 'Learn'], ['dictionary', Library, 'Dictionary'], ['review', CircleHelp, 'Review'], ['settings', Settings, 'Settings']];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><Sparkles size={19} /></div><div><div className="eyebrow">VOCABULARY PWA</div><h1>Wordly</h1></div></div>
        {!source && view === 'home' ? <label className="import-button"><Upload size={16} /> Import<input type="file" accept=".json" onChange={importFile} /></label> : null}
      </header>

      {view === 'home' && (
        <>
          <section className="home-hero">
            <div className="hero-copy">
              <div className="eyebrow">GOOD MORNING</div>
              <h2>Keep your momentum going.</h2>
              <p>Học tiếp từ vựng hôm nay và giữ nhịp ôn tập gọn nhẹ trên iPhone.</p>
            </div>

            <div className="goal-panel">
              <div className="goal-ring" style={{ '--progress': `${dailyPercent}%` }}>
                <span>{dailyCount}</span>
                <small>/{goal}</small>
              </div>
              <div>
                <div className="eyebrow">DAILY GOAL</div>
                <strong>{dailyCount} words</strong>
                <small>{dailyPercent}% hoàn thành hôm nay</small>
              </div>
            </div>

            <button className="primary-button hero-action" onClick={() => setView(due.length ? 'review' : 'learn')}>
              {due.length ? 'Start review' : 'Start learning'}
              <ChevronRight size={17} />
            </button>
          </section>

          <div className="stats">
            <button className="stat" onClick={() => { setQuery(''); setTopic('all'); setFilter('all'); setView('dictionary'); }}>
              <div className="stat-icon purple"><BookOpen size={18} /></div>
              <small>Total words</small>
              <b>{merged.length}</b>
            </button>
            <button className="stat" onClick={showLearnedToday}>
              <div className="stat-icon teal"><Award size={18} /></div>
              <small>Mastered</small>
              <b>{learnedToday.length}</b>
            </button>
          </div>

          {!source ? (
            <section className="card empty home-empty">
              <div className="empty-icon"><Upload size={24} /></div>
              <h2>Bắt đầu học</h2>
              <p>Import file JSON để seed dữ liệu vào IndexedDB.</p>
              <label className="primary-button">Import vocabulary<input type="file" accept=".json" onChange={importFile} /></label>
            </section>
          ) : (
            <section className="continue-card">
              <div className="continue-icon"><BookOpen size={20} /></div>
              <div className="continue-content">
                <div className="section-heading">
                  <h2>Continue learning</h2>
                  <button className="text-button view-all-button" onClick={() => setView('learn')}>Xem tất cả <ChevronRight size={15} /></button>
                </div>
                <p className="muted">{topics.length} topics · {learnedToday.length} từ đã học hôm nay</p>
                {continueTopic ? (
                  <div className="topic-preview">
                    <div>
                      <span>{continueTopic.topic_vi}</span>
                      <small>{continueTopicLearned} / {continueTopicWords.length || continueTopic.count} đã học</small>
                    </div>
                    <button className="secondary-button" onClick={() => { openTopic(continueTopic.topic_id); setView('learn'); }}>Học tiếp</button>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {source ? (
            <section className="progress-strip">
              <span>Progress</span>
              <div className="progress-line"><span style={{ width: `${masteredPercent}%` }}></span></div>
              <strong>{masteredPercent}%</strong>
            </section>
          ) : null}
        </>
      )}

      {view === 'learn' && (!learnTopic ? <section className="card"><div className="section-heading"><div><div className="eyebrow">LEARNING PATH</div><h2>Chọn chủ đề</h2></div><span className="count-pill">{topics.length} topics</span></div><div className="topic-list">{topics.map(item => <button className="topic-row" key={item.topic_id} onClick={() => openTopic(item.topic_id)}><span className="topic-icon"><BookOpen size={18} /></span><span><b>{item.topic_vi}</b><small>{item.count} từ · {merged.filter(entry => entry.topic_id === item.topic_id && entry.status === 'mastered').length} đã học</small></span><ChevronRight size={18} /></button>)}</div></section> : <section className="topic-study"><div className="study-heading"><button className="back-button" onClick={() => setLearnTopic('')}>← Tất cả chủ đề</button><div className="study-title"><div><div className="eyebrow">LEARN · {topics.find(item => item.topic_id === learnTopic)?.topic_vi}</div><h2>Flashcard</h2></div><span className="count-pill">{topicLearned.length} / {topicWords.length} đã học</span></div><div className="study-progress"><span style={{ width: (topicWords.length ? topicLearned.length / topicWords.length * 100 : 0) + '%' }}></span></div></div>{learnCurrent && <><div className="flashcard-switcher"><span className="side-word previous-word">{previousWord?.word || 'Từ trước'}</span><button className={learnCurrent.status === 'mastered' ? 'status-toggle known' : 'status-toggle unknown'} aria-pressed={learnCurrent.status === 'mastered'} onClick={toggleLearnStatus}>{learnCurrent.status === 'mastered' ? 'Đã thuộc' : 'Chưa thuộc'}</button><span className="side-word next-word">{nextWord?.word || 'Từ tiếp'}</span></div><div className="learn-card card" onClick={event => { if (event.currentTarget.dataset.swiped === 'true') { event.currentTarget.dataset.swiped = 'false'; return; } setAnswer(value => !value); }} onTouchStart={event => { event.currentTarget.dataset.touchX = event.changedTouches[0].clientX; event.currentTarget.dataset.swiped = 'false'; }} onTouchEnd={event => { const start = Number(event.currentTarget.dataset.touchX); const delta = event.changedTouches[0].clientX - start; if (Math.abs(delta) > 55) { event.currentTarget.dataset.swiped = 'true'; moveLearn(delta < 0 ? 1 : -1); } }}><button className={learnCurrent.favorite ? 'heart active learn-heart' : 'heart learn-heart'} aria-label={`Favorite ${learnCurrent.word}`} onClick={event => { event.stopPropagation(); toggleFavorite(learnCurrent); }}>{learnCurrent.favorite ? <Heart size={18} fill="currentColor" /> : <Heart size={18} />}</button><div className="card-position">Từ {safeLearnIndex + 1} / {topicWords.length}</div><h2>{learnCurrent.word}</h2>{learnCurrent.part_of_speech ? <div className="pos-pill">{learnCurrent.part_of_speech}</div> : null}<div className="ipa">{learnCurrent.ipa || 'IPA chưa có'} <button className="sound-button" disabled={audioLoading === learnCurrent.word.toLowerCase()} onClick={event => { event.stopPropagation(); playPronunciation(learnCurrent); }} aria-label={`Play pronunciation for ${learnCurrent.word}`}><Volume2 size={16} /></button></div><div className="answer-slot">{!answer ? <button className="answer-peek" onClick={event => { event.stopPropagation(); setAnswer(true); }}>Show me</button> : <div className="answer"><h3>{learnCurrent.meaning_vi || 'Chưa có nghĩa'}</h3><div className="examples-list">{(learnCurrent.examples?.length ? learnCurrent.examples : ['Chưa có ví dụ']).map((example, index) => <p key={index}>{example}</p>)}</div><span className="tap-hint">Chạm card hoặc vuốt để chuyển từ</span></div>}</div></div></>}</section>)}

      {view === 'dictionary' && (
        <section className="card dictionary-card">
          <div className="section-heading dictionary-heading">
            <div>
              <div className="eyebrow">REFERENCE</div>
              <h2>Dictionary</h2>
            </div>
            <div className="dictionary-heading-actions">
              <span className="count-pill">{list.length} từ</span>
              <button className="new-word-button" onClick={openNewWordForm}><Plus size={16} /> New word</button>
            </div>
          </div>

          <div className="search-wrap dictionary-search">
            <Search size={18} />
            <input className="search" placeholder="Tìm mọi từ..." value={query} onChange={event => setQuery(event.target.value)} />
          </div>

          <div className="chips dictionary-chips">
            <button className={filter === 'all' && topic === 'all' ? 'chip active' : 'chip'} onClick={() => { setFilter('all'); setTopic('all'); }}>Tất cả</button>
            <button className={filter === 'today' ? 'chip active' : 'chip'} onClick={() => { setFilter('today'); setTopic('all'); }}>Hôm nay</button>
            {topics.slice(0, 7).map(item => (
              <button className={topic === item.topic_id ? 'chip active' : 'chip'} key={item.topic_id} onClick={() => { setFilter('all'); setTopic(item.topic_id); }}>
                {item.topic_vi}
              </button>
            ))}
          </div>

          <div className="word-list">
            {list.slice(0, 150).map(entry => (
              <div className="word" role="button" tabIndex={0} key={entry.id} onClick={() => { setCard(entry); setAnswer(false); }}>
                <div className="word-main">
                  <div className="word-title">
                    <b>{entry.word}</b>
                    <small>{entry.part_of_speech || ''}</small>
                  </div>
                  <p>{entry.meaning_vi || 'Chưa có nghĩa'}</p>
                </div>
                <button className={entry.favorite ? 'heart active' : 'heart'} aria-label={`Favorite ${entry.word}`} onClick={event => { event.stopPropagation(); toggleFavorite(entry); }}>
                  {entry.favorite ? <Heart size={19} fill="currentColor" /> : <Heart size={19} />}
                </button>
              </div>
            ))}
          </div>

          {!list.length ? (
            <div className="dictionary-empty">
              <div className="empty-icon"><Search size={22} /></div>
              <h3>Không có từ phù hợp</h3>
              <p>Thử đổi bộ lọc hoặc tìm kiếm bằng từ khác.</p>
            </div>
          ) : null}
        </section>
      )}

      {view === 'review' && (
        <section className="card review-list-card">
          <div className="section-heading dictionary-heading">
            <div>
              <div className="eyebrow">REVIEW</div>
              <h2>Review list</h2>
            </div>
            <span className="count-pill">{reviewQueue.length} từ</span>
          </div>

          {reviewQueue.length ? (
            <div className="word-list review-list">
              {reviewQueue.map(entry => (
                <div className="word review-word" key={entry.id}>
                  <div className="word-main">
                    <div className="word-title">
                      <b>{entry.word}</b>
                      <small>{entry.part_of_speech || ''}</small>
                    </div>
                    <p>{entry.meaning_vi || 'Chưa có nghĩa'}</p>
                  </div>
                  <div className="review-row-actions">
                    <button className="sound-button" disabled={audioLoading === entry.word.toLowerCase()} onClick={() => playPronunciation(entry)} aria-label={`Play pronunciation for ${entry.word}`}>
                      <Volume2 size={16} />
                    </button>
                    <button className={entry.favorite ? 'heart active' : 'heart'} aria-label={`Favorite ${entry.word}`} onClick={() => toggleFavorite(entry)}>
                      {entry.favorite ? <Heart size={18} fill="currentColor" /> : <Heart size={18} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="dictionary-empty">
              <div className="empty-icon"><Check size={24} /></div>
              <h3>Không có từ cần ôn</h3>
              <p>Hãy vào Dictionary để bấm heart hoặc vào Learn để học thêm từ mới.</p>
            </div>
          )}
        </section>
      )}

      {view === 'settings' && (
        <>
          <section className="card settings-card">
            <div className="settings-card-head">
              <div>
                <div className="eyebrow">LOCAL DATA</div>
                <h2>Settings</h2>
              </div>
              <span className="settings-badge">IndexedDB</span>
            </div>
            <p className="settings-copy">Dữ liệu được lưu cục bộ trên thiết bị này. Export backup trước khi đổi máy.</p>

            <div className="setting-row">
              <div>
                <span>Daily goal</span>
                <small>Số từ muốn học mỗi ngày</small>
              </div>
              <div className="goal-stepper">
                <button onClick={() => updateSettings(prev => ({ ...prev, goal: Math.max(1, goal - 1) }))}>−</button>
                <input type="number" min="1" max="200" value={goal} onChange={event => updateSettings(prev => ({ ...prev, goal: Number(event.target.value) || 20 }))} />
                <button onClick={() => updateSettings(prev => ({ ...prev, goal: Math.min(200, goal + 1) }))}>+</button>
              </div>
            </div>

            <div className="settings-actions">
              <button className="settings-action" onClick={backup}>
                <span><Download size={18} /></span>
                <div><b>Export backup</b><small>Tải JSON dữ liệu hiện tại</small></div>
              </button>
              <label className="settings-action primary">
                <span><Upload size={18} /></span>
                <div><b>Import backup</b><small>Khôi phục từ file JSON</small></div>
                <input type="file" accept=".json" onChange={importFile} />
              </label>
            </div>
          </section>

          <section className="card settings-card compact">
            <div className="settings-card-head">
              <div>
                <div className="eyebrow">DEVICE</div>
                <h3>iPhone 15 Pro Max</h3>
              </div>
              <span className="settings-badge">PWA</span>
            </div>
            <p className="settings-copy">Safe-area, standalone mode và vùng chạm tối thiểu 44px.</p>
          </section>
        </>
      )}

      {newWordOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setNewWordOpen(false)}>
          <section className="new-word-panel" role="dialog" aria-modal="true" aria-labelledby="new-word-title" onClick={event => event.stopPropagation()}>
            <div className="new-word-top">
              <div>
                <div className="eyebrow">ADD WORD</div>
                <h3 id="new-word-title">New word</h3>
              </div>
              <button className="icon-button" onClick={() => setNewWordOpen(false)} aria-label="Close new word form"><X size={18} /></button>
            </div>
            <div className="new-word-grid">
              <label>Word<input value={newWordForm.word} onChange={event => setNewWordForm(prev => ({ ...prev, word: event.target.value }))} placeholder="beautiful" /></label>
              <label>Save to<input value={MY_SHELF_TOPIC.topic_vi} disabled /></label>
              <label>Part of speech<input value={newWordForm.part_of_speech} onChange={event => setNewWordForm(prev => ({ ...prev, part_of_speech: event.target.value }))} placeholder="n., v., adj." /></label>
              <label>IPA<input value={newWordForm.ipa} onChange={event => setNewWordForm(prev => ({ ...prev, ipa: event.target.value }))} placeholder="/ˈwɝːd/" /></label>
              <label className="full-field">Meaning VI<input value={newWordForm.meaning_vi} onChange={event => setNewWordForm(prev => ({ ...prev, meaning_vi: event.target.value }))} placeholder="nghĩa tiếng Việt" /></label>
              <label className="full-field">Examples<textarea value={newWordForm.examplesText} onChange={event => setNewWordForm(prev => ({ ...prev, examplesText: event.target.value }))} placeholder="Mỗi ví dụ một dòng" rows={3} /></label>
            </div>
            {newWordMessage ? <p className="form-message">{newWordMessage}</p> : null}
            <div className="new-word-actions">
              <button className="secondary-button" disabled={newWordLoading} onClick={fetchNewWordInfo}>{newWordLoading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Get info</button>
              <button className="primary-button" onClick={saveNewWord}>Save</button>
            </div>
          </section>
        </div>
      ) : null}

      {card ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setCard(null)}>
          <section className="dictionary-detail-card" role="dialog" aria-modal="true" aria-labelledby="dictionary-card-title" onClick={event => event.stopPropagation()}>
            <div className="detail-card-top">
              <button className={card.favorite ? 'heart active' : 'heart'} aria-label={`Favorite ${card.word}`} onClick={() => toggleFavorite(card)}>
                {card.favorite ? <Heart size={19} fill="currentColor" /> : <Heart size={19} />}
              </button>
              <button className="icon-button" onClick={() => setCard(null)} aria-label="Close word card"><X size={18} /></button>
            </div>
            <div className="card-position">{card.topic_vi || topics.find(item => item.topic_id === card.topic_id)?.topic_vi || 'Dictionary'}</div>
            <h2 id="dictionary-card-title">{card.word}</h2>
            {card.part_of_speech ? <div className="pos-pill">{card.part_of_speech}</div> : null}
            <div className="ipa">{card.ipa || 'IPA chưa có'} <button className="sound-button" disabled={audioLoading === card.word.toLowerCase()} onClick={() => playPronunciation(card)} aria-label={`Play pronunciation for ${card.word}`}><Volume2 size={16} /></button></div>
            <div className="detail-answer">
              <h3>{card.meaning_vi || 'Chưa có nghĩa'}</h3>
              <div className="examples-list">{(card.examples?.length ? card.examples : ['Chưa có ví dụ']).map((example, index) => <p key={index}>{example}</p>)}</div>
            </div>
            {card.user_created ? <button className="danger-button" onClick={() => deleteUserWord(card)}>Xoá khỏi DB</button> : null}
          </section>
        </div>
      ) : null}

      {audioLoading && <div className="audio-toast" role="status"><LoaderCircle className="spin" size={16} /> {audioMessage}</div>}
      {audioMessage && !audioLoading && audioMessage.startsWith('Không') && <div className="audio-toast audio-error" role="alert">{audioMessage}</div>}
      <nav className="bottom-nav">{nav.map(([id, Icon, label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => { setView(id); setAnswer(false); }}><Icon size={20} /><span>{label}</span></button>)}</nav>
    </main>
  );
}
