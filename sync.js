// Sync Module - LWW (Last-Writer-Wins) merge for multi-device sync
// 
// SYNC DESIGN (best practice for offline-first multi-device):
//
// 1. BOOKS (progress): LWW by `lastReadAt` — newer timestamp wins
// 2. HIGHLIGHTS: LWW-Element-Set by `bookId:text` key
//    - Each record has `addedAt` and optional `deletedAt`
//    - Active = no `deletedAt` or `addedAt > deletedAt`
//    - Merge: for same key, keep record with latest `max(addedAt, deletedAt)`
//    - "Delete wins" on tie (deletedAt >= addedAt)
// 3. VOCABULARY: LWW-Element-Set by `word` key — same as highlights
// 4. TRANSLATIONS: Additive merge (never deleted)
//
// No separate tombstone arrays needed — deletion state lives in the records themselves.

import { getAllBooks, getAllVocabulary, getAllHighlights, getBookTranslations, importTranslations, saveBook, getCachedEpub } from './db.js'
import { 
  isDropboxConfigured, isLoggedIn, uploadData, downloadData, 
  uploadBook, downloadBook, listBooks,
  uploadBookTranslations, downloadBookTranslations
} from './dropbox.js'

// Export all local data (includes soft-deleted records for sync)
export async function exportLocalData() {
  const books = await getAllBooks()
  const vocabulary = await getAllVocabulary()  // includes soft-deleted
  const highlights = await getAllHighlights()  // includes soft-deleted
  
  const booksMetadata = books.map(b => ({
    id: b.id,
    title: b.title,
    author: b.author,
    addedAt: b.addedAt,
    lastReadAt: b.lastReadAt,
    progress: b.progress,
    lastLocation: b.lastLocation,
    paragraphCount: b.paragraphCount || null,
  }))
  
  return {
    version: 2,  // v2: soft-delete model (no separate tombstone arrays)
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
    let remoteData
    try {
      remoteData = await downloadData()
      progressCallback?.(`云端数据: ${remoteData ? JSON.stringify({books: remoteData.books?.length, vocab: remoteData.vocabulary?.length, hl: remoteData.highlights?.length}) : 'null (文件不存在)'}`)
    } catch(dlErr) {
      progressCallback?.('❌ 下载失败: ' + dlErr.message)
      remoteData = null
    }
    
    progressCallback?.('正在读取本地数据...')
    const localData = await exportLocalData()
    
    for (const lb of (localData.books || [])) {
      const rb = (remoteData?.books || []).find(b => b.id === lb.id)
      console.log(`📚 SYNC [${lb.title}]: local progress=${Math.round((lb.progress||0)*100)}% readAt=${lb.lastReadAt}, remote progress=${rb ? Math.round((rb.progress||0)*100)+'%' : 'N/A'} readAt=${rb?.lastReadAt || 'N/A'}`)
    }
    for (const rb of (remoteData?.books || [])) {
      if (!(localData.books || []).find(b => b.id === rb.id)) {
        console.log(`📚 SYNC [${rb.title}]: remote-only progress=${Math.round((rb.progress||0)*100)}% readAt=${rb.lastReadAt}`)
      }
    }
    
    progressCallback?.(`正在合并数据... (本地${localData.books?.length || 0}本, 云端${remoteData?.books?.length || 0}本)`)
    const mergedData = mergeData(localData, remoteData)
    
    progressCallback?.(`正在更新本地数据库... (合并后${mergedData.books?.length || 0}本)`)
    await applyMergedData(mergedData)
    
    const freshLocalData = await exportLocalData()
    
    progressCallback?.(`正在上传到云端... (${freshLocalData.books?.length || 0}本)`)
    try {
      await uploadData(freshLocalData)
      progressCallback?.('上传成功')
    } catch(uploadErr) {
      progressCallback?.('❌ 上传失败: ' + uploadErr.message)
      console.error('Upload failed:', uploadErr)
    }
    
    progressCallback?.('正在同步书籍文件...')
    await syncBookFiles(freshLocalData.books, progressCallback)
    
    progressCallback?.('正在同步翻译...')
    for (const book of freshLocalData.books) {
      try { await syncBookTranslations(book.id) } catch (e) { console.warn('Translation sync failed for', book.id, e.message) }
    }
    
    progressCallback?.('同步完成!')
    return { success: true }
  } catch (e) {
    console.error('Sync error:', e)
    return { success: false, error: e.message }
  }
}

