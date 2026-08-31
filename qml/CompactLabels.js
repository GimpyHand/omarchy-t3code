.pragma library

function modelName(modelLabel, providerLabel) {
  var model = String(modelLabel || "").trim()
  var provider = String(providerLabel || "").trim()
  if (!model || !provider || model.toLowerCase().indexOf(provider.toLowerCase()) !== 0) return model

  var remainder = model.substring(provider.length)
  if (!remainder || !/^[\s.:/\-·]/.test(remainder)) return model
  return remainder.replace(/^[\s.:/\-·]+/, "").trim() || model
}
