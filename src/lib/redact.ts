const SECRET_ENV = /(TOKEN|KEY|SECRET)$/;

/** Strips anything that looks like a credential from a string before it's logged or stored. */
export function redact(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_ENV.test(name)) out = out.split(value).join(`[${name}]`);
  }
  return out
    .replace(/xox[abprs]-[A-Za-z0-9-]+/g, "[slack-token]")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[google-token]")
    .replace(/(lin_api|grn|secret|mb)_[A-Za-z0-9_]{8,}/g, "[api-key]");
}
