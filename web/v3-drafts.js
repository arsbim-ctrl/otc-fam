function key(domain) {
  return `otc.fam/v3/drafts/${domain.chainId}/${domain.verifyingContract}`;
}

export function savedDrafts(domain) {
  try {
    const list = JSON.parse(localStorage.getItem(key(domain)) ?? "[]");
    if (Array.isArray(list)) return list.filter((item) => /^0x[\da-f]{64}$/.test(item?.id) && typeof item?.payload === "string");
  } catch {}
  return [];
}

export function saveDraft(domain, draft) {
  try {
    const existing = savedDrafts(domain).filter((item) => item.id !== draft.id);
    localStorage.setItem(key(domain), JSON.stringify([draft, ...existing]));
    return true;
  } catch {
    return false;
  }
}
