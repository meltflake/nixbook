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
        // Key: bookId + paragraph hash, Value: { bookId, hash, original, translation }
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
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite')
    tx.objectStore('books').put(book)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function getBook(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('books').objectStore('books').get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getAllBooks() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('books').objectStore('books').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteBook(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite')
    tx.objectStore('books').delete(id)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// --- Vocabulary (single words) ---
export async function saveWord(word, translation = '', bookTitle = '') {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vocabulary', 'readwrite')
    const store = tx.objectStore('vocabulary')
    const getReq = store.get(word.toLowerCase())
    getReq.onsuccess = () => {
      if (!getReq.result) {
        // New word - initialize with spaced repetition fields
        store.put({
          word: word.toLowerCase(),
          translation: translation,
          addedAt: Date.now(),
          book: bookTitle,
          count: 1,
          // Spaced repetition fields
          nextReview: Date.now(), // Review immediately
          interval: 0,           // Days until next review
          easeFactor: 2.5        // SM-2 default
        })
      } else {
        const existing = getReq.result
        existing.count = (existing.count || 1) + 1
        if (translation && !existing.translation) {
          existing.translation = translation
        }
        store.put(existing)
      }
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function updateWordReview(word, quality) {
  // quality: 0-2 = forgot, 3-5 = remembered (SM-2 scale)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vocabulary', 'readwrite')
    const store = tx.objectStore('vocabulary')
    const getReq = store.get(word.toLowerCase())
    getReq.onsuccess = () => {
      if (!getReq.result) return
      const card = getReq.result
      
      // Simplified SM-2 algorithm
      if (quality < 3) {
        // Forgot - reset
        card.interval = 0
        card.nextReview = Date.now()
      } else {
        // Remembered
        if (card.interval === 0) {
          card.interval = 1
        } else if (card.interval === 1) {
          card.interval = 3
        } else {
          card.interval = Math.round(card.interval * card.easeFactor)
        }
        // Adjust ease factor
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
        .filter(w => w.nextReview <= now && w.translation)
        .sort((a, b) => a.nextReview - b.nextReview)
        .slice(0, limit)
      resolve(due)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getAllVocabulary() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('vocabulary').objectStore('vocabulary').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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
export async function saveHighlight(highlight) {
  // highlight: { bookId, bookTitle, text, cfi?, addedAt }
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    const store = tx.objectStore('highlights')
    highlight.addedAt = highlight.addedAt || Date.now()
    const req = store.add(highlight)
    req.onsuccess = () => resolve(req.result) // returns the auto-generated id
    tx.onerror = () => reject(tx.error)
  })
}

export async function getHighlightsByBook(bookId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights')
    const index = tx.objectStore('highlights').index('bookId')
    const req = index.getAll(bookId)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getAllHighlights() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction('highlights').objectStore('highlights').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteHighlight(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    tx.objectStore('highlights').delete(id)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function deleteHighlightByText(bookId, text) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite')
    const store = tx.objectStore('highlights')
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        if (cursor.value.bookId === bookId && cursor.value.text === text) {
          cursor.delete()
          resolve(true)
          return
        }
        cursor.continue()
      } else {
        resolve(false) // Not found
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
// Simple hash function for paragraph text
function hashText(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(36)
}

export { hashText }

export async function saveTranslation(bookId, original, translation) {
  const db = await openDB()
  const hash = hashText(original)
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations', 'readwrite')
    tx.objectStore('translations').put({
      bookId,
      hash,
      original,
      translation,
      savedAt: Date.now()
    })
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

export async function getBookTranslations(bookId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('translations')
    const index = tx.objectStore('translations').index('bookId')
    const req = index.getAll(bookId)
    req.onsuccess = () => {
      // Return as a map: hash -> translation
      const map = {}
      for (const t of req.result) {
        map[t.hash] = t.translation
      }
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
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
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
    for (const t of translations) {
      store.put(t)
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}
