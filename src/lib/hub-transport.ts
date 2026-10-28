export function isPrivateLanHostname(hostname: string): boolean {
  const parts = hostname.replace(/^::ffff:/i, "").split(".");
  if (parts.length !== 4 || !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

/** Plain HTTP is supported on explicit RFC1918 IPv4 destinations, never public hosts. */
export function isPrivateLanHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    return isPrivateLanHostname(url.hostname);
  } catch { return false; }
}

/** No DNS guesses: hostnames require TLS; private LAN HTTP is deliberately unencrypted. */
export function isHubTransportPermitted(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
      || isPrivateLanHttpOrigin(origin));
  } catch { return false; }
}

/** Retain the existing loopback-admin restriction; explicitly addressed private LANs are allowed. */
export function isHubAdminTransportPermitted(origin: string): boolean {
  try { return new URL(origin).protocol === "https:" || isPrivateLanHttpOrigin(origin); }
  catch { return false; }
}
