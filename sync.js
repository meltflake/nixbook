// Sync Module - Coordinates between IndexedDB and Dropbox
import { getAllBooks, getAllVocabulary, getAllHighlights, getBookTranslations, importTranslations, saveBook } from './db.js'
import { 
  isDropboxConfigured, isLoggedIn, uploadData, downloadData, 
  uploadBook, downloadBook, listBooks,
  uploadBookTranslations, downloadBookTranslations
} from './dropbox.js'

// Export all local data (translations are synced separately per book)
export async function exportLocalData() {
  const books = await getAllBooks()
  const vocabulary = await getAllVocabulary()
  const highlights = await getAllHighlights()
  
  // Don't include the actual file blobs in the export
  const booksMetadata = books.map(b => ({
    id: b.id,
    title: b.title,
    author: b.author,
    addedAt: b.addedAt,
    lastReadAt: b.lastReadAt,
    progress: b.progress,
    lastLocation: b.lastLocation,
    // coverBlob and file not included
    // translations synced separately to /translations/{bookId}.json
  }))
  
  return {
    version: 1,
    exportedAt: Date.now(),
    books: booksMetadata,
    vocabulary,
    highlights,
    // translations not included here - synced per-book
  }
}

// Import data to local IndexedDB
export async function importData(data, db) {
  if (!data) return
  
  // Import vocabulary
  if (data.vocabulary && Array.isArray(data.vocabulary)) {
    const { openDB } = await import('./db.js')
    // This is handled in the merge logic below
  }
  
  // Import highlights  
  if (data.highlights && Array.isArray(data.highlights)) {
    // This is handled in the merge logic below
  }
  
  // Books metadata is merged with local, actual files synced separately
}

// Full sync with Dropbox
export async function syncWithDropbox(progressCallback) {
  if (!isDropboxConfigured() || !isLoggedIn()) {
    return { success: false, error: 'Not configured or not logged in' }
  }
  
  try {
    progressCallback?.('正在下载云端数据...')
    
    // 1. Download remote data
    const remoteData = await downloadData()
    
    // 2. Get local data
    progressCallback?.('正在读取本地数据...')
    const localData = await exportLocalData()
    
    // 3. Merge data (remote wins for conflicts, but we keep both unique items)
    progressCallback?.('正在合并数据...')
    const mergedData = mergeData(localData, remoteData)
    
    // 4. Apply merged data to local IndexedDB
    progressCallback?.('正在更新本地数据库...')
    await applyMergedData(mergedData)
    
    // 5. Upload merged data back to Dropbox
    progressCallback?.('正在上传到云端...')
    await uploadData(mergedData)
    
    // 6. Sync book files
    progressCallback?.('正在同步书籍文件...')
    await syncBookFiles(mergedData.books, progressCallback)
    
    progressCallback?.('同步完成!')
    return { success: true }
    
  } catch (e) {
    console.error('Sync error:', e)
    return { success: false, error: e.message }
  }
}

// Merge local and remote data
function mergeData(local, remote) {
  if (!remote) return local
  
  const merged = {
    version: 1,
    exportedAt: Date.now(),
    books: [],
    vocabulary: [],
    highlights: [],
  }
  
  // Merge books (by id)
  const booksMap = new Map()
  for (const book of (remote.books || [])) {
    booksMap.set(book.id, book)
  }
  for (const book of (local.books || [])) {
    const existing = booksMap.get(book.id)
    if (existing) {
      // Keep the one with more recent activity
      if ((book.lastReadAt || 0) > (existing.lastReadAt || 0)) {
        booksMap.set(book.id, book)
      }
    } else {
      booksMap.set(book.id, book)
    }
  }
  merged.books = Array.from(booksMap.values())
  
  // Merge vocabulary (by word)
  const vocabMap = new Map()
  for (const word of (remote.vocabulary || [])) {
    vocabMap.set(word.word, word)
  }
  for (const word of (local.vocabulary || [])) {
    const existing = vocabMap.get(word.word)
    if (existing) {
      // Merge: keep higher count, more recent review data
      vocabMap.set(word.word, {
        ...existing,
        ...word,
        count: Math.max(existing.count || 1, word.count || 1),
        // Keep the review state from whichever is more "progressed"
        interval: Math.max(existing.interval || 0, word.interval || 0),
      })
    } else {
      vocabMap.set(word.word, word)
    }
  }
  merged.vocabulary = Array.from(vocabMap.values())
  
  // Merge highlights (by text + bookId, dedupe)
  const highlightSet = new Set()
  const highlights = []
  for (const hl of [...(remote.highlights || []), ...(local.highlights || [])]) {
    const key = `${hl.bookId}:${hl.text}`
    if (!highlightSet.has(key)) {
      highlightSet.add(key)
      highlights.push(hl)
    }
  }
  merged.highlights = highlights
  
  // Translations are synced separately per book
  
  return merged
}

