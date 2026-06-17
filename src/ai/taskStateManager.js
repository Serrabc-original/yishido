export function normalizeV2ListReference(value) {
  const clean = value && typeof value === "object" ? value : {};
  const items = normalizeListItems(clean.items || clean.list_items || []);
  if (!items.length) return null;
  const name = normalizeListName(clean.name || clean.listName || clean.list_name || clean.title || "compras");
  return {
    name: name,
    title: String(clean.title || "lista " + name).trim(),
    items: items,
    createdAt: String(clean.createdAt || clean.created_at || new Date().toISOString()),
    source: String(clean.source || "intent_router_v2")
  };
}

export function getLatestListFromCoreUtilityState(coreUtilityState) {
  const clean = coreUtilityState && typeof coreUtilityState === "object" ? coreUtilityState : {};
  const direct = normalizeV2ListReference(clean.lastEphemeralList || clean.last_ephemeral_list || null);
  if (direct) return direct;

  const activeListName = String(clean.activeList || clean.active_list || "").trim();
  const lists = clean.listsState && clean.listsState.lists || clean.lists || {};
  const names = Object.keys(lists || {});
  const key = activeListName && lists[activeListName] ? activeListName : names[names.length - 1];
  const list = key ? lists[key] : null;
  const items = normalizeListItems(list && list.items || []);
  if (!items.length) return null;

  const name = normalizeListName(list.name || activeListName || key || "compras");
  return {
    name: name,
    title: "lista " + name,
    items: items,
    createdAt: String(list.updatedAt || list.createdAt || new Date().toISOString()),
    source: "core_utility_state"
  };
}

export function storeLastEphemeralList(coreUtilityState, listReference) {
  const next = Object.assign({}, coreUtilityState || {});
  const list = normalizeV2ListReference(listReference);
  if (!list) return next;
  next.lastEphemeralList = list;
  return next;
}

export function normalizeListItems(items) {
  return (Array.isArray(items) ? items : [items])
    .map(function (item) {
      if (item && typeof item === "object") return item.text || item.name || item.title || "";
      return item;
    })
    .map(function (item) {
      return String(item || "").replace(/[.,;:]+$/g, "").trim();
    })
    .filter(Boolean);
}

function normalizeListName(value) {
  const clean = String(value || "compras")
    .replace(/^lista\s+(de\s+)?/i, "")
    .replace(/[.,;:]+$/g, "")
    .trim();
  return clean || "compras";
}
