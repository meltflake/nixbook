const DB_NAME = 'epub-reader'
const DB_VERSION = 4  // Upgraded for translations store

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('vocabulary')) {
        const vocabStore = db.createObjectStore('vocabulary', { keyPath: 'word' })
        vocabStore.createIndex('addedAt', 'addedAt')
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const hlStore = db.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true })
        hlStore.createIndex('bookId', 'bookId')
        hlStore.createIndex('addedAt', 'addedAt')
      }
      if (!db.objectStoreNames.contains('translations')) {
        const transStore = db.createObjectStore('translations', { keyPath: ['bookId', 'hash'] })
        transStore.createIndex('bookId', 'bookId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// --- Books ---
export async function saveBook(book) {
  // Separate epub file → Cache API (not IndexedDB)
  if (book.file) {
    await cacheEpubFile(book.id, book.file)
  }
  // Convert coverBlob to thumbnail data URL string if it's a Blob
  if (book.coverBlob && book.coverBlob instanceof Blob) {
    const dataUrl = await blobToThumbnailDataURL(book.coverBlob)
    if (dataUrl) book.coverDataURL = dataUrl
  }
  // Store metadata only (no large blobs) in IndexedDB
  const { file, coverBlob, ...metadata } = book
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite')
    tx.objectStore('books').put(metadata)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function getBook(id) {
  const db = await openDB()
  const metadata = await new Promise((resolve, reject) => {
    const req = db.transaction('books').objectStore('books').get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  if (!metadata) return null
  // Reassemble: load epub from Cache API
  const file = await getCachedEpub(id)
  return { ...metadata, file: file || null }
}

export async function getAllBooks() {
  const db = await openDB()
  const books = await new Promise((resolve, reject) => {
    const req = db.transaction('books').objectStore('books').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  // Return metadata only (no file loading) — callers use getBook(id) when they need the file
  return books
}

export async function deleteBook(id) {
  await deleteCachedEpub(id)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite')
    tx.objectStore('books').delete(id)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// --- Vocabulary (single words) ---
// LWW soft-delete: records have optional `deletedAt`. When set, the word is "deleted".
// Re-adding a deleted word clears `deletedAt`.
export async function saveWord(word, translation = '', bookTitle = '') {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vocabulary', 'readwrite')
    const store = tx.objectStore('vocabulary')
    const getReq = store.get(word.toLowerCase())
    getReq.onsuccess = () => {
      const existing = getReq.result
      if (!existing) {
        store.put({
          word: word.toLowerCase(),
          translation: translation,
          addedAt: Date.now(),
          book: bookTitle,
          count: 1,
          nextReview: Date.now(),
          interval: 0,
          easeFactor: 2.5
        })
      } else {
        existing.count = (existing.count || 1) + 1
        if (translation && !existing.translation) existing.translation = translation
        // Revive if soft-deleted
        if (existing.deletedAt) delete existing.deletedAt
        existing.addedAt = existing.addedAt || Date.now()
        store.put(existing)
      }
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function updateWordReview(word, quality) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vocabulary', 'readwrite')
    const store = tx.objectStore('vocabulary')
    const getReq = store.get(word.toLowerCase())
    getReq.onsuccess = () => {
      if (!getReq.result) return
      const card = getReq.result
      if (quality < 3) {
        card.interval = 0
        card.nextReview = Date.now()
      } else {
        if (card.interval === 0) card.interval = 1
        else if (card.interval === 1) card.interval = 3
        else card.interval = Math.round(card.interval * card.easeFactor)
        card.easeFactor = Math.max(1.3, card.easeFactor + (0.1 - (5 - quality) * 0.08))
        card.nextReview = Date.now() + card.interval * 24 * 60 * 60 * 1000
      }
      store.put(card)
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function getWordsForReview(limit = 20) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('vocabulary').objectStore('vocabulary').getAll()
    req.onsuccess = () => {
      const now = Date.now()
      const due = req.result
        .filter(w => !w.deletedAt && w.nextReview <= now && w.translation)
        .sort((a, b) => a.nextReview - b.nextReview)
        .slice(0, limit)
      resolve(due)
    }
    req.onerror = () => reject(req.error)
  })
}

// Returns ALL records including soft-deleted (for sync export)
export async function getAllVocabulary() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('vocabulary').objectStore('vocabulary').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Returns only active (non-deleted) records (for display)
export async function getActiveVocabulary() {
  const all = await getAllVocabulary()
  return all.filter(w => !w.deletedAt)
}

// Soft-delete: set deletedAt instead of removing
export async function deleteWord(word) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vocabulary', 'readwrite')
    const store = tx.objectStore('vocabulary')
    const getReq = store.get(word.toLowerCase())
    getReq.onsuccess = () => {
      if (getReq.result) {
        const record = getReq.result
        record.deletedAt = Date.now()
        store.put(record)
      }
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearVocabulary() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vocabulary', 'readwrite')
    tx.objectStore('vocabulary').clear()
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// --- Highlights (sentences/passages) ---
// LWW soft-delete: records have optional `deletedAt`.
// Key for identity: `bookId:text`
export async function saveHighlight(highlight) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    const store = tx.objectStore('highlights')
    highlight.addedAt = highlight.addedAt || Date.now()
    
    // Check if a soft-deleted version exists — revive it
    const req = store.openCursor()
    let found = false
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        if (cursor.value.bookId === highlight.bookId && cursor.value.text === highlight.text) {
          // Revive: clear deletedAt, update addedAt
          const existing = cursor.value
          delete existing.deletedAt
          existing.addedAt = highlight.addedAt
          existing.bookTitle = highlight.bookTitle || existing.bookTitle
          store.put(existing)
          found = true
          return // Don't continue cursor
        }
        cursor.continue()
      } else if (!found) {
        // Not found — add new
        store.add(highlight)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getHighlightsByBook(bookId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights')
    const index = tx.objectStore('highlights').index('bookId')
    const req = index.getAll(bookId)
    req.onsuccess = () => resolve(req.result.filter(h => !h.deletedAt))
    req.onerror = () => reject(req.error)
  })
}

// Returns ALL records including soft-deleted (for sync export)
export async function getAllHighlights() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('highlights').objectStore('highlights').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Returns only active (non-deleted) records (for display)
export async function getActiveHighlights() {
  const all = await getAllHighlights()
  return all.filter(h => !h.deletedAt)
}

export async function deleteHighlight(id) {
  // Soft-delete by id
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    const store = tx.objectStore('highlights')
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      if (getReq.result) {
        const record = getReq.result
        record.deletedAt = Date.now()
        store.put(record)
      }
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// Soft-delete by bookId + text
export async function deleteHighlightByText(bookId, text) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    const store = tx.objectStore('highlights')
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        if (cursor.value.bookId === bookId && cursor.value.text === text && !cursor.value.deletedAt) {
          const record = cursor.value
          record.deletedAt = Date.now()
          store.put(record)
          resolve(true)
          return
        }
        cursor.continue()
      } else {
        resolve(false)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

export async function clearHighlights() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    tx.objectStore('highlights').clear()
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// --- Translations ---
function hashText(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(36)
}

export { hashText }

export async function saveTranslation(bookId, original, translation) {
  const db = await openDB()
  const hash = hashText(original)
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations', 'readwrite')
    tx.objectStore('translations').put({ bookId, hash, original, translation, savedAt: Date.now() })
    tx.oncomplete = () => resolve(hash)
    tx.onerror = () => reject(tx.error)
  })
}

export async function getTranslation(bookId, original) {
  const db = await openDB()
  const hash = hashText(original)
  return new Promise((resolve, reject) => {
    const req = db.transaction('translations').objectStore('translations').get([bookId, hash])
    req.onsuccess = () => resolve(req.result?.translation || null)
    req.onerror = () => reject(req.error)
  })
}

export async function getAllTranslationCounts() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations')
    const store = tx.objectStore('translations')
    const req = store.openCursor()
    const counts = {}
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        const bookId = cursor.value.bookId
        counts[bookId] = (counts[bookId] || 0) + 1
        cursor.continue()
      } else resolve(counts)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getBookTranslations(bookId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations')
    const index = tx.objectStore('translations').index('bookId')
    const req = index.getAll(bookId)
    req.onsuccess = () => {
      const map = {}
      for (const t of req.result) map[t.hash] = t.translation
      resolve(map)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function clearBookTranslations(bookId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations', 'readwrite')
    const store = tx.objectStore('translations')
    const index = store.index('bookId')
    const req = index.openCursor(bookId)
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) { cursor.delete(); cursor.continue() }
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function getAllTranslations() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('translations').objectStore('translations').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function importTranslations(translations) {
  if (!translations || !Array.isArray(translations)) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations', 'readwrite')
    const store = tx.objectStore('translations')
    for (const t of translations) store.put(t)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// ========== Cache API for epub files ==========
const EPUB_CACHE = 'nixbook-epub-files'

export async function cacheEpubFile(bookId, file) {
  try {
    const cache = await caches.open(EPUB_CACHE)
    const response = new Response(file, { headers: { 'Content-Type': 'application/epub+zip' } })
    await cache.put(`/epub/${bookId}`, response)
  } catch (e) { console.warn('Failed to cache epub:', e) }
}

export async function getCachedEpub(bookId) {
  try {
    const cache = await caches.open(EPUB_CACHE)
    const response = await cache.match(`/epub/${bookId}`)
    if (!response) return null
    const blob = await response.blob()
    return new File([blob], `${bookId}.epub`, { type: 'application/epub+zip' })
  } catch { return null }
}

export async function deleteCachedEpub(bookId) {
  try {
    const cache = await caches.open(EPUB_CACHE)
    await cache.delete(`/epub/${bookId}`)
  } catch {}
}

// ========== Cover thumbnails ==========
// Convert cover blob to a small data URL string (~5-10KB)
export async function blobToThumbnailDataURL(blob, maxWidth = 200) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const ratio = maxWidth / img.width
      const canvas = document.createElement('canvas')
      canvas.width = maxWidth
      canvas.height = Math.round(img.height * ratio)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(img.src)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null) }
    img.src = URL.createObjectURL(blob)
  })
}
