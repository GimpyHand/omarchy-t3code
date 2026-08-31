.pragma library

function safeMarkdown(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]/g, "[image: $1]")
    .replace(/</g, "&lt;")
}

function isAllowedExternalUrl(value) {
  return /^(https?:\/\/|mailto:)/i.test(String(value || "").trim())
}
