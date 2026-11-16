#!/usr/bin/env node
// Přepíná vlastní doménu mezi produkčním projektem Muzia a údržbovou stránkou
// na Vercelu. Bez závislostí: Node 18+ (nativní fetch), vlastní čtení .env.
//
//   node vercel-domain.mjs gui                       okno v prohlížeči
//   node vercel-domain.mjs status
//   node vercel-domain.mjs maintenance [--pause]     (alias: down)
//   node vercel-domain.mjs live                      (alias: up)
//
// Nastavení v .env vedle skriptu (vzor: .env.example).

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// --- .env ---
function loadEnv(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    let value = m[2]
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    // Proměnná z prostředí má přednost před .env.
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

// config.json: the same settings as .env, for filling in by hand.
const JSON_KEYS = {
  vercelToken: 'VERCEL_TOKEN',
  vercelTeamId: 'VERCEL_TEAM_ID',
  customDomain: 'CUSTOM_DOMAIN',
  prodProject: 'PROD_PROJECT',
  maintProject: 'MAINT_PROJECT',
}
const CONFIG_FILE = join(HERE, 'config.json')

function loadJson(path) {
  if (!existsSync(path)) return
  let data
  try {
    data = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  } catch (err) {
    console.error(`✗ config.json není platný JSON: ${err.message}`)
    console.error('  Hlídej uvozovky kolem hodnot a čárky mezi řádky (za posledním žádná).')
    process.exit(2)
  }
  for (const [key, name] of Object.entries(JSON_KEYS)) {
    const value = data?.[key]
    if (typeof value === 'string' && value.trim() && process.env[name] === undefined) process.env[name] = value.trim()
  }
}

// Přednost: proměnné prostředí, pak config.json, pak .env.
loadJson(CONFIG_FILE)
loadEnv(join(HERE, '.env'))

// VERCEL_API_URL jen pro testy proti falešnému serveru.
const API = process.env.VERCEL_API_URL || 'https://api.vercel.com'

const config = {
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID || '',
  domain: (process.env.CUSTOM_DOMAIN || '').trim().toLowerCase(),
  prod: process.env.PROD_PROJECT || 'keyboardhero.muzio',
  maint: process.env.MAINT_PROJECT || 'kh-maintenance',
}

// --- výpis: do terminálu (barevně), nebo do okna (gui) ---
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text))
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) }

const terminal = (kind, text) => {
  const line = {
    step: `${c.cyan('→')} ${text}`,
    ok: `${c.green('✓')} ${text}`,
    warn: `${c.yellow('!')} ${text}`,
    fail: `${c.red('✗')} ${text}`,
    http: c.dim(`    ${text}`),
    title: c.bold(text),
    done: `${c.green('✓')} ${c.bold(text)}`,
  }[kind]
  ;(kind === 'fail' ? console.error : console.log)(line ?? text)
}

// Where messages go right now. The gui runs one action at a time and points
// this at its own collector for the duration.
let emit = terminal
const say = (kind) => (text) => emit(kind, text)
const step = say('step')
const ok = say('ok')
const warn = say('warn')
const fail = say('fail')

// --- Vercel API ---
class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function api(method, path, body) {
  const url = new URL(API + path)
  if (config.teamId) url.searchParams.set('teamId', config.teamId)
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ApiError(0, 'network', `Nepodařilo se spojit s api.vercel.com (${err.cause?.code ?? err.message}).`)
  }
  const text = await response.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  emit('http', `${method} ${path} → HTTP ${response.status}`)
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code ?? '', data.error?.message ?? (text || response.statusText))
  }
  return data
}

const enc = encodeURIComponent

async function getProject(name) {
  return api('GET', `/v9/projects/${enc(name)}`)
}