// Get the "latest action" timestamp for a record (used for LWW comparison)
function recordTimestamp(record) {
  return Math.max(record.addedAt || 0, record.deletedAt || 0)
}

function mergeData(local, remote) {
  if (!remote) return local
  
  const merged = { version: 2, exportedAt: Date.now(), books: [], vocabulary: [], highlights: [] }
  
  // --- Books: LWW by lastReadAt ---
  const booksMap = new Map()
  for (const book of (local.books || [])) booksMap.set(book.id, book)
  for (const book of (remote.books || [])) {
    const existing = booksMap.get(book.id)
    if (existing) {
      if ((book.lastReadAt || 0) > (existing.lastReadAt || 0)) {
        console.log(`📚 MERGE: remote wins for "${book.title}": remote readAt=${book.lastReadAt} > local readAt=${existing.lastReadAt}`)
        booksMap.set(book.id, book)
      } else {
        console.log(`📚 MERGE: local wins for "${existing.title}": local readAt=${existing.lastReadAt} >= remote readAt=${book.lastReadAt}`)
      }
    } else {
      booksMap.set(book.id, book)
    }
  }
  merged.books = Array.from(booksMap.values())
  
  // --- Vocabulary: LWW-Element-Set by `word` ---
  // For v1 remote data that has separate tombstone arrays, migrate them
  const remoteVocabTombstones = new Map()
  if (remote.deletedVocab) {
    for (const t of remote.deletedVocab) remoteVocabTombstones.set(t.word, t.deletedAt || 0)
  }
  
  const vocabMap = new Map()
  for (const w of [...(remote.vocabulary || []), ...(local.vocabulary || [])]) {
    const key = w.word
    // Apply v1 tombstones to records that don't have deletedAt yet
    if (remoteVocabTombstones.has(key) && !w.deletedAt) {
      w.deletedAt = remoteVocabTombstones.get(key)
    }
    const existing = vocabMap.get(key)
    if (!existing) {
      vocabMap.set(key, w)
    } else {
      // LWW: keep the one with the latest timestamp
      if (recordTimestamp(w) > recordTimestamp(existing)) {
        vocabMap.set(key, { ...existing, ...w })
      } else {
        // Merge non-conflict fields: take max count, max interval
        vocabMap.set(key, {
          ...w, ...existing,
          count: Math.max(existing.count || 1, w.count || 1),
          interval: Math.max(existing.interval || 0, w.interval || 0),
        })
      }
    }
  }
  merged.vocabulary = Array.from(vocabMap.values())
  
  // --- Highlights: LWW-Element-Set by `bookId:text` ---
  const remoteHlTombstones = new Map()
  if (remote.deletedHighlights) {
    for (const t of remote.deletedHighlights) remoteHlTombstones.set(`${t.bookId}:${t.text}`, t.deletedAt || 0)
  }
  
  const hlMap = new Map()
  for (const hl of [...(remote.highlights || []), ...(local.highlights || [])]) {
    const key = `${hl.bookId}:${hl.text}`
    // Apply v1 tombstones
    if (remoteHlTombstones.has(key) && !hl.deletedAt) {
      hl.deletedAt = remoteHlTombstones.get(key)
    }
    const existing = hlMap.get(key)
    if (!existing) {
      hlMap.set(key, hl)
    } else {
      // LWW: keep the one with the latest timestamp
      if (recordTimestamp(hl) > recordTimestamp(existing)) {
        hlMap.set(key, hl)
      }
      // else keep existing (earlier entry in the loop)
    }
  }
  merged.highlights = Array.from(hlMap.values())
  
  return merged
}

