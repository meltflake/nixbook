// Dropbox Sync Module
// API Key 配置
const DROPBOX_APP_KEY = 'c48i0tkl0702fno'

const DROPBOX_DATA_PATH = '/epub-reader-data.json'
const TOKEN_KEY = 'dropbox-access-token'
const REFRESH_TOKEN_KEY = 'dropbox-refresh-token'
const TOKEN_EXPIRES_KEY = 'dropbox-token-expires'
const SYNC_STATUS_KEY = 'dropbox-sync-status'

// Check if Dropbox is configured
export function isDropboxConfigured() {
  return DROPBOX_APP_KEY && DROPBOX_APP_KEY.length > 0
}

// Get stored access token
export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY)
}

// Get stored refresh token
function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

// Get token expiry time
function getTokenExpiry() {
  const expires = localStorage.getItem(TOKEN_EXPIRES_KEY)
  return expires ? parseInt(expires, 10) : 0
}

// Store tokens
function setTokens(accessToken, refreshToken, expiresIn) {
  localStorage.setItem(TOKEN_KEY, accessToken)
  if (refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
  }
  // Store expiry time with 5 minute buffer
  const expiresAt = Date.now() + (expiresIn - 300) * 1000
  localStorage.setItem(TOKEN_EXPIRES_KEY, expiresAt.toString())
}

// Clear all tokens (logout)
export function clearAccessToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRES_KEY)
  localStorage.removeItem(SYNC_STATUS_KEY)
}

// Check if token is expired or about to expire
function isTokenExpired() {
  const expiresAt = getTokenExpiry()
  return Date.now() >= expiresAt
}

// Refresh the access token using refresh token
async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    throw new Error('No refresh token available')
  }

  console.log('Refreshing access token...')
  
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: DROPBOX_APP_KEY,
    }),
  })

  const data = await response.json()

  if (data.access_token) {
    // Note: refresh_token is not returned on refresh, keep the old one
    setTokens(data.access_token, null, data.expires_in || 14400)
    console.log('Access token refreshed successfully')
    return data.access_token
  } else {
    console.error('Token refresh failed:', data)
    throw new Error('Token refresh failed')
  }
}

// Get valid access token (refresh if needed)
async function getValidAccessToken() {
  const token = getAccessToken()
  if (!token) {
    throw new Error('Not logged in')
  }

  if (isTokenExpired()) {
    try {
      return await refreshAccessToken()
    } catch (e) {
      // Refresh failed, clear tokens and require re-login
      console.error('Token refresh failed, clearing tokens:', e)
      clearAccessToken()
      throw new Error('Session expired, please login again')
    }
  }

  return token
}

// Check if logged in
export function isLoggedIn() {
  return !!getAccessToken()
}

// Generate PKCE code verifier
function generateCodeVerifier() {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// Generate PKCE code challenge
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// Start OAuth flow
export async function startAuth() {
  if (!isDropboxConfigured()) {
    alert('Dropbox App Key 未配置')
    return
  }

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  
  // Store verifier for later (localStorage survives redirects better than sessionStorage on iOS)
  localStorage.setItem('dropbox-code-verifier', codeVerifier)
  
  const redirectUri = window.location.origin + window.location.pathname
  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize')
  authUrl.searchParams.set('client_id', DROPBOX_APP_KEY)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('token_access_type', 'offline')
  
  window.location.href = authUrl.toString()
}

// Handle OAuth callback
export async function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  
  if (!code) return false
  
  const codeVerifier = localStorage.getItem('dropbox-code-verifier')
  if (!codeVerifier) {
    console.error('No code verifier found')
    return false
  }
  
  const redirectUri = window.location.origin + window.location.pathname
  
  try {
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: DROPBOX_APP_KEY,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    })
    
    const data = await response.json()
    
    if (data.access_token) {
      // Store both access_token and refresh_token!
      setTokens(data.access_token, data.refresh_token, data.expires_in || 14400)
      localStorage.removeItem('dropbox-code-verifier')
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname)
      console.log('Dropbox login successful, tokens stored')
      return true
    } else {
      console.error('Token exchange failed:', data)
      return false
    }
  } catch (e) {
    console.error('Auth callback error:', e)
    return false
  }
}

// Upload data to Dropbox
export async function uploadData(data) {
  const token = await getValidAccessToken()
  
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: DROPBOX_DATA_PATH,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body: JSON.stringify(data, null, 2),
  })
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Upload failed: ${error}`)
  }
  
  localStorage.setItem(SYNC_STATUS_KEY, JSON.stringify({
    lastSync: Date.now(),
    status: 'success'
  }))
  
  return true
}

// Download data from Dropbox
export async function downloadData() {
  const token = await getValidAccessToken()
  
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_DATA_PATH }),
    },
  })
  
  if (response.status === 409) {
    // File not found - return empty data
    return null
  }
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Download failed: ${error}`)
  }
  
  const data = await response.json()
  
  localStorage.setItem(SYNC_STATUS_KEY, JSON.stringify({
    lastSync: Date.now(),
    status: 'success'
  }))
  
  return data
}

// Get sync status
export function getSyncStatus() {
  const status = localStorage.getItem(SYNC_STATUS_KEY)
  return status ? JSON.parse(status) : null
}

// Upload a book file to Dropbox
export async function uploadBook(bookId, file) {
  const token = await getValidAccessToken()
  
  const path = `/books/${bookId}.epub`
  
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body: file,
  })
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Book upload failed: ${error}`)
  }
  
  return true
}

// Download a book file from Dropbox
export async function downloadBook(bookId) {
  const token = await getValidAccessToken()
  
  const path = `/books/${bookId}.epub`
  
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  })
  
  if (response.status === 409) {
    return null // File not found
  }
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Book download failed: ${error}`)
  }
  
  return await response.blob()
}

// List books in Dropbox
export async function listBooks() {
  const token = await getValidAccessToken()
  
  const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: '/books' }),
  })
  
  if (response.status === 409) {
    return [] // Folder not found
  }
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`List books failed: ${error}`)
  }
  
  const data = await response.json()
  return data.entries
    .filter(e => e.name.endsWith('.epub'))
    .map(e => e.name.replace('.epub', ''))
}

// Upload translations for a specific book
export async function uploadBookTranslations(bookId, translations) {
  const token = await getValidAccessToken()
  
  const path = `/translations/${bookId}.json`
  const content = JSON.stringify(translations, null, 2)
  
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body: content,
  })
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Translations upload failed: ${error}`)
  }
  
  return true
}

// Download translations for a specific book
export async function downloadBookTranslations(bookId) {
  const token = await getValidAccessToken()
  
  const path = `/translations/${bookId}.json`
  
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  })
  
  if (response.status === 409) {
    return null // File not found
  }
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Translations download failed: ${error}`)
  }
  
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    console.error('Failed to parse translations JSON:', e)
    return null
  }
}
