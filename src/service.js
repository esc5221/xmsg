// Keep xmsgd resident. Claude answers a peer only while the process that sent
// the frame is alive (it checks the peer pid), so a daemon that comes and goes
// loses replies; a supervised daemon keeps the same pid for as long as it can.
import { homedir, platform, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { paths } from './config.js'

const LABEL = 'dev.xmsg.xmsgd'
const BIN = fileURLToPath(new URL('../bin/xmsg', import.meta.url))
// launchd and systemd start with a bare PATH; ttym and friends live here.
const PATH = [dirname(process.execPath), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':')

function plistPath() { return join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`) }
function unitPath() { return join(homedir(), '.config/systemd/user/xmsgd.service') }

export function install() {
  const log = paths().log
  if (platform() === 'darwin') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${BIN}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`
    mkdirSync(dirname(plistPath()), { recursive: true })
    const domain = `gui/${userInfo().uid}`
    try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }) } catch {}
    writeFileSync(plistPath(), xml)
    execFileSync('launchctl', ['bootstrap', domain, plistPath()])
    return `installed ${plistPath()}`
  }
  if (platform() === 'linux') {
    const unit = `[Unit]\nDescription=xmsg daemon\n\n[Service]\nExecStart=${process.execPath} ${BIN} daemon\nEnvironment=PATH=${PATH}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`
    mkdirSync(dirname(unitPath()), { recursive: true })
    writeFileSync(unitPath(), unit)
    execFileSync('systemctl', ['--user', 'daemon-reload'])
    execFileSync('systemctl', ['--user', 'enable', '--now', 'xmsgd.service'])
    return `installed ${unitPath()}`
  }
  throw new Error(`no service support for ${platform()}; run "xmsg daemon" under your own supervisor`)
}

export function uninstall() {
  if (platform() === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`], { stdio: 'ignore' }) } catch {}
    if (existsSync(plistPath())) unlinkSync(plistPath())
    return 'removed launchd service'
  }
  if (platform() === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'xmsgd.service'], { stdio: 'ignore' }) } catch {}
    if (existsSync(unitPath())) unlinkSync(unitPath())
    return 'removed systemd user service'
  }
  return 'nothing to remove'
}

export function installed() {
  return platform() === 'darwin' ? existsSync(plistPath()) : platform() === 'linux' ? existsSync(unitPath()) : false
}