// Apply merged data to local IndexedDB
async function applyMergedData(data) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('epub-reader', 4)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  
  // --- Vocabulary: put all (including soft-deleted) ---
  const vocabTx = db.transaction('vocabulary', 'readwrite')
  const vocabStore = vocabTx.objectStore('vocabulary')
  for (const word of (data.vocabulary || [])) vocabStore.put(word)
  await new Promise((resolve, reject) => { vocabTx.oncomplete = resolve; vocabTx.onerror = () => reject(vocabTx.error) })
  
  // --- Highlights: merge by key (bookId:text), not clear+add ---
  const hlTx = db.transaction('highlights', 'readwrite')
  const hlStore = hlTx.objectStore('highlights')
  
  // Read existing highlights into a map by key
  const existingHl = await new Promise(r => {
    const req = hlStore.getAll()
    req.onsuccess = () => r(req.result)
    req.onerror = () => r([])
  })
  const existingHlMap = new Map()
  for (const hl of existingHl) existingHlMap.set(`${hl.bookId}:${hl.text}`, hl)
  
  // Apply merged highlights
  for (const hl of (data.highlights || [])) {
    const key = `${hl.bookId}:${hl.text}`
    const existing = existingHlMap.get(key)
    if (existing) {
      // Update existing record (preserve its auto-increment id)
      if (recordTimestamp(hl) >= recordTimestamp(existing)) {
        hlStore.put({ ...existing, ...hl, id: existing.id })
      }
    } else {
      // New record — add (auto-increment id)
      const { id, ...rest } = hl
      hlStore.add(rest)
    }
  }
  await new Promise((resolve, reject) => { hlTx.oncomplete = resolve; hlTx.onerror = () => reject(hlTx.error) })
  
  // --- Books: LWW by lastReadAt ---
  // Read all existing books first (avoid await inside transaction — kills tx on Safari/WebKit)
  const booksReadTx = db.transaction('books')
  const existingBooks = await new Promise(r => {
    const req = booksReadTx.objectStore('books').getAll()
    req.onsuccess = () => r(req.result)
    req.onerror = () => r([])
  })
  const existingBooksMap = new Map(existingBooks.map(b => [b.id, b]))
  
  // Now write in a single synchronous pass (no await inside transaction)
  const booksTx = db.transaction('books', 'readwrite')
  const booksStore = booksTx.objectStore('books')
  for (const book of (data.books || [])) {
    const existing = existingBooksMap.get(book.id)
    if (!existing) {
      console.log(`📚 APPLY: adding new book "${book.title}" from remote`)
      booksStore.put(book)
    } else {
      const existingReadAt = existing.lastReadAt || 0
      const mergedReadAt = book.lastReadAt || 0
      
      if (mergedReadAt > existingReadAt) {
        console.log(`📚 APPLY: updating "${existing.title}" progress ${Math.round((existing.progress||0)*100)}% → ${Math.round((book.progress||0)*100)}%`)
        booksStore.put({
          ...existing,
          progress: book.progress,
          lastLocation: book.lastLocation,
          lastReadAt: book.lastReadAt,
          title: book.title,
          author: book.author,
          coverBlob: book.coverBlob || existing.coverBlob,
          paragraphCount: book.paragraphCount || existing.paragraphCount || null,
        })
      } else if (mergedReadAt === existingReadAt) {
        console.log(`📚 APPLY: same readAt for "${existing.title}" — metadata only`)
        booksStore.put({
          ...existing,
          title: book.title || existing.title,
          author: book.author || existing.author,
          paragraphCount: book.paragraphCount || existing.paragraphCount || null,
        })
      } else {
        console.log(`📚 APPLY: SKIP "${existing.title}" — local is newer`)
      }
    }
  }
  await new Promise((resolve, reject) => { booksTx.oncomplete = resolve; booksTx.onerror = () => reject(booksTx.error) })
  
  db.close()
}

