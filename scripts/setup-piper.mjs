/**
 * Fetch the local speech engine: the Piper binary and the German voices.
 *
 * Everything lands in tools/piper (git-ignored, ~250MB), which is where
 * bridge/speech.mjs looks. Run once after cloning:
 *
 *   npm run setup:piper
 *
 * Windows only for the binary download today — on macOS or Linux, install
 * piper yourself and point JARVIS_PIPER_DIR at it; the voices download the
 * same way everywhere.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, '..', 'tools', 'piper')
const VOICES = join(DIR, 'voices')

const PIPER_RELEASE =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip'
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten'
/** high is the better voice; medium is the quicker one on a slow CPU. */
const VOICE_FILES = [
  ['high', 'de_DE-thorsten-high'],
  ['medium', 'de_DE-thorsten-medium'],
]

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

async function main() {
  mkdirSync(VOICES, { recursive: true })

  const exe = join(DIR, process.platform === 'win32' ? 'piper.exe' : 'piper')
  if (existsSync(exe)) {
    console.log(`  have   ${exe}`)
  } else if (process.platform === 'win32') {
    const zip = join(DIR, 'piper.zip')
    await download(PIPER_RELEASE, zip)
    const extract = join(DIR, 'extract')
    rmSync(extract, { recursive: true, force: true })
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zip}' -DestinationPath '${extract}' -Force`,
    ])
    // The zip holds one folder; lift its contents up beside the voices.
    const inner = join(extract, 'piper')
    for (const name of readdirSync(inner)) renameSync(join(inner, name), join(DIR, name))
    rmSync(extract, { recursive: true, force: true })
    rmSync(zip, { force: true })
    console.log(`  ready  ${exe}`)
  } else {
    console.log(
      `  piper binary: install it for ${process.platform} from https://github.com/rhasspy/piper/releases` +
        ` and set JARVIS_PIPER_DIR, or copy it into ${DIR}`,
    )
  }

  for (const [quality, name] of VOICE_FILES) {
    await download(`${VOICE_BASE}/${quality}/${name}.onnx`, join(VOICES, `${name}.onnx`))
    await download(`${VOICE_BASE}/${quality}/${name}.onnx.json`, join(VOICES, `${name}.onnx.json`))
  }
  console.log('\nDone. Start JARVIS; the bridge banner should say "speech via local neural voice".')
}

main().catch((err) => {
  console.error(`setup-piper failed: ${err?.message ?? err}`)
  process.exit(1)
})
