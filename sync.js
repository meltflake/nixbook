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
  
  // Include tombstones so deletions propagate across devices
  let deletedHighlights = []
  let deletedVocab = []
  try { deletedHighlights = JSON.parse(localStorage.getItem('highlight-tombstones') || '[]') } catch {}
  try { deletedVocab = JSON.parse(localStorage.getItem('vocab-tombstones') || '[]') } catch {}

  return {
    version: 1,
    exportedAt: Date.now(),
    books: booksMetadata,
    vocabulary,
    highlights,
    deletedHighlights,
    deletedVocab,
  }
}

// Full sync with Dropbox
export async function syncWithDropbox(progressCallback) {
  if (!isDropboxConfigured() || !isLoggedIn()) {
    return { success: false, error: 'Not configured or not logged in' }
  }
  
  try {
    progressCallback?.('正在下载云端数据...')
    const remoteData = await downloadData()
    
    progressCallback?.('正在读取本地数据...')
    const localData = await exportLocalData()
    
    // Log pre-merge state for every book
    for (const lb of (localData.books || [])) {
      const rb = (remoteData?.books || []).find(b => b.id === lb.id)
      console.log(`📚 SYNC [${lb.title}]: local progress=${Math.round((lb.progress||0)*100)}% readAt=${lb.lastReadAt}, remote progress=${rb ? Math.round((rb.progress||0)*100)+'%' : 'N/A'} readAt=${rb?.lastReadAt || 'N/A'}`)
    }
    // Also log remote-only books
    for (const rb of (remoteData?.books || [])) {
      if (!(localData.books || []).find(b => b.id === rb.id)) {
        console.log(`📚 SYNC [${rb.title}]: remote-only progress=${Math.round((rb.progress||0)*100)}% readAt=${rb.lastReadAt}`)
      }
    }
    
    progressCallback?.('正在合并数据...')
    const mergedData = mergeData(localData, remoteData)
    
    progressCallback?.('正在更新本地数据库...')
    await applyMergedData(mergedData)
    
    // Re-read fresh local data AFTER apply
    const freshLocalData = await exportLocalData()
    
    progressCallback?.('正在上传到云端...')
    await uploadData(freshLocalData)
    
    // Clean up old tombstones (keep last 30 days for multi-device propagation)
    try {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      for (const key of ['highlight-tombstones', 'vocab-tombstones']) {
        const ts = JSON.parse(localStorage.getItem(key) || '[]')
        localStorage.setItem(key, JSON.stringify(ts.filter(t => (t.deletedAt || 0) > cutoff)))
      }
    } catch {}
    
    progressCallback?.('正在同步书籍文件...')
    await syncBookFiles(freshLocalData.books, progressCallback)
    
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
// Merge tombstone arrays from two sources, deduplicate by key
function mergeTombstones(remote = [], local = [], keyType) {
  const map = new Map()
  for (const t of [...remote, ...local]) {
    let key
    if (keyType === 'word') key = t.word
    else key = `${t.bookId}:${t.text}`
    // Keep the one with the latest deletedAt
    const existing = map.get(key)
    if (!existing || (t.deletedAt || 0) > (existing.deletedAt || 0)) {
      map.set(key, t)
    }
  }
  return Array.from(map.values())
}

function mergeData(local, remote) {
  if (!remote) return local
  
  const merged = {
    version: 1,
    exportedAt: Date.now(),
    books: [],
    vocabulary: [],
    highlights: [],
  }
  
  const booksMap = new Map()
  for (const book of (local.books || [])) {
    booksMap.set(book.id, book)
  }
  for (const book of (remote.books || [])) {
    const existing = booksMap.get(book.id)
    if (existing) {
      if ((book.lastReadAt || 0) > (existing.lastReadAt || 0)) {
        console.log(`📚 MERGE: remote wins for "${book.title}": remote readAt=${book.lastReadAt} > local readAt=${existing.lastReadAt}, progress ${Math.round((existing.progress||0)*100)}% → ${Math.round((book.progress||0)*100)}%`)
        booksMap.set(book.id, book)
      } else {
        console.log(`📚 MERGE: local wins for "${existing.title}": local readAt=${existing.lastReadAt} >= remote readAt=${book.lastReadAt}, keeping progress=${Math.round((existing.progress||0)*100)}%`)
      }
    } else {
      booksMap.set(book.id, book)
    }
  }
  merged.books = Array.from(booksMap.values())
  
  // Merge deletion tombstones from both sides (union, deduplicated)
  const allDeletedHighlights = mergeTombstones(remote.deletedHighlights, local.deletedHighlights, 'bookId:text')
  const allDeletedVocab = mergeTombstones(remote.deletedVocab, local.deletedVocab, 'word')
  merged.deletedHighlights = allDeletedHighlights
  merged.deletedVocab = allDeletedVocab
  
  // Persist merged tombstones to localStorage so this device knows about remote deletes too
  try { localStorage.setItem('highlight-tombstones', JSON.stringify(allDeletedHighlights)) } catch {}
  try { localStorage.setItem('vocab-tombstones', JSON.stringify(allDeletedVocab)) } catch {}
  
  // Merge vocabulary (by word) — respect tombstones
  const vocabTombstoneKeys = new Set(allDeletedVocab.map(t => t.word))
  
  const vocabMap = new Map()
  for (const word of (remote.vocabulary || [])) {
    if (!vocabTombstoneKeys.has(word.word)) vocabMap.set(word.word, word)
  }
  for (const word of (local.vocabulary || [])) {
    if (vocabTombstoneKeys.has(word.word)) continue
    const existing = vocabMap.get(word.word)
    if (existing) {
      vocabMap.set(word.word, { ...existing, ...word, count: Math.max(existing.count || 1, word.count || 1), interval: Math.max(existing.interval || 0, word.interval || 0) })
    } else {
      vocabMap.set(word.word, word)
    }
  }
  merged.vocabulary = Array.from(vocabMap.values())
  
  // Merge highlights — respect tombstones from both devices
  const hlTombstoneKeys = new Set(allDeletedHighlights.map(t => `${t.bookId}:${t.text}`))
  
  const highlightSet = new Set()
  const highlights = []
  for (const hl of [...(remote.highlights || []), ...(local.highlights || [])]) {
    const key = `${hl.bookId}:${hl.text}`
    if (hlTombstoneKeys.has(key)) continue  // Skip deleted highlights
    if (!highlightSet.has(key)) { highlightSet.add(key); highlights.push(hl) }
  }
  merged.highlights = highlights
  
  return merged
}

// Apply merged data to local IndexedDB — NEVER overwrites newer local data
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
  for (const word of (data.vocabulary || [])) vocabStore.put(word)
  await new Promise((resolve, reject) => { vocabTx.oncomplete = resolve; vocabTx.onerror = () => reject(vocabTx.error) })
  
  // Update highlights
  const hlTx = db.transaction('highlights', 'readwrite')
  const hlStore = hlTx.objectStore('highlights')
  hlStore.clear()
  for (const hl of (data.highlights || [])) { const { id, ...rest } = hl; hlStore.add(rest) }
  await new Promise((resolve, reject) => { hlTx.oncomplete = resolve; hlTx.onerror = () => reject(hlTx.error) })
  
  // Update books — ONLY if merged is strictly newer
  const booksTx = db.transaction('books', 'readwrite')
  const booksStore = booksTx.objectStore('books')
  for (const book of (data.books || [])) {
    const existing = await new Promise(r => {
      const req = booksStore.get(book.id)
      req.onsuccess = () => r(req.result)
      req.onerror = () => r(null)
    })
    if (existing) {
      const existingReadAt = existing.lastReadAt || 0
      const mergedReadAt = book.lastReadAt || 0
      
      if (mergedReadAt > existingReadAt) {
        // Merged is strictly newer — update progress
        console.log(`📚 APPLY: updating "${existing.title}" progress ${Math.round((existing.progress||0)*100)}% → ${Math.round((book.progress||0)*100)}% (merged readAt ${mergedReadAt} > existing ${existingReadAt})`)
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
        // Same timestamp — only update non-progress fields (title, author, paragraphCount)
        console.log(`📚 APPLY: same readAt for "${existing.title}" — updating metadata only, keeping progress=${Math.round((existing.progress||0)*100)}%`)
        booksStore.put({
          ...existing,
          title: book.title || existing.title,
          author: book.author || existing.author,
          paragraphCount: book.paragraphCount || existing.paragraphCount || null,
        })
      } else {
        // Local is newer — don't touch
        console.log(`📚 APPLY: SKIP "${existing.title}" — local is newer (existing readAt ${existingReadAt} > merged ${mergedReadAt}), keeping progress=${Math.round((existing.progress||0)*100)}%`)
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
    if (book.file && !remoteBookIds.includes(book.id)) {
      progressCallback?.(`上传书籍: ${book.title}...`)
      try { await uploadBook(book.id, book.file) } catch (e) { console.error(`Failed to upload book ${book.id}:`, e) }
    }
  }
  
  for (const bookId of remoteBookIds) {
    if (!localBooksMap.has(bookId)) {
      const meta = booksMeta.find(b => b.id === bookId)
      if (meta) {
        progressCallback?.(`下载书籍: ${meta.title || bookId}...`)
        try {
          const blob = await downloadBook(bookId)
          if (blob) await saveBook({ ...meta, file: new File([blob], `${meta.title || bookId}.epub`, { type: 'application/epub+zip' }) })
        } catch (e) { console.error(`Failed to download book ${bookId}:`, e) }
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
  } catch (e) {
    return { success: false, error: e.message }
  }
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
