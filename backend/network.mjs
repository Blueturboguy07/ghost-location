import {networkInterfaces} from 'node:os';
import {run} from './process.mjs';

// Only identify the active Wi-Fi interface; SSIDs and network passwords are not read.
export async function wifiStatus({platform = process.platform, runner = run, interfaces = networkInterfaces} = {}) {
  let names = [];
  if (platform === 'darwin') {
    const result = await runner('/usr/sbin/networksetup', ['-listallhardwareports'], {timeoutMs: 5000});
    if (result.code !== 0) return {wifi: false};
    names = [...result.stdout.matchAll(/Hardware Port: (?:Wi-Fi|AirPort)\r?\nDevice: ([^\r\n]+)/g)].map(m => m[1].trim());
  } else if (platform === 'win32') {
    const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.NdisPhysicalMedium -in 1,9 } | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"], {timeoutMs: 5000});
    if (result.code !== 0 || !result.stdout.trim()) return {wifi: false};
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    names = Array.isArray(parsed) ? parsed : [parsed];
  }
  const addresses = interfaces();
  return {wifi: names.some(name => addresses[name]?.some(ip => !ip.internal && !/^(?:169\.254\.|fe80:|127\.|::1$)/i.test(ip.address)))};
}
