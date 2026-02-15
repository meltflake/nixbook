// translate.js - Full book translation module
import { saveTranslation, getBookTranslations, hashText } from './db.js'

const TRANSLATE_API = 'https://nixbook.wulujia.workers.dev'
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
const BATCH_SIZE = 10

// Track active translations
const activeTranslations = new Map() // bookId -> { progress, total, cancel }

export function getTranslationProgress(bookId) {
  return activeTranslations.get(bookId) || null
}

export function cancelTranslation(bookId) {
  const state = activeTranslations.get(bookId)
  if (state) {
    state.cancel = true
  }
}

// Batch translate paragraphs using Claude Sonnet
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
    const err = await res.text()
    throw new Error(`API error: ${res.status} - ${err}`)
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

// Extract text content from an HTML document string
function extractParagraphs(htmlContent) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(htmlContent, 'text/html')
  const paragraphs = []
  
  doc.querySelectorAll('p').forEach(p => {
    const text = p.textContent?.trim()
    // Only English paragraphs, at least 10 chars
    if (text && text.length >= 10 && !/[\u4e00-\u9fff]/.test(text)) {
      paragraphs.push(text)
    }
  })
  
  return paragraphs
}

// Translate entire book
export async function translateBook(bookFile, bookId, onProgress) {
  // Check if already translating
  if (activeTranslations.has(bookId)) {
    console.log('Translation already in progress for', bookId)
    return { success: false, error: 'Already translating' }
  }
  
  // Get existing translations to skip
  const existingTranslations = await getBookTranslations(bookId)
  const existingHashes = new Set(Object.keys(existingTranslations))
  
  const state = { progress: 0, total: 0, cancel: false, status: 'loading' }
  activeTranslations.set(bookId, state)
  
  try {
    // Load foliate-js
    const FOLIATE_CDN = 'https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@main/'
    const { EPUB } = await import(FOLIATE_CDN + 'epub.js')
    
    // Open the book
    state.status = 'parsing'
    onProgress?.({ status: 'parsing', message: '解析书籍...' })
    
    const book = await new EPUB(bookFile).init()
    
    // Get all spine items (sections)
    const spine = book.sections || []
    console.log(`Book has ${spine.length} sections`)
    
    // Collect all paragraphs from all sections
    state.status = 'extracting'
    onProgress?.({ status: 'extracting', message: '提取文本...' })
    
    const allParagraphs = []
    
    for (let i = 0; i < spine.length; i++) {
      if (state.cancel) break
      
      const section = spine[i]
      try {
        // Load section content
        const doc = await section.createDocument()
        if (!doc) continue
        
        // Extract paragraphs
        doc.querySelectorAll('p').forEach(p => {
          const text = p.textContent?.trim()
          if (text && text.length >= 10 && !/[\u4e00-\u9fff]/.test(text)) {
            const hash = hashText(text)
            // Skip if already translated
            if (!existingHashes.has(hash)) {
              allParagraphs.push({ text, hash })
            }
          }
        })
      } catch (e) {
        console.warn(`Failed to load section ${i}:`, e)
      }
    }
    
    console.log(`Found ${allParagraphs.length} paragraphs to translate (${existingHashes.size} already done)`)
    
    if (allParagraphs.length === 0) {
      state.status = 'done'
      activeTranslations.delete(bookId)
      onProgress?.({ status: 'done', message: '翻译完成', progress: 100 })
      return { success: true, translated: 0, total: existingHashes.size }
    }
    
    state.total = allParagraphs.length
    state.status = 'translating'
    
    // Translate in batches
    let translated = 0
    
    for (let i = 0; i < allParagraphs.length; i += BATCH_SIZE) {
      if (state.cancel) {
        console.log('Translation cancelled')
        break
      }
      
      const batch = allParagraphs.slice(i, i + BATCH_SIZE)
      const texts = batch.map(p => p.text)
      
      try {
        const results = await translateBatch(texts)
        
        // Save translations
        for (let j = 0; j < batch.length; j++) {
          const translation = results[j + 1]
          if (translation) {
            await saveTranslation(bookId, batch[j].text, translation)
            translated++
          }
        }
        
        state.progress = translated
        const percent = Math.round((i + batch.length) / allParagraphs.length * 100)
        onProgress?.({ 
          status: 'translating', 
          message: `翻译中 ${percent}%`,
          progress: percent,
          translated,
          total: allParagraphs.length
        })
        
        // Small delay between batches to avoid rate limits
        await new Promise(r => setTimeout(r, 300))
        
      } catch (e) {
        console.error('Translation batch error:', e)
        // Continue with next batch on error
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    
    state.status = 'done'
    activeTranslations.delete(bookId)
    onProgress?.({ status: 'done', message: '翻译完成', progress: 100 })
    
    return { success: true, translated, total: allParagraphs.length + existingHashes.size }
    
  } catch (e) {
    console.error('Translation failed:', e)
    activeTranslations.delete(bookId)
    onProgress?.({ status: 'error', message: e.message })
    return { success: false, error: e.message }
  }
}

// Check if book needs translation (quick check)
export async function needsTranslation(bookFile) {
  try {
    const FOLIATE_CDN = 'https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@main/'
    const { EPUB } = await import(FOLIATE_CDN + 'epub.js')
    
    const book = await new EPUB(bookFile).init()
    const sections = book.sections || []
    
    // Check first section for English content
    if (sections.length > 0) {
      const doc = await sections[0].createDocument()
      if (doc) {
        const text = doc.body?.textContent || ''
        // If mostly English, needs translation
        const englishChars = (text.match(/[a-zA-Z]/g) || []).length
        const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
        return englishChars > chineseChars * 2
      }
    }
    return false
  } catch (e) {
    console.error('needsTranslation check failed:', e)
    return false
  }
}
