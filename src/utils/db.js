import { openDB } from 'idb';

const DB_NAME = 'robocam_db';
const DB_VERSION = 1;

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('recordings')) {
          const recStore = db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
          recStore.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('presets')) {
          const presetStore = db.createObjectStore('presets', { keyPath: 'id', autoIncrement: true });
          presetStore.createIndex('name', 'name');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

// Recordings
export async function saveRecording(blob, metadata) {
  const db = await getDB();
  const id = await db.add('recordings', {
    blob,
    createdAt: Date.now(),
    size: blob.size,
    ...metadata,
  });
  return id;
}

export async function getAllRecordings() {
  const db = await getDB();
  return db.getAll('recordings');
}

export async function updateRecording(id, updates) {
  const db = await getDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = await store.get(id);
  if (!record) return null;
  const newRecord = { ...record, ...updates };
  await store.put(newRecord);
  return newRecord;
}

export async function deleteRecording(id) {
  const db = await getDB();
  return db.delete('recordings', id);
}

// Presets
export async function savePreset(preset) {
  const db = await getDB();
  if (preset.id) {
    await db.put('presets', preset);
    return preset.id;
  }
  return db.add('presets', { ...preset, createdAt: Date.now() });
}

export async function getAllPresets() {
  const db = await getDB();
  return db.getAll('presets');
}

export async function deletePreset(id) {
  const db = await getDB();
  return db.delete('presets', id);
}

// Settings
export async function saveSetting(key, value) {
  const db = await getDB();
  return db.put('settings', { key, value });
}

export async function getSetting(key, defaultValue = null) {
  const db = await getDB();
  const result = await db.get('settings', key);
  return result ? result.value : defaultValue;
}
