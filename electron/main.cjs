const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron')
const path = require('node:path')
const nodeFs = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const https = require('node:https')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { normalizeBaseUrl, splitText, requestCompletion, csvCell } = require('./converter.cjs')

const dataDir = () => path.join(app.getPath('userData'), 'local-ai-studio')
const pythonEnv = () => path.join(dataDir(), 'python-env')
const settingsFile = () => path.join(dataDir(), 'settings.json')
async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')) } catch { return {} }
}
async function writeSettings(value) {
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(value, null, 2), { mode: 0o600 })
}
function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Local-AI-Studio/0.1', ...headers } }, res => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          if ((res.statusCode || 500) >= 400) reject(new Error(parsed.error || parsed.message || `HTTP ${res.statusCode}`))
          else resolve(parsed)
        } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}
function createWindow() {
  const win = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 700, backgroundColor: '#f5f6f8', title: 'Local AI Studio', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  if (!app.isPackaged) win.loadURL('http://127.0.0.1:5173')
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
}
app.whenReady().then(() => {
  ipcMain.handle('settings:get', async () => { const s = await readSettings(); return { token: s.token || '', downloadDir: s.downloadDir || path.join(os.homedir(), 'AI-Models'), converter: { baseUrl: s.converter?.baseUrl || 'https://api.openai.com/v1', model: s.converter?.model || '', hasApiKey: Boolean(s.converter?.apiKeyEncrypted) }, ragReady: await fs.stat(path.join(dataDir(), 'rag-ready')).then(() => true).catch(() => false), trainingReady: await fs.stat(path.join(dataDir(), 'training-ready')).then(() => true).catch(() => false), convertReady: await fs.stat(path.join(dataDir(), 'convert-ready')).then(() => true).catch(() => false) } })
  ipcMain.handle('settings:save', async (_e, patch) => { const current = await readSettings(); await writeSettings({ ...current, ...patch }); return true })
  ipcMain.handle('converter:save-settings', async (_e, { baseUrl, model, apiKey }) => {
    if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error('API model adı gerekli.')
    const current = await readSettings()
    const converter = { ...current.converter, baseUrl: normalizeBaseUrl(baseUrl), model: model.trim() }
    if (apiKey !== undefined && apiKey !== '') {
      if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 4096) throw new Error('API anahtarı en az 8 karakter olmalı.')
      if (!safeStorage.isEncryptionAvailable()) throw new Error('İşletim sistemi güvenli parola deposu kullanılamıyor; API anahtarı kaydedilmedi.')
      converter.apiKeyEncrypted = safeStorage.encryptString(apiKey.trim()).toString('base64')
    }
    current.converter = converter
    await writeSettings(current)
    return { baseUrl: converter.baseUrl, model: converter.model, hasApiKey: Boolean(converter.apiKeyEncrypted) }
  })
  ipcMain.handle('dialog:open-converter', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Belgeler', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'txt', 'md', 'csv', 'rtf'] }] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('converter:convert', async (event, { filePath, apiKey, shareWithProvider, outputMode = 'training' }) => {
    if (shareWithProvider !== true) throw new Error('Dosyanın API sağlayıcısına gönderilmesini onaylamalısınız.')
    const settings = await readSettings()
    let effectiveApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (effectiveApiKey && (effectiveApiKey.length < 8 || effectiveApiKey.length > 4096)) throw new Error('Geçerli API anahtarını girin.')
    if (!effectiveApiKey && settings.converter?.apiKeyEncrypted) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Kaydedilmiş API anahtarı işletim sistemi parola deposundan açılamadı.')
      try { effectiveApiKey = safeStorage.decryptString(Buffer.from(settings.converter.apiKeyEncrypted, 'base64')) }
      catch { throw new Error('Kaydedilmiş API anahtarı açılamadı. Lütfen anahtarı yeniden girip kaydedin.') }
    }
    if (!effectiveApiKey) throw new Error('API anahtarını girin ve ayarları kaydedin.')
    const baseUrl = normalizeBaseUrl(settings.converter?.baseUrl)
    const model = settings.converter?.model
    if (!model) throw new Error('API adresi ve modelini Ayarlar bölümünde kaydedin.')
    const inputPath = path.resolve(String(filePath || ''))
    const stat = await fs.stat(inputPath)
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Dosya 25 MB sınırını aşmamalı.')
    if (!['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.txt', '.md', '.csv', '.rtf'].includes(path.extname(inputPath).toLowerCase())) throw new Error('Desteklenmeyen dosya biçimi.')
    const python = path.join(pythonEnv(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const workerFile = app.isPackaged ? path.join(process.resourcesPath, 'python/worker/worker.py') : path.join(__dirname, '../python/worker/worker.py')
    const child = spawn(python, [workerFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    child.stdin.end(JSON.stringify({ type: 'extract_training', dataFile: inputPath }) + '\n')
    const text = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 4 * 1024 * 1024) child.kill() })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-20000) })
      child.on('error', reject)
      child.on('close', code => {
        let result
        for (const line of stdout.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.event === 'result' || value.event === 'error') result = value } catch {} }
        if (code !== 0 || result?.event === 'error') reject(new Error(result?.message || stderr || 'Dosyadan metin çıkarılamadı.'))
        else resolve(result?.text)
      })
    })
    const chunks = splitText(text)
    const id = randomUUID(), jobsDir = path.join(dataDir(), 'jobs')
    await fs.mkdir(jobsDir, { recursive: true })
    const recordPath = path.join(jobsDir, id + '.json')
    const record = { id, type: 'convert', outputMode, sourceFile: path.basename(inputPath), model, createdAt: new Date().toISOString(), status: 'running', chunks: chunks.length }
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2))
    const rows = []
    try {
      for (let i = 0; i < chunks.length; i++) {
        event.sender.send('converter:progress', { current: i + 1, total: chunks.length, message: 'Belge işleniyor · ' + (i + 1) + '/' + chunks.length })
        let waitedSeconds = 0
        const waitTimer = setInterval(() => {
          waitedSeconds += 15
          if (!event.sender.isDestroyed()) event.sender.send('converter:progress', { current: i + 1, total: chunks.length, message: `Model yanıtı bekleniyor · parça ${i + 1}/${chunks.length} · ${waitedSeconds} sn` })
        }, 15000)
        let generated
        try { generated = await requestCompletion(baseUrl, effectiveApiKey, model, chunks[i]) }
        finally { clearInterval(waitTimer) }
        for (const row of generated) {
          const instruction = String(row?.instruction || '').trim(), input = String(row?.input || '').trim(), output = String(row?.output || '').trim()
          if (outputMode === 'rag') {
            const text = [input, output].filter(Boolean).join('\\n\\n') || instruction
            if (text && rows.length < 4000) rows.push({ text, metadata: 'belge', source: path.basename(inputPath) })
          } else if (instruction && output && rows.length < 4000) rows.push({ instruction, input, output })
        }
      }
      if (!rows.length) throw new Error('Model kullanılabilir eğitim satırı üretmedi.')
      await fs.writeFile(recordPath, JSON.stringify({ ...record, status: 'completed', rowCount: rows.length, finishedAt: new Date().toISOString() }, null, 2))
      return { jobId: id, rows, chunks: chunks.length, outputMode }
    } catch (error) {
      await fs.writeFile(recordPath, JSON.stringify({ ...record, status: 'failed', error: String(error.message || error), finishedAt: new Date().toISOString() }, null, 2))
      throw error
    }
  })
  ipcMain.handle('converter:save-csv', async (_event, { rows, outputMode = 'training' }) => {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4000) throw new Error('CSV için 1–4.000 satır gerekli.')
    const result = await dialog.showSaveDialog({ defaultPath: 'egitim-verisi.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (result.canceled || !result.filePath) return null
    const headers = outputMode === 'rag' ? ['text', 'metadata', 'source'] : ['instruction', 'input', 'output']
    const lines = [headers, ...rows.map(row => outputMode === 'rag' ? [row.text, row.metadata, row.source] : [row.instruction, row.input, row.output])]
    await fs.writeFile(result.filePath, '\uFEFF' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8')
    return result.filePath
  })
  ipcMain.handle('models:list-local', async () => {
    const settings = await readSettings()
    const root = path.resolve(settings.downloadDir || path.join(os.homedir(), 'AI-Models'))
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const result = []
    for (const entry of entries.filter(item => item.isDirectory())) {
      const folder = path.join(root, entry.name)
      const files = await fs.readdir(folder).catch(() => [])
      if (files.some(name => name === 'config.json' || /\.(safetensors|bin|gguf)$/.test(name))) result.push({ id: entry.name.replace('--', '/'), path: folder })
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  })
  ipcMain.handle('jobs:list', async () => {
    const dir = path.join(dataDir(), 'jobs')
    const names = await fs.readdir(dir).catch(() => [])
    const jobs = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try { return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) } catch { return null }
    }))
    const recovered = []
    for (const job of jobs.filter(Boolean)) {
      if (job.status === 'running') { job.status = 'interrupted'; job.error = 'Uygulama kapanırken iş tamamlanmadı.'; await fs.writeFile(path.join(dir, `${job.id}.json`), JSON.stringify(job, null, 2)) }
      recovered.push(job)
    }
    return recovered.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  })
  ipcMain.handle('worker:setup', async (event, { gpu = true, purpose = gpu ? 'training' : 'rag' } = {}) => {
    const envDir = pythonEnv(); const exe = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    await fs.mkdir(dataDir(), { recursive: true })
    const run = (command, args) => new Promise((resolve, reject) => { const child = spawn(command,args,{windowsHide:true}); let output=''; child.stdout.on('data',x=>output+=x); child.stderr.on('data',x=>output+=x); child.on('error',reject); child.on('close',code=>code===0?resolve(output):reject(new Error(output||`Python setup exit ${code}`))) })
    if (!(await fs.stat(exe).then(()=>true).catch(()=>false))) await run(process.platform==='win32'?'python':'python3',['-m','venv',envDir])
    const pythonRoot = app.isPackaged ? path.join(process.resourcesPath, 'python') : path.join(__dirname, '../python')
    const requirementsFile = purpose === 'convert' ? 'requirements-convert.txt' : (gpu ? 'requirements-training.txt' : 'requirements-rag.txt')
    const requirements = path.join(pythonRoot, requirementsFile)
    event.sender.send('worker:setup-progress',{message:'Python bağımlılıkları kuruluyor…'})
    const readyMarker = path.join(dataDir(), `${purpose}-ready`)
    if (!(await fs.stat(readyMarker).then(()=>true).catch(()=>false))) {
      await run(exe,['-m','pip','install','--upgrade','pip'])
      const trainingReady = await fs.stat(path.join(dataDir(), 'training-ready')).then(()=>true).catch(()=>false)
      if (purpose === 'convert') {
        event.sender.send('worker:setup-progress',{message:'Belge okuma paketleri kuruluyor…'})
      } else if (gpu) {
        if (process.platform !== 'win32' && process.platform !== 'linux') throw new Error('QLoRA kurulumu bu işletim sisteminde desteklenmiyor.')
        event.sender.send('worker:setup-progress',{message:'CUDA destekli PyTorch kuruluyor…'})
        const torchIndex = process.platform === 'win32' ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cu128'
        await run(exe,['-m','pip','install','--upgrade','torch','--index-url',torchIndex])
      } else if (!trainingReady) {
        event.sender.send('worker:setup-progress',{message:'CPU uyumlu PyTorch kuruluyor…'})
        await run(exe,['-m','pip','install','torch','--index-url','https://download.pytorch.org/whl/cpu'])
      }
      await run(exe,['-m','pip','install','-r',requirements])
      await fs.writeFile(readyMarker, new Date().toISOString())
    }
    return {ready:true,python:exe,gpu,purpose}
  })
  ipcMain.handle('hf:validate', async (_e, token) => {
    if (!token) throw new Error('Önce Hugging Face token girin.')
    return requestJson('https://huggingface.co/api/whoami-v2', { Authorization: `Bearer ${token}` })
  })
  ipcMain.handle('hf:search', async (_e, { query, token }) => {
    const url = new URL('https://huggingface.co/api/models')
    url.searchParams.set('search', query || ''); url.searchParams.set('limit', '12'); url.searchParams.set('sort', 'downloads'); url.searchParams.set('direction', '-1')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    return requestJson(url, headers)
  })
  ipcMain.handle('hf:download', async (event, { repo, token, directory }) => {
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Geçerli bir model deposu seçin (kullanıcı/model).')
    const root = path.resolve(directory || path.join(os.homedir(), 'AI-Models'))
    const target = path.join(root, repo.replace('/', '--'))
    await fs.mkdir(target, { recursive: true })
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const files = await requestJson(`https://huggingface.co/api/models/${repo}?blobs=true`, headers)
    const siblings = files.siblings || []
    const names = siblings.map(x => x.rfilename).filter(name => !name.startsWith('.') && !name.split('/').includes('..'))
    if (!names.length) throw new Error('İndirilebilir model dosyası bulunamadı.')
    // Safetensors/sharded repositories can be large; download the actual model artifacts and configuration only.
    const wanted = names.filter(n => /(^|\/)(config\.json|generation_config\.json|tokenizer.*|special_tokens_map\.json|added_tokens\.json|vocab.*|merges\.txt|.*\.(safetensors|bin|gguf))$/.test(n) || /\.safetensors\.index\.json$/.test(n))
    if (!wanted.length) throw new Error('Bu depoda desteklenen model ağırlığı bulunamadı.')
    for (let i = 0; i < wanted.length; i++) {
      const name = wanted[i], out = path.join(target, name), part = `${out}.part`
      await fs.mkdir(path.dirname(out), { recursive: true })
      const sibling = siblings.find(x => x.rfilename === name)
      const expectedSize = sibling?.size ?? sibling?.lfs?.size
      if (expectedSize && await fs.stat(out).then(st => st.size === expectedSize).catch(() => false)) { event.sender.send('hf:download-progress', { current: i + 1, total: wanted.length, file: name, skipped: true }); continue }
      const url = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(files.sha || 'main')}/${name.split('/').map(encodeURIComponent).join('/')}?download=true`
      await fs.rm(part, { force: true })
      try {
        await new Promise((resolve, reject) => {
          const fail = error => reject(error)
          const writeResponse = response => {
            if ((response.statusCode || 500) >= 400) { response.resume(); return fail(new Error(`İndirme hatası: ${name} (${response.statusCode})`)) }
            const output = nodeFs.createWriteStream(part, { flags: 'wx' })
            response.on('error', fail); output.on('error', fail)
            output.on('finish', () => output.close(error => error ? fail(error) : resolve()))
            response.pipe(output)
          }
          const request = https.get(url, { headers }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
              const redirected = new URL(response.headers.location, url)
              if (redirected.protocol !== 'https:' || !['huggingface.co','cdn-lfs.huggingface.co','cdn-lfs-us-1.huggingface.co','cas-bridge.xethub.hf.co','us.aws.cdn.hf.co'].includes(redirected.hostname)) { response.resume(); return fail(new Error('Güvenilmeyen indirme yönlendirmesi engellendi.')) }
              response.resume()
              https.get(redirected, { headers: { 'User-Agent': 'Local-AI-Studio/0.1' } }, writeResponse).on('error', fail)
              return
            }
            writeResponse(response)
          })
          request.on('error', fail)
          request.setTimeout(120000, () => request.destroy(new Error(`İndirme zaman aşımına uğradı: ${name}`)))
        })
        const actualSize = (await fs.stat(part)).size
        if (!actualSize || (expectedSize && actualSize !== expectedSize)) throw new Error(expectedSize ? `İndirme boyutu uyuşmuyor: ${name} (${actualSize}/${expectedSize})` : `İndirilen dosya boş: ${name}`)
        await fs.rename(part, out)
      } catch (error) {
        await fs.rm(part, { force: true })
        throw error
      }
      event.sender.send('hf:download-progress', { current: i + 1, total: wanted.length, file: name })
    }
    return { path: target, files: wanted.length }
  })
  ipcMain.handle('dialog:open-data', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Veri dosyaları', extensions: ['csv', 'xlsx'] }] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:open-data-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:save-template', async (_e, extension) => {
    const filters = extension === 'xlsx' ? [{ name: 'Excel', extensions: ['xlsx'] }] : [{ name: 'CSV', extensions: ['csv'] }]
    return dialog.showSaveDialog({ defaultPath: `egitim-sablonu.${extension}`, filters })
  })
  ipcMain.handle('dialog:download-dir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('data:read', async (_e, file) => {
    const stat = await fs.stat(file)
    if (stat.size > 100 * 1024 * 1024) throw new Error('Dosya sınırı 100 MB.')
    const ext = path.extname(file).toLowerCase()
    if (ext === '.csv') return { kind: 'csv', text: await fs.readFile(file, 'utf8') }
    if (['.xlsx', '.xlsm'].includes(ext)) return { kind: 'xlsx', data: (await fs.readFile(file)).toString('base64') }
    throw new Error('Yalnızca CSV veya XLSX destekleniyor.')
  })
  ipcMain.handle('template:write', async (_e, { filePath, extension, csv, data }) => {
    if (extension === 'csv') await fs.writeFile(filePath, csv, 'utf8')
    else await fs.writeFile(filePath, Buffer.from(data, 'base64'))
    return filePath
  })
  ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p))
  ipcMain.handle('worker:run', async (event, job) => {
    if (!['rag', 'rag_query', 'training'].includes(job?.type)) throw new Error('Bilinmeyen iş türü.')
    if (job.type === 'rag_query' && !job.indexDir) throw new Error('RAG bilgi tabanı seçilmedi.')
    const id = randomUUID()
    const jobsDir = path.join(dataDir(), 'jobs')
    const outputDir = path.join(dataDir(), job.type === 'rag' ? 'knowledge-bases' : job.type === 'rag_query' ? 'knowledge-bases' : 'training-output', job.type === 'rag_query' ? path.basename(job.indexDir || '') : id)
    await fs.mkdir(jobsDir, { recursive: true })
    const recordFile = path.join(jobsDir, `${id}.json`)
    const record = { ...job, id, outputDir, createdAt: new Date().toISOString(), status: 'running' }
    await fs.writeFile(recordFile, JSON.stringify(record, null, 2))
    const python = path.join(pythonEnv(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const workerFile = app.isPackaged ? path.join(process.resourcesPath, 'python/worker/worker.py') : path.join(__dirname, '../python/worker/worker.py')
    const settings = await readSettings()
    const selectedModel = job.type === 'rag_query' ? job.answerModel : job.model
    const modelDir = selectedModel ? path.join(settings.downloadDir || path.join(os.homedir(), 'AI-Models'), String(selectedModel).replace('/', '--')) : ''
    const modelPath = modelDir ? await fs.stat(modelDir).then(st => st.isDirectory() ? modelDir : null).catch(() => null) : null
    const child = spawn(python, [workerFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', lastResult = null
    child.stdout.on('data', chunk => { stdout += chunk.toString(); const lines = stdout.split('\n'); stdout = lines.pop() || ''; for (const line of lines) { try { const payload = JSON.parse(line); if (payload.event === 'result' || payload.event === 'error') lastResult = payload; event.sender.send('worker:event', { jobId: id, ...payload }) } catch {} } })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.stdin.end(JSON.stringify({ ...job, id, outputDir, modelPath }) + '\n')
    return await new Promise((resolve, reject) => {
      child.on('error', async error => { await fs.writeFile(recordFile, JSON.stringify({ ...record, status: 'failed', error: error.message }, null, 2)); event.sender.send('worker:event', { jobId: id, event: 'error', message: error.message }); reject(error) })
      child.on('close', async code => {
        let result = lastResult
        if (stdout.trim()) { try { result = JSON.parse(stdout.trim()); if (result.event === 'result' || result.event === 'error') lastResult = result; event.sender.send('worker:event', { jobId: id, ...result }) } catch {} }
        const status = code === 0 ? 'completed' : 'failed'
        await fs.writeFile(recordFile, JSON.stringify({ ...record, status, finishedAt: new Date().toISOString(), result, error: code ? (result?.message || stderr || `Worker exit ${code}`) : undefined }, null, 2))
        if (code === 0) resolve({ jobId: id, status, outputDir, result })
        else reject(new Error(result?.message || stderr || `Worker ${code} koduyla sonlandı`))
      })
    })
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
