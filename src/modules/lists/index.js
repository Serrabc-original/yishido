import { logEvent } from "../../logger.js";

export const LISTS_MODULE = {
  name: "lists",
  enabledBy: "ENABLE_LISTS",
  status: "base"
};

export function parseListCommand(text) {
  const raw = stripInputPrefixes(String(text || "").trim());
  const normalized = normalizeText(raw);
  let action = "unknown";

  if (normalized.startsWith("crea una lista") || normalized.startsWith("crear lista")) action = "create";
  else if (/\b(hazme|hacer|prepara|preparame|creame)\b.*\blista\b/.test(normalized)) action = "add";
  else if (normalized.startsWith("agrega") || normalized.startsWith("anota")) action = "add";
  else if (normalized.startsWith("quita") || normalized.startsWith("elimina")) action = "remove";
  else if (normalized.startsWith("marca como hecho") || normalized.startsWith("marcar como hecho")) action = "mark_done";
  else if (normalized.startsWith("muestrame") || normalized.startsWith("mostrar")) action = "list";

  const listName = extractListName(raw, normalized, action);
  const items = extractItems(raw, normalized, action, listName);
  const parsed = {
    action: action,
    listName: listName || "pendientes",
    items: items,
    confidence: action === "unknown" ? 0.2 : listName || items.length ? 0.78 : 0.55,
    missingFields: []
  };

  if (["add", "remove", "mark_done"].includes(action) && !items.length) parsed.missingFields.push("items");
  if (!parsed.listName) parsed.missingFields.push("listName");

  logEvent("LIST_COMMAND_PARSED", parsed);
  return parsed;
}

export function createMemoryListStore(initial) {
  let state = normalizeListState(initial);

  return {
    async createList(name) {
      state = createList(state, name);
      return getList(state, name);
    },
    async addListItems(name, items) {
      state = addListItems(state, name, items);
      return getList(state, name);
    },
    async removeListItems(name, items) {
      state = removeListItems(state, name, items);
      return getList(state, name);
    },
    async markListItemDone(name, itemText) {
      state = markListItemDone(state, name, itemText);
      return getList(state, name);
    },
    async listItems(name) {
      return listItems(state, name);
    },
    snapshot() {
      return normalizeListState(state);
    }
  };
}

export function normalizeListState(state) {
  const clean = state && typeof state === "object" ? state : {};
  const lists = clean.lists && typeof clean.lists === "object" ? clean.lists : {};
  const out = { lists: {} };

  for (const [name, list] of Object.entries(lists)) {
    out.lists[normalizeListName(name)] = {
      name: list.name || name,
      items: (Array.isArray(list.items) ? list.items : []).map(function (item) {
        return {
          id: String(item.id || "item_" + Math.random().toString(36).slice(2, 8)),
          text: String(item.text || ""),
          done: Boolean(item.done),
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || new Date().toISOString()
        };
      })
    };
  }

  return out;
}

export function createList(state, name) {
  const next = normalizeListState(state);
  const key = normalizeListName(name || "pendientes");

  if (!next.lists[key]) {
    next.lists[key] = {
      name: String(name || "pendientes").trim(),
      items: []
    };
  }

  logEvent("LIST_CREATED", { listName: next.lists[key].name });
  return next;
}

export function addListItems(state, name, items) {
  let next = createList(state, name);
  const key = normalizeListName(name || "pendientes");
  const existing = new Set(next.lists[key].items.map(function (item) {
    return normalizeText(item.text);
  }));
  const normalizedItems = normalizeItems(items);

  for (const item of normalizedItems) {
    if (existing.has(normalizeText(item))) continue;
    next.lists[key].items.push({
      id: "item_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      text: item,
      done: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  logEvent("LIST_ITEMS_ADDED", {
    listName: next.lists[key].name,
    count: normalizedItems.length
  });
  return next;
}

export function removeListItems(state, name, items) {
  const next = normalizeListState(state);
  const key = normalizeListName(name || "pendientes");
  if (!next.lists[key]) return next;

  const removals = new Set(normalizeItems(items).map(normalizeText));
  next.lists[key].items = next.lists[key].items.filter(function (item) {
    return !removals.has(normalizeText(item.text));
  });

  logEvent("LIST_ITEMS_REMOVED", {
    listName: next.lists[key].name,
    count: removals.size
  });
  return next;
}

export function markListItemDone(state, name, itemText) {
  const next = normalizeListState(state);
  const key = normalizeListName(name || "pendientes");
  if (!next.lists[key]) return next;

  const target = normalizeText(Array.isArray(itemText) ? itemText[0] : itemText);
  next.lists[key].items = next.lists[key].items.map(function (item) {
    if (normalizeText(item.text) !== target) return item;
    return Object.assign({}, item, {
      done: true,
      updatedAt: new Date().toISOString()
    });
  });

  logEvent("LIST_ITEM_MARKED_DONE", {
    listName: next.lists[key].name,
    item: target
  });
  return next;
}

export function listItems(state, name) {
  const clean = normalizeListState(state);
  const key = normalizeListName(name || "pendientes");
  const list = clean.lists[key] || { name: name || "pendientes", items: [] };

  logEvent("LIST_ITEMS_LISTED", {
    listName: list.name,
    count: list.items.length
  });

  return list;
}

function getList(state, name) {
  return listItems(state, name);
}

function extractListName(raw, normalized, action) {
  const lowerRaw = String(raw || "");
  const match = lowerRaw.match(/\b(?:lista|listado)\s+(?:de\s+|del\s+|llamada\s+)?([^.,;:]+?)(?:\s+con\b|$)/i);

  if (action === "create") {
    return lowerRaw.replace(/^\s*(crea una lista llamada|crea una lista|crear lista)\s*/i, "").trim();
  }

  if (match) {
    return match[1].replace(/^mi\s+/i, "").trim();
  }

  if (normalized.includes("super") || normalized.includes("supermercado")) return "super";
  if (normalized.includes("compras")) return "compras";
  if (normalized.includes("inventario")) return "inventario";
  if (normalized.includes("pendientes")) return "pendientes";
  return "";
}

function extractItems(raw, normalized, action, listName) {
  if (action === "list" || action === "create" || action === "unknown") return [];

  const afterCon = String(raw || "").match(/\bcon\s+(.+)$/i);
  let clean = afterCon && /\blista\b/i.test(raw)
    ? afterCon[1]
    : String(raw || "")
      .replace(/^\s*(anota|agrega|quita|elimina|marca como hecho|marcar como hecho)\s*/i, "")
      .replace(/^\s*(hazme|hacer|prepara|preparame|creame)\s+(una\s+)?lista\s+(de\s+|del\s+)?[^,.;:]+?\s+con\s+/i, "")
      .replace(/\s+(en|a|de)\s+(mi\s+)?lista\s+.*$/i, "")
      .trim();

  if (listName) {
    clean = clean.replace(new RegExp("\\b" + escapeRegExp(listName) + "\\b", "i"), "").trim();
  }

  return normalizeItems(clean.split(/\s*,\s*|\s+y\s+/));
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [items])
    .map(function (item) {
      return String(item || "").replace(/[.。]+$/g, "").trim();
    })
    .filter(Boolean);
}

function stripInputPrefixes(text) {
  return String(text || "")
    .replace(/^\s*\[Audio transcrito\]:\s*/i, "")
    .replace(/^\s*\[Texto adicional\]:\s*/i, "")
    .trim();
}

function normalizeListName(name) {
  return normalizeText(name || "pendientes").replace(/[^a-z0-9_-]/g, "_") || "pendientes";
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