// The domain's record on the project, or null when it isn't there.
async function domainOn(project) {
  try {
    return await api('GET', `/v9/projects/${enc(project)}/domains/${enc(config.domain)}`)
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

async function removeDomain(project) {
  step(`Odebírám ${config.domain} z projektu ${project}…`)
  if (!(await domainOn(project))) {
    warn(`Na ${project} doména není – není co odebírat, pokračuji.`)
    return
  }
  try {
    await api('DELETE', `/v9/projects/${enc(project)}/domains/${enc(config.domain)}`)
    ok(`Odebráno z ${project}.`)
  } catch (err) {
    if (err.status === 404) warn(`Na ${project} už doména mezitím nebyla, pokračuji.`)
    else throw err
  }
}

async function addDomain(project) {
  step(`Přidávám ${config.domain} k projektu ${project}…`)
  const existing = await domainOn(project)
  if (existing) {
    ok(`Doména už na ${project} je, nic se nemění.`)
    return existing
  }
  // v10 je aktuální verze endpointu pro přidání domény k projektu.
  const added = await api('POST', `/v10/projects/${enc(project)}/domains`, { name: config.domain })
  ok(`Přidáno k ${project}.`)
  return added
}

function isPaused(project) {
  // Vercel vrací u pozastaveného projektu "paused": true (starší odpovědi to pole nemají).
  return project.paused === true
}

async function pause(project) {
  step(`Pozastavuji projekt ${project}…`)
  await api('POST', `/v1/projects/${enc(project)}/pause`, {})
  ok(`${project} je pozastavený.`)
}

async function unpause(project) {
  step(`Obnovuji (odpozastavuji) projekt ${project}…`)
  await api('POST', `/v1/projects/${enc(project)}/unpause`, {})
  ok(`${project} znovu běží.`)
}

function reportVerification(record, project) {
  if (record && record.verified === false) {
    warn(`Vercel doménu na ${project} zatím neověřil. Doplň DNS záznam podle Vercelu:`)
    for (const v of record.verification ?? []) emit('http', `${v.type}  ${v.domain}  ${v.value}`)
  }
}

// --- akce (společné pro terminál i okno) ---

// { where: 'prod' | 'maint' | 'both' | 'none', paused, unverified: [project] }
async function readStatus() {
  const [prodDomain, maintDomain, prodProject] = await Promise.all([
    domainOn(config.prod),
    domainOn(config.maint),
    getProject(config.prod),
  ])
  const where = prodDomain && maintDomain ? 'both' : prodDomain ? 'prod' : maintDomain ? 'maint' : 'none'
  const unverified = [
    [prodDomain, config.prod],
    [maintDomain, config.maint],
  ]
    .filter(([record]) => record?.verified === false)
    .map(([, project]) => project)
  return { where, paused: isPaused(prodProject), unverified }
}

async function maintenance(withPause) {
  emit('title', `Přepínám ${config.domain} na údržbovou stránku`)
  await removeDomain(config.prod)
  reportVerification(await addDomain(config.maint), config.maint)
  if (withPause) {
    if (isPaused(await getProject(config.prod))) ok(`${config.prod} už je pozastavený.`)
    else await pause(config.prod)
  }
  emit('done', `Hotovo: ${config.domain} teď ukazuje údržbovou stránku (${config.maint}).`)
}

async function live() {
  emit('title', `Vracím ${config.domain} na produkci`)
  // Nejdřív projekt rozběhnout, ať doména nemíří na pozastavený web.
  if (isPaused(await getProject(config.prod))) await unpause(config.prod)
  else ok(`${config.prod} je aktivní, není co obnovovat.`)
  await removeDomain(config.maint)
  reportVerification(await addDomain(config.prod), config.prod)
  emit('done', `Hotovo: ${config.domain} zase běží na produkci (${config.prod}).`)
}

// The hints shown after an API error (terminal and gui).
function explain(err) {
  if (!(err instanceof ApiError)) return [['fail', err.stack ?? String(err)]]
  const lines = [
    ['fail', `Vercel API: ${err.message}${err.code ? ` (${err.code})` : ''}${err.status ? `, HTTP ${err.status}` : ''}`],
  ]
  if (err.status === 404 && err.code !== 'not_found_domain') {
    lines.push(['warn', `Projekt nenalezen. Zkontroluj prodProject a maintProject (teď ${config.prod} a ${config.maint}) – musí to být názvy projektů z Vercelu, ne adresa nasazení. U týmu vyplň i vercelTeamId.`])
  } else if (err.status === 401 || err.status === 403) {
    lines.push(['warn', 'Zkontroluj VERCEL_TOKEN a jestli projekty patří týmu z VERCEL_TEAM_ID.'])
  } else if (err.code === 'domain_already_in_use' || err.status === 409) {
    lines.push(['warn', 'Doména je přiřazená jinému projektu, než jsou tyhle dva. Odeber ji tam ve Vercelu ručně.'])
  }
  lines.push(['warn', 'Podívej se na stav a akci zopakuj – je bezpečné ji pustit znovu.'])
  return lines
}

// --- terminál ---
async function printStatus() {
  emit('title', `Stav domény ${config.domain}`)
  const s = await readStatus()
  const where = {
    both: c.yellow(`na obou projektech (${config.prod} i ${config.maint}) – spusť \`live\` nebo \`maintenance\``),
    prod: c.green(`${config.prod} (produkce – Muzio běží)`),
    maint: c.yellow(`${config.maint} (údržbová stránka)`),
    none: c.red('na žádném z obou projektů'),
  }[s.where]
  console.log()
  console.log(`  Doména běží na:   ${where}`)
  console.log(`  ${config.prod}:  ${s.paused ? c.yellow('pozastavený (paused)') : c.green('aktivní')}`)
  for (const project of s.unverified) console.log(`  ${c.yellow('!')} Na ${project} čeká doména na ověření DNS.`)
}

// --- okno v prohlížeči ---
// Běží jen na 127.0.0.1. Každé spuštění má náhodný klíč v adrese; bez něj
// server nic neudělá, takže doménu nepřepne žádná jiná stránka v prohlížeči.
async function gui() {
  const key = randomBytes(24).toString('base64url')
  const page = readFileSync(join(HERE, 'gui.html'), 'utf8')
    .replaceAll('__KEY__', key)
    .replaceAll('__DOMAIN__', config.domain)
    .replaceAll('__PROD__', config.prod)
    .replaceAll('__MAINT__', config.maint)
  let queue = Promise.resolve()

  const keyOk = (given) => {
    const a = Buffer.from(String(given ?? ''))
    const b = Buffer.from(key)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // One action at a time; returns what it wrote, plus the state afterwards.
  const run = (action) => {
    const result = queue.then(async () => {
      const log = []
      emit = (kind, text) => {
        log.push({ kind, text })
        terminal(kind, text)
      }
      let success = true
      try {
        await action()
      } catch (err) {
        success = false
        for (const [kind, text] of explain(err)) emit(kind, text)
      }
      // The state afterwards, for the window - quietly (a plain status check
      // keeps its requests in the log, that's what it was asked for).
      const quiet = log.length > 0
      if (quiet) emit = () => {}
      try {
        return { ok: success, log, status: await readStatus().catch(() => null) }
      } finally {
        emit = terminal
      }
    })
    queue = result.catch(() => {})
    return result
  }

  const server = createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' })
      res.end(body)
    }
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (host !== '127.0.0.1' && host !== 'localhost') return send(403, 'text/plain', 'forbidden')
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/') {
      if (!keyOk(url.searchParams.get('k'))) return send(403, 'text/plain; charset=utf-8', 'Otevři adresu, kterou vypsal skript.')
      return send(200, 'text/html; charset=utf-8', page)
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/') || !keyOk(req.headers['x-key'])) {
      return send(403, 'text/plain', 'forbidden')
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const input = (() => {
      try {
        return JSON.parse(body || '{}')
      } catch {
        return {}
      }
    })()

    const actions = {
      // Read inside the action, so a failure is explained in the log.
      '/api/status': () => readStatus(),
      '/api/down': () => maintenance(input.pause === true),
      '/api/up': () => live(),
    }
    if (url.pathname === '/api/quit') {
      send(200, 'application/json', '{"ok":true}')
      console.log('Okno zavřeno, končím.')
      server.close()
      process.exit(0)
    }
    const action = actions[url.pathname]
    if (!action) return send(404, 'text/plain', 'not found')
    send(200, 'application/json', JSON.stringify(await run(action)))
  })

  const port = Number(process.env.GUI_PORT) || 0
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}/?k=${key}`
  console.log(`${c.green('✓')} Okno běží na ${c.bold(address)}`)
  console.log(c.dim('  Ukončíš ho tlačítkem v okně nebo Ctrl+C.'))
  if (!process.env.NO_OPEN) openBrowser(address)
}

function openBrowser(address) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', address]]
      : process.platform === 'darwin'
        ? ['open', [address]]
        : ['xdg-open', [address]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Adresa je vypsaná výš, dá se otevřít ručně.
  }
}

function usage() {
  console.log(`${c.bold('Použití:')} node vercel-domain.mjs <příkaz>

  ${c.cyan('gui')}                        okno v prohlížeči (stav + tlačítka)
  ${c.cyan('status')}                     kde doména běží a jestli je produkce pozastavená
  ${c.cyan('maintenance')} | ${c.cyan('down')} [--pause]  doména na údržbovou stránku (--pause pozastaví produkci)
  ${c.cyan('live')} | ${c.cyan('up')}                  doména zpět na produkci (pozastavenou obnoví)

Nastavení: ${CONFIG_FILE} (vzor config.example.json), nebo .env`)
}

async function main() {
  const [command, ...flags] = process.argv.slice(2)
  if (!command || ['-h', '--help', 'help'].includes(command)) return usage()

  const missing = [!config.token && 'VERCEL_TOKEN', !config.domain && 'CUSTOM_DOMAIN'].filter(Boolean)
  if (missing.length) {
    fail(`Chybí ${missing.join(' a ')}. Vyplň ${CONFIG_FILE} (vzor config.example.json) nebo .env.`)
    process.exitCode = 2
    return
  }

  switch (command) {
    case 'gui':
      return gui()
    case 'status':
      return printStatus()
    case 'maintenance':
    case 'down':
      return maintenance(flags.includes('--pause'))
    case 'live':
    case 'up':
      return live()
    default:
      fail(`Neznámý příkaz „${command}“.`)
      usage()
      process.exitCode = 2
  }
}

main().catch((err) => {
  console.log()
  for (const [kind, text] of explain(err)) terminal(kind, text)
  process.exitCode = 1
})