// Sync book files
async function syncBookFiles(booksMeta, progressCallback) {
  const localBooks = await getAllBooks()
  const localBooksMap = new Map(localBooks.map(b => [b.id, b]))
  
  let remoteBookIds = []
  try { remoteBookIds = await listBooks() } catch (e) { console.warn('Could not list remote books:', e) }
  
  for (const book of localBooks) {
    if (!remoteBookIds.includes(book.id)) {
      const cachedFile = await getCachedEpub(book.id)
      if (cachedFile) {
        progressCallback?.(`上传书籍: ${book.title}...`)
        try { await uploadBook(book.id, cachedFile) } catch (e) { console.error(`Failed to upload book ${book.id}:`, e) }
      }
    }
  }
  
  progressCallback?.(`远端书籍文件: ${remoteBookIds.length}个`)
  for (const bookId of remoteBookIds) {
    const localBook = localBooksMap.get(bookId)
    const cachedFile = localBook ? await getCachedEpub(bookId) : null
    // Download if book doesn't exist locally OR not in cache
    if (!localBook || !cachedFile) {
      const meta = booksMeta.find(b => b.id === bookId) || { id: bookId, title: bookId, addedAt: Date.now() }
      progressCallback?.(`下载书籍: ${meta.title || bookId}...`)
      try {
        const blob = await downloadBook(bookId)
        if (blob) {
          // Re-read fresh record (applyMergedData may have written metadata)
          const { getBook } = await import('./db.js')
          const fresh = await getBook(bookId)
          const bookToSave = fresh || meta
          await saveBook({ ...bookToSave, file: new File([blob], `${meta.title || bookId}.epub`, { type: 'application/epub+zip' }) })
          progressCallback?.(`✅ 下载完成: ${meta.title || bookId}`)
        }
      } catch (e) {
        progressCallback?.(`❌ 下载失败: ${bookId} - ${e.message}`)
        console.error(`Failed to download book ${bookId}:`, e)
      }
    }
  }
}

// Quick push local → Dropbox (no merge)
export async function pushToDropbox() {
  if (!isDropboxConfigured() || !isLoggedIn()) return { success: false, error: 'Not configured or not logged in' }
  try {
    const localData = await exportLocalData()
    await uploadData(localData)
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
}

// Sync translations for a specific book
export async function syncBookTranslations(bookId) {
  if (!isDropboxConfigured() || !isLoggedIn()) return { success: false, error: 'Not configured or not logged in' }
  try {
    const localTranslations = await getBookTranslations(bookId)
    const localArray = Object.entries(localTranslations).map(([hash, translation]) => ({ hash, translation }))
    let remoteTranslations = null
    try { remoteTranslations = await downloadBookTranslations(bookId) } catch (e) { console.log('No remote translations for', bookId) }
    
    const merged = {}
    if (remoteTranslations && Array.isArray(remoteTranslations)) for (const t of remoteTranslations) merged[t.hash] = t.translation
    for (const t of localArray) merged[t.hash] = t.translation
    
    const mergedArray = Object.entries(merged).map(([hash, translation]) => ({ hash, translation }))
    if (mergedArray.length > 0) {
      await importTranslations(mergedArray.map(t => ({ bookId, hash: t.hash, translation: t.translation, savedAt: Date.now() })))
      await uploadBookTranslations(bookId, mergedArray)
      console.log(`Synced ${mergedArray.length} translations for book ${bookId}`)
    }
    return { success: true, count: mergedArray.length }
  } catch (e) {
    console.error('Failed to sync book translations:', e)
    return { success: false, error: e.message }
  }
}