// Apply merged data to local IndexedDB
async function applyMergedData(data) {
  const DB_NAME = 'epub-reader'
  const DB_VERSION = 4  // Updated for translations
  
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  
  // Update vocabulary
  const vocabTx = db.transaction('vocabulary', 'readwrite')
  const vocabStore = vocabTx.objectStore('vocabulary')
  for (const word of (data.vocabulary || [])) {
    vocabStore.put(word)
  }
  await new Promise((resolve, reject) => {
    vocabTx.oncomplete = resolve
    vocabTx.onerror = () => reject(vocabTx.error)
  })
  
  // Update highlights
  const hlTx = db.transaction('highlights', 'readwrite')
  const hlStore = hlTx.objectStore('highlights')
  // Clear and re-add to avoid duplicates with auto-increment IDs
  hlStore.clear()
  for (const hl of (data.highlights || [])) {
    const { id, ...hlWithoutId } = hl // Remove id to let IndexedDB auto-generate
    hlStore.add(hlWithoutId)
  }
  await new Promise((resolve, reject) => {
    hlTx.oncomplete = resolve
    hlTx.onerror = () => reject(hlTx.error)
  })
  
  // Translations are synced separately per book (not in main data file)
  
  // Books metadata is handled separately with file sync
  
  db.close()
}

// Sync book files between local and Dropbox
async function syncBookFiles(booksMeta, progressCallback) {
  const localBooks = await getAllBooks()
  const localBooksMap = new Map(localBooks.map(b => [b.id, b]))
  
  // Get list of books in Dropbox
  let remoteBookIds = []
  try {
    remoteBookIds = await listBooks()
  } catch (e) {
    console.warn('Could not list remote books:', e)
  }
  
  // Upload local books that aren't in Dropbox
  for (const book of localBooks) {
    if (book.file && !remoteBookIds.includes(book.id)) {
      progressCallback?.(`上传书籍: ${book.title}...`)
      try {
        await uploadBook(book.id, book.file)
      } catch (e) {
        console.error(`Failed to upload book ${book.id}:`, e)
      }
    }
  }
  
  // Download remote books that aren't local
  for (const bookId of remoteBookIds) {
    if (!localBooksMap.has(bookId)) {
      const meta = booksMeta.find(b => b.id === bookId)
      if (meta) {
        progressCallback?.(`下载书籍: ${meta.title || bookId}...`)
        try {
          const blob = await downloadBook(bookId)
          if (blob) {
            await saveBook({
              ...meta,
              file: new File([blob], `${meta.title || bookId}.epub`, { type: 'application/epub+zip' }),
            })
          }
        } catch (e) {
          console.error(`Failed to download book ${bookId}:`, e)
        }
      }
    }
  }
}

// Quick push local changes to Dropbox (without full merge)
export async function pushToDropbox() {
  if (!isDropboxConfigured() || !isLoggedIn()) {
    return { success: false, error: 'Not configured or not logged in' }
  }
  
  try {
    const localData = await exportLocalData()
    await uploadData(localData)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// Sync translations for a specific book
export async function syncBookTranslations(bookId) {
  if (!isDropboxConfigured() || !isLoggedIn()) {
    return { success: false, error: 'Not configured or not logged in' }
  }
  
  try {
    // Get local translations for this book
    const localTranslations = await getBookTranslations(bookId)
    const localArray = Object.entries(localTranslations).map(([hash, translation]) => ({
      hash,
      translation
    }))
    
    // Try to download remote translations
    let remoteTranslations = null
    try {
      remoteTranslations = await downloadBookTranslations(bookId)
    } catch (e) {
      console.log('No remote translations found for book:', bookId)
    }
    
    // Merge: remote + local (local wins on conflicts)
    const merged = {}
    if (remoteTranslations && Array.isArray(remoteTranslations)) {
      for (const t of remoteTranslations) {
        merged[t.hash] = t.translation
      }
    }
    for (const t of localArray) {
      merged[t.hash] = t.translation
    }
    
    // Convert back to array format for storage
    const mergedArray = Object.entries(merged).map(([hash, translation]) => ({
      hash,
      translation
    }))
    
    // Upload merged translations
    if (mergedArray.length > 0) {
      await uploadBookTranslations(bookId, mergedArray)
      console.log(`Synced ${mergedArray.length} translations for book ${bookId}`)
    }
    
    return { success: true, count: mergedArray.length }
  } catch (e) {
    console.error('Failed to sync book translations:', e)
    return { success: false, error: e.message }
  }
}
