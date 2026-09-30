// Read the persisted metadata already fetched by Flow's UI, without issuing generation RPCs.
export function extractRenderedModels(text) {
  const found = new Map();
  const associate = (id, model) => found.set(id, found.has(id) && found.get(id) !== model ? null : model);
  function scan(value) {
    const ids = new Set(); const models = new Set();
    if (!Array.isArray(value)) return { ids, models };
    if (value.length === 2 && ['media_id', 'model_display_name'].includes(value[0]) && Array.isArray(value[1])) {
      const scalar = value[1][2];
      if (value[0] === 'media_id' && typeof scalar === 'string' && /^[a-f0-9-]{36}$/u.test(scalar)) ids.add(scalar);
      if (value[0] === 'model_display_name' && typeof scalar === 'string') {
        const name = scalar.replace(/^🍌\s*/u, '').trim(); if (name && name.length <= 200) models.add(name);
      }
      return { ids, models };
    }
    for (const child of value) {
      const result = scan(child); for (const id of result.ids) ids.add(id); for (const model of result.models) models.add(model);
    }
    return { ids, models };
  }
  // batchexecute has an XSSI prefix and length-prefixed JSON lines. Only decode
  // the RPC response envelope; prompt strings and tool argument strings stay opaque.
  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const rows = JSON.parse(line);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        // GN0Bre is the observed persisted chat-history response. Its body[1]
        // contains independent messages: never join orphan fields across them.
        if (!Array.isArray(row) || row[0] !== 'wrb.fr' || row[1] !== 'GN0Bre' || typeof row[2] !== 'string') continue;
        const body = JSON.parse(row[2]);
        if (!Array.isArray(body) || !Array.isArray(body[1])) continue;
        for (const record of body[1]) {
          if (!Array.isArray(record) || record.length !== 2 || !record.every(Array.isArray)) continue;
          const { ids, models } = scan(record);
          if (ids.size === 1 && models.size === 1) associate([...ids][0], [...models][0]);
        }
      }
    } catch { /* Ignore unrelated or partial streaming chunks. */ }
  }
  return found;
}
