// translate-worker.js - Background translation Web Worker
const TRANSLATE_API = 'https://nixbook.wulujia.workers.dev'
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
const BATCH_SIZE = 10
const FOLIATE_CDN = 'https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@main/'

// Simple hash function
function hashText(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(36)
}

// Batch translate using Claude
async function translateBatch(paragraphs) {
  const numbered = paragraphs.map((p, i) => `[${i + 1}] ${p}`).join('\n\n')
  const prompt = `将以下英文段落翻译成中文。保持段落编号，只输出翻译结果，不要解释。

${numbered}`
  
  const res = await fetch(TRANSLATE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      
      
      
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  })
  
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }
  
  const data = await res.json()
  const content = data.content?.[0]?.text || ''
  
  // Parse numbered translations
  const translations = {}
  const lines = content.split('\n')
  let currentNum = null
  let currentText = []
  
  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.*)/)
    if (match) {
      if (currentNum !== null && currentText.length > 0) {
        translations[currentNum] = currentText.join('\n').trim()
      }
      currentNum = parseInt(match[1])
      currentText = match[2] ? [match[2]] : []
    } else if (currentNum !== null && line.trim()) {
      currentText.push(line)
    }
  }
  if (currentNum !== null && currentText.length > 0) {
    translations[currentNum] = currentText.join('\n').trim()
  }
  
  return translations
}

// Handle messages from main thread
self.onmessage = async (e) => {
  const { type, bookId, fileData, existingHashes } = e.data
  
  if (type !== 'translate') return
  
  try {
    self.postMessage({ type: 'progress', bookId, status: 'parsing', message: '解析书籍...' })
    
    // Import EPUB parser
    const { EPUB } = await import(FOLIATE_CDN + 'epub.js')
    
    // Create blob from array buffer
    const blob = new Blob([fileData], { type: 'application/epub+zip' })
    const book = await new EPUB(blob).init()
    
    // Get all sections
    const sections = book.sections || []
    self.postMessage({ type: 'progress', bookId, status: 'extracting', message: '提取文本...' })
    
    // Collect paragraphs
    const allParagraphs = []
    const existingSet = new Set(existingHashes || [])
    
    for (let i = 0; i < sections.length; i++) {
      try {
        const doc = await sections[i].createDocument()
        if (!doc) continue
        
        doc.querySelectorAll('p').forEach(p => {
          const text = p.textContent?.trim()
          if (text && text.length >= 10 && !/[\u4e00-\u9fff]/.test(text)) {
            const hash = hashText(text)
            if (!existingSet.has(hash)) {
              allParagraphs.push({ text, hash })
            }
          }
        })
      } catch (err) {
        console.warn(`Section ${i} failed:`, err)
      }
    }
    
    if (allParagraphs.length === 0) {
      self.postMessage({ type: 'done', bookId, translated: 0 })
      return
    }
    
    // Translate in batches
    const translations = []
    
    for (let i = 0; i < allParagraphs.length; i += BATCH_SIZE) {
      const batch = allParagraphs.slice(i, i + BATCH_SIZE)
      const texts = batch.map(p => p.text)
      
      try {
        const results = await translateBatch(texts)
        
        for (let j = 0; j < batch.length; j++) {
          const translation = results[j + 1]
          if (translation) {
            translations.push({
              bookId,
              hash: batch[j].hash,
              original: batch[j].text,
              translation,
              savedAt: Date.now()
            })
          }
        }
        
        const percent = Math.round((i + batch.length) / allParagraphs.length * 100)
        self.postMessage({ 
          type: 'progress', 
          bookId, 
          status: 'translating',
          message: `翻译中 ${percent}%`,
          progress: percent,
          // Send completed translations so main thread can save them
          newTranslations: translations.slice(-batch.length)
        })
        
        // Rate limit
        await new Promise(r => setTimeout(r, 300))
        
      } catch (err) {
        console.error('Batch error:', err)
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    
    self.postMessage({ type: 'done', bookId, translated: translations.length })
    
  } catch (err) {
    self.postMessage({ type: 'error', bookId, error: err.message })
  }
}
