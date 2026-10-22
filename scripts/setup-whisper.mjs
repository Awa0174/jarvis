/**
 * Fetch the local speech recogniser: whisper.cpp and a German-capable model.
 *
 * Everything lands in tools/whisper (git-ignored, ~1.3GB with the CUDA
 * build), which is where bridge/stt.mjs looks. Run once after cloning:
 *
 *   npm run setup:whisper            # CUDA 12 build (NVIDIA GPU)
 *   npm run setup:whisper -- --cpu   # CPU-only build, much smaller and slower
 *
 * Windows x64 only for the binaries; on another platform install whisper.cpp
 * yourself and point JARVIS_WHISPER_DIR at a folder holding whisper-server
 * and models/<model>.bin.
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, '..', 'tools', 'whisper')
const MODELS = join(DIR, 'models')

const RELEASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454'
const BUILD = process.argv.includes('--cpu') ? 'whisper-bin-x64.zip' : 'whisper-bin-win-cuda-12.4.0-x64.zip'
const MODEL = process.env.JARVIS_WHISPER_MODEL ?? 'ggml-large-v3-turbo-q5_0.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`

async function download(url, to) {
  if (existsSync(to) && statSync(to).size > 0) {
    console.log(`  have   ${to}`)
    return
  }
  console.log(`  fetch  ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${res.status} for ${url}`)
  const tmp = `${to}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  renameSync(tmp, to)
}

/** Find the folder inside the extracted zip that holds whisper-server.exe. */
function findServerDir(root) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name === 'whisper-server.exe') return dir
      if (e.isDirectory()) stack.push(join(dir, e.name))
    }
  }
  return null
}

async function main() {
  mkdirSync(MODELS, { recursive: true })

  const exe = join(DIR, 'whisper-server.exe')
  if (existsSync(exe)) {
    console.log(`  have   ${exe}`)
  } else if (process.platform === 'win32') {
    const zip = join(DIR, BUILD)
    await download(`${RELEASE}/${BUILD}`, zip)
    const extract = join(DIR, 'extract')
    rmSync(extract, { recursive: true, force: true })
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zip}' -DestinationPath '${extract}' -Force`,
    ])
    const inner = findServerDir(extract)
    if (!inner) throw new Error('whisper-server.exe not found in the archive')
    for (const name of readdirSync(inner)) renameSync(join(inner, name), join(DIR, name))
    rmSync(extract, { recursive: true, force: true })
    rmSync(zip, { force: true })
    console.log(`  ready  ${exe}`)
  } else {
    console.log(`  whisper binary: build or install whisper.cpp for ${process.platform} and set JARVIS_WHISPER_DIR`)
  }

  await download(MODEL_URL, join(MODELS, MODEL))
  console.log('\nDone. Start JARVIS; the bridge banner should say "hearing via local whisper".')
}

main().catch((err) => {
  console.error(`setup-whisper failed: ${err?.message ?? err}`)
  process.exit(1)
})
