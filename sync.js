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
  }))
  
  return {
    version: 1,
    exportedAt: Date.now(),
    books: booksMetadata,
    vocabulary,
    highlights,
  }
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
    
    // 3. Merge data (local-first: local wins unless remote is genuinely newer)
    progressCallback?.('正在合并数据...')
    const mergedData = mergeData(localData, remoteData)
    
    // 4. Apply merged data to local IndexedDB (defensive: won't overwrite newer local data)
    progressCallback?.('正在更新本地数据库...')
    await applyMergedData(mergedData)
    
    // 5. Re-read local data AFTER apply (in case applyMergedData skipped some updates)
    // This ensures we upload the TRUE latest state, not the merge result
    const freshLocalData = await exportLocalData()
    
    // 6. Upload fresh local data to Dropbox (source of truth = local IndexedDB)
    progressCallback?.('正在上传到云端...')
    await uploadData(freshLocalData)
    
    // 7. Sync book files
    progressCallback?.('正在同步书籍文件...')
    await syncBookFiles(freshLocalData.books, progressCallback)
    
    // 8. Sync translations for all books
    progressCallback?.('正在同步翻译...')
    for (const book of freshLocalData.books) {
      try {
        await syncBookTranslations(book.id)
      } catch (e) {
        console.warn('Translation sync failed for', book.id, e.message)
      }
    }
    
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
  
  // Merge books (by id) — local wins on progress if more recent
  const booksMap = new Map()
  for (const book of (local.books || [])) {
    booksMap.set(book.id, { ...book, _source: 'local' })
  }
  for (const book of (remote.books || [])) {
    const existing = booksMap.get(book.id)
    if (existing) {
      // Only take remote progress if remote is STRICTLY newer
      if ((book.lastReadAt || 0) > (existing.lastReadAt || 0)) {
        console.log(`📚 Sync: remote wins for "${book.title}": remote=${new Date(book.lastReadAt).toISOString()} local=${new Date(existing.lastReadAt).toISOString()} progress: ${existing.progress}→${book.progress}`)
        booksMap.set(book.id, { ...book, _source: 'remote' })
      } else {
        console.log(`📚 Sync: local wins for "${existing.title}": local=${new Date(existing.lastReadAt).toISOString()} remote=${new Date(book.lastReadAt || 0).toISOString()} progress: ${existing.progress}`)
      }
    } else {
      booksMap.set(book.id, { ...book, _source: 'remote' })
    }
  }
  merged.books = Array.from(booksMap.values()).map(({ _source, ...b }) => b)
  
  // Merge vocabulary (by word)
  const vocabMap = new Map()
  for (const word of (remote.vocabulary || [])) {
    vocabMap.set(word.word, word)
  }
  for (const word of (local.vocabulary || [])) {
    const existing = vocabMap.get(word.word)
    if (existing) {
      vocabMap.set(word.word, {
        ...existing,
        ...word,
        count: Math.max(existing.count || 1, word.count || 1),
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
  
  return merged
}

// Apply merged data to local IndexedDB
// DEFENSIVE: re-reads current local state and only overwrites if merged is newer
async function applyMergedData(data) {
  const DB_NAME = 'epub-reader'
  const DB_VERSION = 4
  
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
  hlStore.clear()
  for (const hl of (data.highlights || [])) {
    const { id, ...hlWithoutId } = hl
    hlStore.add(hlWithoutId)
  }
  await new Promise((resolve, reject) => {
    hlTx.oncomplete = resolve
    hlTx.onerror = () => reject(hlTx.error)
  })
  
  // Update books metadata — DEFENSIVE: only overwrite if merged is newer or equal
  const booksTx = db.transaction('books', 'readwrite')
  const booksStore = booksTx.objectStore('books')
  for (const book of (data.books || [])) {
    const existing = await new Promise(r => {
      const req = booksStore.get(book.id)
      req.onsuccess = () => r(req.result)
      req.onerror = () => r(null)
    })
    if (existing) {
      // CRITICAL: only update progress if merged data is at least as new as current local
      // This prevents a race where local was updated AFTER the merge was computed
      if ((book.lastReadAt || 0) >= (existing.lastReadAt || 0)) {
        booksStore.put({
          ...existing,
          progress: book.progress,
          lastLocation: book.lastLocation,
          lastReadAt: book.lastReadAt,
          title: book.title,
          author: book.author,
          coverBlob: book.coverBlob || existing.coverBlob,
        })
      } else {
        console.log(`📚 applyMergedData: SKIPPED overwrite for "${existing.title}" — local is newer (local=${existing.lastReadAt} > merged=${book.lastReadAt})`)
      }
    }
    // If book doesn't exist locally (no file), don't create a stub — syncBookFiles handles that
  }
  await new Promise((resolve, reject) => {
    booksTx.oncomplete = resolve
    booksTx.onerror = () => reject(booksTx.error)
  })
  
  db.close()
}

// Sync book files between local and Dropbox
async function syncBookFiles(booksMeta, progressCallback) {
  const localBooks = await getAllBooks()
  const localBooksMap = new Map(localBooks.map(b => [b.id, b]))
  
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

// Quick push: upload local state to Dropbox (no merge — used by reader on page turn)
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
    const localTranslations = await getBookTranslations(bookId)
    const localArray = Object.entries(localTranslations).map(([hash, translation]) => ({
      hash,
      translation
    }))
    
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
    
    const mergedArray = Object.entries(merged).map(([hash, translation]) => ({
      hash,
      translation
    }))
    
    if (mergedArray.length > 0) {
      const toImport = mergedArray.map(t => ({
        bookId,
        hash: t.hash,
        translation: t.translation,
        savedAt: Date.now()
      }))
      await importTranslations(toImport)
      await uploadBookTranslations(bookId, mergedArray)
      console.log(`Synced ${mergedArray.length} translations for book ${bookId}`)
    }
    
    return { success: true, count: mergedArray.length }
  } catch (e) {
    console.error('Failed to sync book translations:', e)
    return { success: false, error: e.message }
  }
}
